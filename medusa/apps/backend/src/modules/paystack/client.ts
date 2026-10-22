import { MedusaError } from "@medusajs/framework/utils"
import type {
  PaystackApiEnvelope,
  PaystackInitializeData,
  PaystackInitializeRequest,
  PaystackRefundData,
  PaystackRefundRequest,
  PaystackTransaction,
} from "./types"

export const PAYSTACK_API_BASE_URL = "https://api.paystack.co"

export class PaystackApiError extends Error {
  readonly httpStatus: number
  readonly paystackMessage: string

  constructor(httpStatus: number, paystackMessage: string, context: string) {
    super(`Paystack ${context} failed (${httpStatus}): ${paystackMessage}`)
    this.name = "PaystackApiError"
    this.httpStatus = httpStatus
    this.paystackMessage = paystackMessage
  }

  get isDuplicateReference(): boolean {
    return /duplicate transaction reference/i.test(this.paystackMessage)
  }
}

export type PaystackClientOptions = {
  secretKey: string
  apiBaseUrl?: string
  fetch?: typeof fetch
  /** Attempts for transient failures (network errors, HTTP 5xx, 429). */
  maxAttempts?: number
  /** Base delay for exponential backoff in milliseconds. */
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Minimal Paystack REST client covering what the payment provider needs.
 * Only the three endpoints used by the provider are wrapped; keep it that way.
 */
export class PaystackClient {
  private readonly secretKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: PaystackClientOptions) {
    if (!options.secretKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Paystack secret key is required"
      )
    }
    this.secretKey = options.secretKey
    this.baseUrl = (options.apiBaseUrl ?? PAYSTACK_API_BASE_URL).replace(/\/+$/, "")
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.maxAttempts = options.maxAttempts ?? 3
    this.baseDelayMs = options.baseDelayMs ?? 500
    this.sleep = options.sleep ?? defaultSleep
  }

  initializeTransaction(
    body: PaystackInitializeRequest
  ): Promise<PaystackInitializeData> {
    return this.request<PaystackInitializeData>(
      "POST",
      "/transaction/initialize",
      body,
      "transaction initialize"
    )
  }

  verifyTransaction(reference: string): Promise<PaystackTransaction> {
    return this.request<PaystackTransaction>(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
      undefined,
      "transaction verify"
    )
  }

  createRefund(body: PaystackRefundRequest): Promise<PaystackRefundData> {
    return this.request<PaystackRefundData>("POST", "/refund", body, "refund")
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    context: string
  ): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.requestOnce<T>(method, path, body, context)
      } catch (error) {
        lastError = error
        const retryable =
          !(error instanceof PaystackApiError) ||
          error.httpStatus >= 500 ||
          error.httpStatus === 429
        if (!retryable || attempt === this.maxAttempts) {
          throw error
        }
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1))
      }
    }
    throw lastError
  }

  private async requestOnce<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    context: string
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    let envelope: PaystackApiEnvelope<T> | null = null
    try {
      envelope = (await response.json()) as PaystackApiEnvelope<T>
    } catch {
      envelope = null
    }

    if (!response.ok || !envelope || envelope.status !== true) {
      throw new PaystackApiError(
        response.status,
        envelope?.message ?? response.statusText ?? "unknown error",
        context
      )
    }

    return envelope.data
  }
}
