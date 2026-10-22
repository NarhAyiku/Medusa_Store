import { PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"
import { createHmac } from "node:crypto"
import {
  buildReference,
  fromMinorUnits,
  mapTransactionStatus,
  PaystackProviderService,
  sessionIdFromMetadata,
  toMinorUnits,
} from "../service"
import type { PaystackSessionData } from "../types"

const SECRET = "sk_test_unit_secret"
const SESSION_ID = "payses_01HZZ0TESTSESSION"

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> }

function makeFetch(
  respond: (call: Call) => { status?: number; body: unknown }
) {
  const calls: Call[] = []
  const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: init.headers as Record<string, string>,
    }
    calls.push(call)
    const { status = 200, body } = respond(call)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
    } as Response
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

function makeProvider(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }
  const provider = new PaystackProviderService({ logger: logger as never }, {
    secretKey: SECRET,
    callbackUrl: "https://platform.example/store/payment/return",
    fetch: fetchImpl,
    ...extra,
  })
  return { provider, logger }
}

const ok = (data: unknown) => ({ body: { status: true, message: "ok", data } })

function sessionData(overrides: Partial<PaystackSessionData> = {}): PaystackSessionData {
  return {
    reference: "payses-01HZZ0TESTSESSION",
    session_id: SESSION_ID,
    authorization_url: "https://checkout.paystack.com/abc",
    access_code: "abc",
    amount_minor: 1999,
    currency: "GHS",
    attempt: 1,
    ...overrides,
  }
}

describe("amount and reference helpers", () => {
  it("converts major GHS to pesewas and back", () => {
    expect(toMinorUnits(19.99)).toBe(1999)
    expect(toMinorUnits("250")).toBe(25000)
    expect(toMinorUnits(0.1 + 0.2)).toBe(30)
    expect(fromMinorUnits(1999)).toBe(19.99)
  })

  it("rejects negative or non-numeric amounts", () => {
    expect(() => toMinorUnits(-5)).toThrow(/Invalid amount/)
  })

  it("builds Paystack-safe references from session ids", () => {
    expect(buildReference(SESSION_ID, 1)).toBe("payses-01HZZ0TESTSESSION")
    expect(buildReference(SESSION_ID, 3)).toBe("payses-01HZZ0TESTSESSION-3")
    expect(buildReference(SESSION_ID, 1)).toMatch(/^[a-zA-Z0-9.=-]+$/)
  })

  it("maps Paystack transaction statuses onto Medusa session statuses", () => {
    expect(mapTransactionStatus("success")).toBe(PaymentSessionStatus.CAPTURED)
    expect(mapTransactionStatus("failed")).toBe(PaymentSessionStatus.ERROR)
    expect(mapTransactionStatus("reversed")).toBe(PaymentSessionStatus.CANCELED)
    expect(mapTransactionStatus("abandoned")).toBe(PaymentSessionStatus.PENDING)
    expect(mapTransactionStatus(undefined)).toBe(PaymentSessionStatus.PENDING)
  })

  it("reads session_id from object or JSON-string metadata", () => {
    expect(sessionIdFromMetadata({ session_id: SESSION_ID })).toBe(SESSION_ID)
    expect(sessionIdFromMetadata(JSON.stringify({ session_id: SESSION_ID }))).toBe(SESSION_ID)
    expect(sessionIdFromMetadata("not json")).toBeNull()
    expect(sessionIdFromMetadata(null)).toBeNull()
    expect(sessionIdFromMetadata({})).toBeNull()
  })
})

