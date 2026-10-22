import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createHmac } from "node:crypto"
import {
  deliverOrderEvent,
  eventIdFor,
  signEvent,
  toPlatformOrder,
} from "../platform-events"
import { parseTenantRegistry } from "../store-tenants"

const EVENTS_URL = "https://platform.example/api/v1/store/events/"
const EVENTS_SECRET = "events-secret-for-eaglesneaglets"

const registry = parseTenantRegistry(
  JSON.stringify({
    eaglesneaglets: {
      secret: "a".repeat(40),
      events_url: EVENTS_URL,
      events_secret: EVENTS_SECRET,
    },
    unconfigured: { secret: "b".repeat(40) },
  })
)

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)

function rawOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_01HORDER",
    display_id: 42,
    status: "pending",
    payment_status: "captured",
    fulfillment_status: "not_fulfilled",
    email: "member@example.com",
    currency_code: "ghs",
    total: { numeric: 59.98 },
    subtotal: "59.98",
    tax_total: 0,
    shipping_total: 0,
    created_at: new Date("2026-10-22T11:00:00Z"),
    updated_at: new Date("2026-10-22T11:05:00Z"),
    metadata: { note: "hi" },
    customer: {
      id: "cus_1",
      email: "member@example.com",
      metadata: { tenant: "eaglesneaglets", platform_user_id: "user-1" },
    },
    items: [
      {
        id: "ordli_1",
        title: "Mentorship Journal",
        variant_title: "Default",
        product_id: "prod_1",
        variant_id: "variant_1",
        quantity: 2,
        unit_price: 29.99,
        total: { numeric: 59.98 },
      },
    ],
    shipping_address: { city: "Accra", country_code: "gh" },
    payment_collections: [
      { payments: [{ data: { reference: "payses-01HSESSION" } }] },
    ],
    ...overrides,
  }
}

function makeContainer(order: Record<string, unknown> | null) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  const graph = jest.fn(async () => ({ data: order ? [order] : [] }))
  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.LOGGER) return logger
      if (key === ContainerRegistrationKeys.QUERY) return { graph }
      throw new Error(`unexpected resolve(${key})`)
    },
  }
  return { container: container as never, logger, graph }
}

type Sent = { url: string; headers: Record<string, string>; body: string }

function makeFetch(statuses: Array<number | "network">) {
  const sent: Sent[] = []
  let i = 0
  const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: init.body as string })
    const status = statuses[Math.min(i++, statuses.length - 1)]
    if (status === "network") {
      throw new Error("ECONNRESET")
    }
    return { ok: status >= 200 && status < 300, status } as Response
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, sent }
}

function deliver(
  container: never,
  fetchImpl: typeof fetch,
  name: "order.placed" | "order.updated" = "order.placed"
) {
  const sleep = jest.fn(async () => undefined)
  return deliverOrderEvent(
    container,
    { name, orderId: "order_01HORDER" },
    { fetch: fetchImpl, sleep, maxAttempts: 3, baseDelayMs: 10, now: () => NOW, registry: () => registry }
  ).then((result) => ({ result, sleep }))
}

describe("toPlatformOrder", () => {
  it("flattens the Medusa order graph into the platform payload", () => {
    const payload = toPlatformOrder(rawOrder())

    expect(payload).toEqual({
      id: "order_01HORDER",
      display_id: 42,
      status: "pending",
      payment_status: "captured",
      fulfillment_status: "not_fulfilled",
      email: "member@example.com",
      currency_code: "ghs",
      total: 59.98,
      subtotal: 59.98,
      tax_total: 0,
      shipping_total: 0,
      created_at: "2026-10-22T11:00:00.000Z",
      updated_at: "2026-10-22T11:05:00.000Z",
      paystack_reference: "payses-01HSESSION",
      customer: {
        id: "cus_1",
        email: "member@example.com",
        tenant: "eaglesneaglets",
        platform_user_id: "user-1",
      },
      items: [
        {
          id: "ordli_1",
          title: "Mentorship Journal",
          variant_title: "Default",
          product_id: "prod_1",
          variant_id: "variant_1",
          quantity: 2,
          unit_price: 29.99,
          total: 59.98,
        },
      ],
      shipping_address: { city: "Accra", country_code: "gh" },
      metadata: { note: "hi" },
    })
  })
})

