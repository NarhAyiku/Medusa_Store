import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import { createHmac, timingSafeEqual } from "node:crypto"
import { PaystackApiError, PaystackClient } from "./client"
import type {
  PaystackOptions,
  PaystackSessionData,
  PaystackTransaction,
  PaystackWebhookEvent,
} from "./types"

/**
 * Paystack payment provider (GHS).
 *
 * Ported from the Django implementation in apps/store/payments.py:
 * - amounts are sent in minor units (pesewas) = major x 100
 * - the Medusa payment session id drives the Paystack reference and is the
 *   idempotency key (Django used the order id; Medusa has no order until the
 *   cart completes, and the webhook must find the session)
 * - webhook signatures (HMAC-SHA512 of the raw body with the secret key) are
 *   compared in constant time
 *
 * Paystack charges at authorization time, so a successful transaction maps
 * straight to Medusa's "captured" status; capturePayment is a no-op.
 *
 * Webhook URL to register in the Paystack dashboard:
 *   POST <medusa host>/hooks/payment/pp_paystack_paystack
 */

type InjectedDependencies = { logger: Logger }

const DEFAULT_CURRENCIES = ["GHS"]

export class PaystackProviderService extends AbstractPaymentProvider<PaystackOptions> {
  static identifier = "paystack"

  protected readonly logger_: Logger
  protected readonly options_: PaystackOptions
  protected readonly client_: PaystackClient
  protected readonly supportedCurrencies_: Set<string>

  static validateOptions(options: Record<string, unknown>): void {
    if (typeof options.secretKey !== "string" || !options.secretKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Paystack provider requires the `secretKey` option (PAYSTACK_SECRET_KEY)"
      )
    }
  }

  constructor(container: InjectedDependencies, options: PaystackOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options
    this.client_ = new PaystackClient({
      secretKey: options.secretKey,
      apiBaseUrl: options.apiBaseUrl,
      fetch: options.fetch,
    })
    this.supportedCurrencies_ = new Set(
      (options.supportedCurrencies ?? DEFAULT_CURRENCIES).map((c) => c.toUpperCase())
    )
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const existing = input.data as Partial<PaystackSessionData> | undefined
    const sessionId = existing?.session_id
    if (!sessionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Paystack provider needs the payment session id in data.session_id"
      )
    }

    const currency = normalizeCurrency(input.currency_code, this.supportedCurrencies_)
    const amountMinor = toMinorUnits(input.amount)

    // Re-initialising an unpaid session with the same amount reuses the
    // existing Paystack transaction instead of creating a duplicate.
    if (
      existing?.reference &&
      existing.authorization_url &&
      existing.amount_minor === amountMinor &&
      existing.currency === currency
    ) {
      return {
        id: existing.reference,
        status: PaymentSessionStatus.PENDING,
        data: existing as PaystackSessionData,
      }
    }

    const email =
      input.context?.customer?.email ??
      (typeof existing?.["email"] === "string" ? (existing["email"] as string) : undefined)
    if (!email) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Paystack requires the customer's email to initialise a transaction"
      )
    }

    const attempt = (existing?.attempt ?? 0) + 1
    const reference = buildReference(sessionId, attempt)
    const extraMetadata =
      existing && typeof existing["metadata"] === "object" && existing["metadata"]
        ? (existing["metadata"] as Record<string, unknown>)
        : {}

    let initialized
    try {
      initialized = await this.client_.initializeTransaction({
        email,
        amount: amountMinor,
        currency,
        reference,
        callback_url: this.options_.callbackUrl,
        metadata: { ...extraMetadata, session_id: sessionId },
      })
    } catch (error) {
      if (error instanceof PaystackApiError && error.isDuplicateReference) {
        // Retry after a crash between Paystack and the session update: the
        // transaction exists already, so recover it instead of failing.
        const tx = await this.client_.verifyTransaction(reference)
        return {
          id: reference,
          status: mapTransactionStatus(tx.status),
          data: {
            reference,
            session_id: sessionId,
            authorization_url: "",
            access_code: "",
            amount_minor: tx.amount,
            currency: tx.currency?.toUpperCase() ?? currency,
            attempt,
            paystack_transaction_id: tx.id,
            paystack_status: tx.status,
            paid_at: tx.paid_at ?? null,
          } satisfies PaystackSessionData,
        }
      }
      throw error
    }

    const data: PaystackSessionData = {
      reference: initialized.reference ?? reference,
      session_id: sessionId,
      authorization_url: initialized.authorization_url,
      access_code: initialized.access_code,
      amount_minor: amountMinor,
      currency,
      attempt,
    }

    return { id: data.reference, status: PaymentSessionStatus.PENDING, data }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const data = input.data as Partial<PaystackSessionData> | undefined
    if (data?.paystack_status === "success") {
      return { data: input.data }
    }
    // initiatePayment reuses the transaction when nothing changed and
    // re-initialises with a fresh reference when the amount or currency did.
    const result = await this.initiatePayment(input)
    return { data: result.data, status: result.status }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const data = requireSessionData(input.data)
    const tx = await this.client_.verifyTransaction(data.reference)
    return {
      status: mapTransactionStatus(tx.status),
      data: mergeTransaction(data, tx),
    }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const data = requireSessionData(input.data)
    const tx = await this.client_.verifyTransaction(data.reference)
    const merged = mergeTransaction(data, tx)
    const status = mapTransactionStatus(tx.status)

    if (status !== PaymentSessionStatus.CAPTURED) {
      return { status, data: merged }
    }

    // A successful charge must be for exactly what the session asked for.
    const paidCurrency = (tx.currency ?? "").toUpperCase()
    if (tx.amount !== data.amount_minor || paidCurrency !== data.currency) {
      this.logger_.warn(
        `Paystack transaction ${data.reference} paid ${tx.amount} ${paidCurrency} but session ${data.session_id} expects ${data.amount_minor} ${data.currency}`
      )
      return { status: PaymentSessionStatus.ERROR, data: merged }
    }

    return { status, data: merged }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    // Paystack captures when the customer pays; nothing further to do.
    return { data: input.data }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const data = requireSessionData(input.data)
    const amountMinor = toMinorUnits(input.amount)

    const refund = await this.client_.createRefund({
      transaction: data.paystack_transaction_id ?? data.reference,
      amount: amountMinor,
      currency: data.currency,
      merchant_note: input.context?.idempotency_key
        ? `medusa refund ${input.context.idempotency_key}`
        : undefined,
    })

    return {
      data: {
        ...data,
        refunds: [
          ...(data.refunds ?? []),
          {
            id: refund.id,
            amount_minor: amountMinor,
            status: refund.status,
            idempotency_key: input.context?.idempotency_key,
          },
        ],
      },
    }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    // Paystack has no cancel for an initialised transaction; an unpaid one
    // simply expires. A paid one must be refunded instead.
    return { data: input.data }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const data = requireSessionData(input.data)
    const tx = await this.client_.verifyTransaction(data.reference)
    return { data: mergeTransaction(data, tx) }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const signature = headerValue(payload.headers, "x-paystack-signature")
    if (!this.verifySignature(payload.rawData, signature)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Invalid Paystack webhook signature"
      )
    }

    const event = payload.data as unknown as PaystackWebhookEvent
    if (event?.event !== "charge.success") {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const tx = event.data
    const sessionId = sessionIdFromMetadata(tx?.metadata)
    if (!sessionId || tx.status !== "success") {
      // Not a transaction this Medusa instance created, or not actually paid.
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    return {
      action: PaymentActions.SUCCESSFUL,
      data: {
        session_id: sessionId,
        amount: fromMinorUnits(tx.amount),
      },
    }
  }

  verifySignature(rawData: string | Buffer | undefined, signature: string | undefined): boolean {
    if (!rawData || !signature) {
      return false
    }
    const expected = createHmac("sha512", this.options_.secretKey)
      .update(rawData)
      .digest("hex")
    const expectedBuffer = Buffer.from(expected, "utf8")
    const providedBuffer = Buffer.from(signature.trim().toLowerCase(), "utf8")
    if (expectedBuffer.length !== providedBuffer.length) {
      return false
    }
    return timingSafeEqual(expectedBuffer, providedBuffer)
  }
}

