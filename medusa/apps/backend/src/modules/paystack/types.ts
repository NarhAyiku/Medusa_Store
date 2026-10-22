export type PaystackOptions = {
  /** Paystack secret key (sk_test_... or sk_live_...). Also signs webhooks. */
  secretKey: string
  /** Where Paystack sends the customer after payment. Optional; Paystack falls back to the dashboard default. */
  callbackUrl?: string
  /** Override for tests. Defaults to https://api.paystack.co */
  apiBaseUrl?: string
  /** ISO 4217 codes this store accepts through Paystack. Defaults to ["GHS"]. */
  supportedCurrencies?: string[]
  /** Override for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
}

/**
 * What the provider stores on the Medusa payment session / payment.
 * Medusa merges this into `payment_session.data`, and the same object is
 * handed back to authorize, capture and refund.
 */
export type PaystackSessionData = {
  reference: string
  session_id: string
  authorization_url: string
  access_code: string
  /** Amount in minor units (pesewas for GHS) sent to Paystack. */
  amount_minor: number
  currency: string
  /** How many times the session was (re)initialised; part of the reference. */
  attempt: number
  paystack_transaction_id?: number
  paystack_status?: PaystackTransactionStatus | string
  paid_at?: string | null
  refunds?: PaystackRefundRecord[]
}

export type PaystackRefundRecord = {
  id: number | string
  amount_minor: number
  status: string
  idempotency_key?: string
}

export type PaystackTransactionStatus =
  | "success"
  | "failed"
  | "abandoned"
  | "ongoing"
  | "pending"
  | "processing"
  | "queued"
  | "reversed"

export type PaystackApiEnvelope<T> = {
  status: boolean
  message: string
  data: T
}

export type PaystackInitializeRequest = {
  email: string
  amount: number
  currency: string
  reference: string
  callback_url?: string
  metadata?: Record<string, unknown>
}

export type PaystackInitializeData = {
  authorization_url: string
  access_code: string
  reference: string
}

export type PaystackTransaction = {
  id: number
  status: PaystackTransactionStatus | string
  reference: string
  amount: number
  currency: string
  gateway_response?: string
  paid_at?: string | null
  metadata?: Record<string, unknown> | string | null
  customer?: { email?: string }
}

export type PaystackRefundRequest = {
  transaction: string | number
  amount?: number
  currency?: string
  merchant_note?: string
}

export type PaystackRefundData = {
  id: number
  status: string
  amount: number
  currency: string
  transaction: { id: number; reference: string } | number
}

export type PaystackWebhookEvent = {
  event: string
  data: PaystackTransaction & Record<string, unknown>
}