describe("PaystackProviderService", () => {
  it("has the identifier Medusa registers it under", () => {
    expect(PaystackProviderService.identifier).toBe("paystack")
  })

  it("requires a secret key", () => {
    expect(() => PaystackProviderService.validateOptions({})).toThrow(/secretKey/)
    expect(() => PaystackProviderService.validateOptions({ secretKey: "sk_test_x" })).not.toThrow()
  })

  describe("initiatePayment", () => {
    it("initialises a Paystack transaction in pesewas and returns the authorization URL", async () => {
      const { fetchImpl, calls } = makeFetch(() =>
        ok({
          authorization_url: "https://checkout.paystack.com/xyz",
          access_code: "xyz",
          reference: "payses-01HZZ0TESTSESSION",
        })
      )
      const { provider } = makeProvider(fetchImpl)

      const result = await provider.initiatePayment({
        amount: 19.99,
        currency_code: "ghs",
        data: { session_id: SESSION_ID },
        context: { customer: { id: "cus_1", email: "member@example.com" } },
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe("https://api.paystack.co/transaction/initialize")
      expect(calls[0].headers.Authorization).toBe(`Bearer ${SECRET}`)
      expect(calls[0].body).toEqual({
        email: "member@example.com",
        amount: 1999,
        currency: "GHS",
        reference: "payses-01HZZ0TESTSESSION",
        callback_url: "https://platform.example/store/payment/return",
        metadata: { session_id: SESSION_ID },
      })

      expect(result.id).toBe("payses-01HZZ0TESTSESSION")
      expect(result.status).toBe(PaymentSessionStatus.PENDING)
      expect(result.data).toEqual({
        reference: "payses-01HZZ0TESTSESSION",
        session_id: SESSION_ID,
        authorization_url: "https://checkout.paystack.com/xyz",
        access_code: "xyz",
        amount_minor: 1999,
        currency: "GHS",
        attempt: 1,
      })
    })

    it("refuses without a customer email", async () => {
      const { fetchImpl, calls } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)

      await expect(
        provider.initiatePayment({
          amount: 10,
          currency_code: "ghs",
          data: { session_id: SESSION_ID },
          context: {},
        })
      ).rejects.toThrow(/email/)
      expect(calls).toHaveLength(0)
    })

    it("refuses unsupported currencies", async () => {
      const { fetchImpl } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)

      await expect(
        provider.initiatePayment({
          amount: 10,
          currency_code: "usd",
          data: { session_id: SESSION_ID },
          context: { customer: { id: "cus_1", email: "m@example.com" } },
        })
      ).rejects.toThrow(/USD/)
    })

    it("reuses an existing unpaid transaction when nothing changed (idempotent)", async () => {
      const { fetchImpl, calls } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)
      const existing = sessionData()

      const result = await provider.initiatePayment({
        amount: 19.99,
        currency_code: "ghs",
        data: existing,
        context: { customer: { id: "cus_1", email: "m@example.com" } },
      })

      expect(calls).toHaveLength(0)
      expect(result.data).toEqual(existing)
    })

    it("re-initialises with a new reference when the amount changed", async () => {
      const { fetchImpl, calls } = makeFetch((call) =>
        ok({
          authorization_url: "https://checkout.paystack.com/new",
          access_code: "new",
          reference: (call.body as { reference: string }).reference,
        })
      )
      const { provider } = makeProvider(fetchImpl)

      const result = await provider.updatePayment({
        amount: 25,
        currency_code: "ghs",
        data: sessionData(),
        context: { customer: { id: "cus_1", email: "m@example.com" } },
      })

      expect(calls).toHaveLength(1)
      expect((calls[0].body as { amount: number }).amount).toBe(2500)
      expect((result.data as PaystackSessionData).reference).toBe("payses-01HZZ0TESTSESSION-2")
      expect((result.data as PaystackSessionData).attempt).toBe(2)
    })

    it("recovers from a duplicate reference by verifying the existing transaction", async () => {
      const { fetchImpl, calls } = makeFetch((call) => {
        if (call.url.endsWith("/transaction/initialize")) {
          return { status: 400, body: { status: false, message: "Duplicate Transaction Reference" } }
        }
        return ok({ id: 77, status: "abandoned", reference: "payses-01HZZ0TESTSESSION", amount: 1999, currency: "GHS" })
      })
      const { provider } = makeProvider(fetchImpl)

      const result = await provider.initiatePayment({
        amount: 19.99,
        currency_code: "ghs",
        data: { session_id: SESSION_ID },
        context: { customer: { id: "cus_1", email: "m@example.com" } },
      })

      expect(calls.map((c) => c.url.split("api.paystack.co")[1])).toEqual([
        "/transaction/initialize",
        "/transaction/verify/payses-01HZZ0TESTSESSION",
      ])
      expect(result.status).toBe(PaymentSessionStatus.PENDING)
      expect((result.data as PaystackSessionData).paystack_transaction_id).toBe(77)
    })
  })

  describe("authorizePayment and getPaymentStatus", () => {
    it("reports a successful, matching transaction as captured", async () => {
      const { fetchImpl } = makeFetch(() =>
        ok({ id: 42, status: "success", reference: "payses-01HZZ0TESTSESSION", amount: 1999, currency: "GHS", paid_at: "2026-10-22T10:00:00Z" })
      )
      const { provider } = makeProvider(fetchImpl)

      const result = await provider.authorizePayment({ data: sessionData() })

      expect(result.status).toBe(PaymentSessionStatus.CAPTURED)
      expect(result.data).toMatchObject({
        paystack_transaction_id: 42,
        paystack_status: "success",
        paid_at: "2026-10-22T10:00:00Z",
      })
    })

    it("refuses to authorize when the paid amount differs from the session", async () => {
      const { fetchImpl } = makeFetch(() =>
        ok({ id: 42, status: "success", reference: "payses-01HZZ0TESTSESSION", amount: 100, currency: "GHS" })
      )
      const { provider, logger } = makeProvider(fetchImpl)

      const result = await provider.authorizePayment({ data: sessionData() })

      expect(result.status).toBe(PaymentSessionStatus.ERROR)
      expect(logger.warn).toHaveBeenCalled()
    })

    it("leaves an unpaid transaction pending", async () => {
      const { fetchImpl } = makeFetch(() =>
        ok({ id: 42, status: "abandoned", reference: "payses-01HZZ0TESTSESSION", amount: 1999, currency: "GHS" })
      )
      const { provider } = makeProvider(fetchImpl)

      expect((await provider.getPaymentStatus({ data: sessionData() })).status).toBe(
        PaymentSessionStatus.PENDING
      )
    })

    it("fails loudly without a reference", async () => {
      const { fetchImpl } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)
      await expect(provider.getPaymentStatus({ data: {} })).rejects.toThrow(/reference/)
    })
  })

  describe("capture and refund", () => {
    it("captures without calling Paystack", async () => {
      const { fetchImpl, calls } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)
      const data = sessionData({ paystack_status: "success" })

      expect(await provider.capturePayment({ data })).toEqual({ data })
      expect(calls).toHaveLength(0)
    })

    it("refunds in minor units against the Paystack transaction and records it", async () => {
      const { fetchImpl, calls } = makeFetch(() =>
        ok({ id: 9001, status: "pending", amount: 500, currency: "GHS", transaction: 42 })
      )
      const { provider } = makeProvider(fetchImpl)

      const result = await provider.refundPayment({
        amount: 5,
        data: sessionData({ paystack_transaction_id: 42, paystack_status: "success" }),
        context: { idempotency_key: "ref_123" },
      })

      expect(calls[0].url).toBe("https://api.paystack.co/refund")
      expect(calls[0].body).toEqual({
        transaction: 42,
        amount: 500,
        currency: "GHS",
        merchant_note: "medusa refund ref_123",
      })
      expect((result.data as PaystackSessionData).refunds).toEqual([
        { id: 9001, amount_minor: 500, status: "pending", idempotency_key: "ref_123" },
      ])
    })
  })

  describe("getWebhookActionAndData", () => {
    const event = {
      event: "charge.success",
      data: {
        id: 42,
        status: "success",
        reference: "payses-01HZZ0TESTSESSION",
        amount: 1999,
        currency: "GHS",
        metadata: { session_id: SESSION_ID },
      },
    }
    const rawBody = JSON.stringify(event)
    const sign = (body: string, secret = SECRET) =>
      createHmac("sha512", secret).update(body).digest("hex")

    it("rejects a tampered signature", async () => {
      const { fetchImpl } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)

      await expect(
        provider.getWebhookActionAndData({
          data: event,
          rawData: rawBody,
          headers: { "x-paystack-signature": sign(rawBody, "wrong-secret") },
        })
      ).rejects.toThrow(/signature/)
    })

    it("rejects a body that does not match the signature", async () => {
      const { fetchImpl } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)
      const tampered = rawBody.replace("1999", "1")

      await expect(
        provider.getWebhookActionAndData({
          data: JSON.parse(tampered),
          rawData: tampered,
          headers: { "x-paystack-signature": sign(rawBody) },
        })
      ).rejects.toThrow(/signature/)
    })

    it("rejects a missing signature", async () => {
      const { fetchImpl } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)

      await expect(
        provider.getWebhookActionAndData({ data: event, rawData: rawBody, headers: {} })
      ).rejects.toThrow(/signature/)
    })

    it("marks a validly signed charge.success as captured for its session", async () => {
      const { fetchImpl } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)

      const result = await provider.getWebhookActionAndData({
        data: event,
        rawData: Buffer.from(rawBody),
        headers: { "x-paystack-signature": sign(rawBody) },
      })

      expect(result).toEqual({
        action: PaymentActions.SUCCESSFUL,
        data: { session_id: SESSION_ID, amount: 19.99 },
      })
    })

    it("ignores events that are not charge.success", async () => {
      const { fetchImpl } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)
      const other = JSON.stringify({ ...event, event: "transfer.success" })

      const result = await provider.getWebhookActionAndData({
        data: JSON.parse(other),
        rawData: other,
        headers: { "x-paystack-signature": sign(other) },
      })

      expect(result).toEqual({ action: PaymentActions.NOT_SUPPORTED })
    })

    it("ignores charges that did not originate from a Medusa session", async () => {
      const { fetchImpl } = makeFetch(() => ok({}))
      const { provider } = makeProvider(fetchImpl)
      const foreign = JSON.stringify({ ...event, data: { ...event.data, metadata: {} } })

      const result = await provider.getWebhookActionAndData({
        data: JSON.parse(foreign),
        rawData: foreign,
        headers: { "x-paystack-signature": sign(foreign) },
      })

      expect(result).toEqual({ action: PaymentActions.NOT_SUPPORTED })
    })
  })
})