/** Pesewas for GHS: major x 100, rounded to the nearest unit. */
export function toMinorUnits(amount: InitiatePaymentInput["amount"]): number {
  const major = new BigNumber(amount).numeric
  if (!Number.isFinite(major) || major < 0) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid amount: ${String(amount)}`)
  }
  return Math.round(major * 100)
}

export function fromMinorUnits(amountMinor: number): number {
  return Math.round(amountMinor) / 100
}

/**
 * Paystack references may only contain a-z, A-Z, 0-9, "-", "." and "=".
 * Medusa session ids look like payses_01HXYZ..., so "_" becomes "-".
 */
export function buildReference(sessionId: string, attempt: number): string {
  const base = sessionId.replace(/[^a-zA-Z0-9.=-]/g, "-")
  return attempt > 1 ? `${base}-${attempt}` : base
}

export function mapTransactionStatus(status: string | undefined): PaymentSessionStatus {
  switch (status) {
    case "success":
      return PaymentSessionStatus.CAPTURED
    case "failed":
      return PaymentSessionStatus.ERROR
    case "reversed":
      return PaymentSessionStatus.CANCELED
    case "abandoned":
    case "ongoing":
    case "pending":
    case "processing":
    case "queued":
    default:
      return PaymentSessionStatus.PENDING
  }
}

export function sessionIdFromMetadata(metadata: PaystackTransaction["metadata"]): string | null {
  let parsed: unknown = metadata
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return null
  }
  const value = (parsed as Record<string, unknown>).session_id
  return typeof value === "string" && value ? value : null
}

function requireSessionData(data: Record<string, unknown> | undefined): PaystackSessionData {
  const candidate = data as Partial<PaystackSessionData> | undefined
  if (!candidate?.reference || !candidate.session_id) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Paystack session data is missing its reference"
    )
  }
  return candidate as PaystackSessionData
}

function mergeTransaction(data: PaystackSessionData, tx: PaystackTransaction): PaystackSessionData {
  return {
    ...data,
    paystack_transaction_id: tx.id,
    paystack_status: tx.status,
    paid_at: tx.paid_at ?? null,
  }
}

function normalizeCurrency(code: string, supported: Set<string>): string {
  const currency = code.toUpperCase()
  if (!supported.has(currency)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Paystack provider does not accept currency ${currency}; supported: ${[...supported].join(", ")}`
    )
  }
  return currency
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(direct)) {
    return typeof direct[0] === "string" ? direct[0] : undefined
  }
  return typeof direct === "string" ? direct : undefined
}

export default PaystackProviderService