describe("eventIdFor", () => {
  it("is stable per order for placement and per change for updates", () => {
    const order = { id: "order_1", updated_at: "2026-10-22T11:05:00.000Z" }
    expect(eventIdFor("order.placed", order)).toBe("order.placed:order_1")
    expect(eventIdFor("order.updated", order)).toBe("order.updated:order_1:2026-10-22T11:05:00.000Z")
    expect(eventIdFor("order.updated", { ...order, updated_at: "2026-10-22T11:06:00.000Z" })).not.toBe(
      eventIdFor("order.updated", order)
    )
  })
})

describe("deliverOrderEvent", () => {
  it("posts a signed, idempotent event to the tenant's events URL", async () => {
    const { container, logger } = makeContainer(rawOrder())
    const { fetchImpl, sent } = makeFetch([200])

    const { result } = await deliver(container, fetchImpl)

    expect(result).toEqual({ delivered: true, attempts: 1, status: 200, eventId: "order.placed:order_01HORDER" })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(EVENTS_URL)

    const { headers, body } = sent[0]
    expect(headers["X-Store-Event-Id"]).toBe("order.placed:order_01HORDER")
    expect(headers["X-Store-Event-Type"]).toBe("order.placed")
    expect(headers["X-Store-Timestamp"]).toBe(String(Math.floor(NOW / 1000)))
    const expected = `sha256=${createHmac("sha256", EVENTS_SECRET)
      .update(`${headers["X-Store-Timestamp"]}.${body}`)
      .digest("hex")}`
    expect(headers["X-Store-Signature"]).toBe(expected)
    expect(signEvent(EVENTS_SECRET, Number(headers["X-Store-Timestamp"]), body)).toBe(expected)

    const event = JSON.parse(body)
    expect(event).toMatchObject({
      id: "order.placed:order_01HORDER",
      type: "order.placed",
      tenant: "eaglesneaglets",
      occurred_at: "2026-10-22T12:00:00.000Z",
    })
    expect(event.order.id).toBe("order_01HORDER")
    expect(event.order.paystack_reference).toBe("payses-01HSESSION")
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("retries transient failures with backoff and keeps the same event id", async () => {
    const { container } = makeContainer(rawOrder())
    const { fetchImpl, sent } = makeFetch([503, "network", 200])

    const { result, sleep } = await deliver(container, fetchImpl, "order.updated")

    expect(result.delivered).toBe(true)
    expect(result.attempts).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(new Set(sent.map((s) => s.headers["X-Store-Event-Id"])).size).toBe(1)
    expect(sent[0].headers["X-Store-Event-Id"]).toBe(
      "order.updated:order_01HORDER:2026-10-22T11:05:00.000Z"
    )
  })

  it("gives up after the last attempt and logs for reconciliation", async () => {
    const { container, logger } = makeContainer(rawOrder())
    const { fetchImpl, sent } = makeFetch([500])

    const { result } = await deliver(container, fetchImpl)

    expect(result).toEqual({
      delivered: false,
      attempts: 3,
      status: 500,
      eventId: "order.placed:order_01HORDER",
      reason: "http_500",
    })
    expect(sent).toHaveLength(3)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it("does not retry client errors", async () => {
    const { container } = makeContainer(rawOrder())
    const { fetchImpl, sent } = makeFetch([400])

    const { result, sleep } = await deliver(container, fetchImpl)

    expect(result.delivered).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it("skips orders whose customer has no platform tenant", async () => {
    const { container } = makeContainer(rawOrder({ customer: { id: "cus_x", email: "x@example.com", metadata: {} } }))
    const { fetchImpl, sent } = makeFetch([200])

    const { result } = await deliver(container, fetchImpl)

    expect(result).toMatchObject({ delivered: false, reason: "no_tenant" })
    expect(sent).toHaveLength(0)
  })

  it("skips tenants without an events endpoint", async () => {
    const { container, logger } = makeContainer(
      rawOrder({ customer: { id: "cus_y", email: "y@example.com", metadata: { tenant: "unconfigured" } } })
    )
    const { fetchImpl, sent } = makeFetch([200])

    const { result } = await deliver(container, fetchImpl)

    expect(result).toMatchObject({ delivered: false, reason: "tenant_not_configured" })
    expect(sent).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("reports a missing order", async () => {
    const { container } = makeContainer(null)
    const { fetchImpl, sent } = makeFetch([200])

    const { result } = await deliver(container, fetchImpl)

    expect(result).toMatchObject({ delivered: false, reason: "order_not_found" })
    expect(sent).toHaveLength(0)
  })
})
