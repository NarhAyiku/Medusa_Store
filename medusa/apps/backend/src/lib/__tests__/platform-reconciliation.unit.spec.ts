import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { reconcilePlatformOrders } from "../platform-reconciliation"
import { parseTenantRegistry } from "../store-tenants"

const registry = parseTenantRegistry(
  JSON.stringify({
    eaglesneaglets: {
      secret: "a".repeat(40),
      events_url: "https://platform.example/api/v1/store/events/",
      events_secret: "events-secret",
    },
  })
)

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)

function order(id: string, tenant: string | null = "eaglesneaglets") {
  return {
    id,
    status: "pending",
    payment_status: "captured",
    currency_code: "ghs",
    total: 10,
    created_at: "2026-10-22T10:00:00.000Z",
    updated_at: "2026-10-22T10:00:00.000Z",
    customer: { id: `cus_${id}`, email: `${id}@example.com`, metadata: tenant ? { tenant, platform_user_id: id } : {} },
    items: [],
  }
}

function makeContainer(orders: Array<Record<string, unknown>>) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  const graph = jest.fn(async (input: { entity: string; filters: Record<string, unknown>; pagination?: { skip: number; take: number } }) => {
    if (input.filters.id) {
      return { data: orders.filter((o) => o.id === input.filters.id) }
    }
    const { skip, take } = input.pagination ?? { skip: 0, take: 100 }
    return { data: orders.slice(skip, skip + take).map((o) => ({ id: o.id })) }
  })
  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.LOGGER) return logger
      if (key === ContainerRegistrationKeys.QUERY) return { graph }
      throw new Error(`unexpected resolve(${key})`)
    },
  }
  return { container: container as never, logger, graph }
}

describe("reconcilePlatformOrders", () => {
  it("re-delivers order.placed for every paid order in the lookback window", async () => {
    const { container, graph, logger } = makeContainer([order("o1"), order("o2")])
    const sent: string[] = []
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>)["X-Store-Event-Id"])
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch

    const summary = await reconcilePlatformOrders(container, {
      fetch: fetchImpl,
      now: () => NOW,
      registry: () => registry,
      lookbackHours: 6,
      sleep: async () => undefined,
    })

    expect(summary).toEqual({ scanned: 2, delivered: 2, skipped: 0, failed: 0, failedOrderIds: [] })
    expect(sent).toEqual(["order.placed:o1", "order.placed:o2"])

    const listCall = graph.mock.calls.find((c) => !(c[0] as { filters: Record<string, unknown> }).filters.id)
    expect((listCall?.[0] as { filters: Record<string, unknown> }).filters).toEqual({
      payment_status: "captured",
      updated_at: { $gte: "2026-10-22T06:00:00.000Z" },
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("pages through large result sets", async () => {
    const many = Array.from({ length: 5 }, (_, i) => order(`o${i}`))
    const { container, graph } = makeContainer(many)
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch

    const summary = await reconcilePlatformOrders(container, {
      fetch: fetchImpl,
      now: () => NOW,
      registry: () => registry,
      batchSize: 2,
      sleep: async () => undefined,
    })

    expect(summary.scanned).toBe(5)
    const listCalls = graph.mock.calls.filter((c) => !(c[0] as { filters: Record<string, unknown> }).filters.id)
    expect(listCalls).toHaveLength(3)
  })

  it("counts skipped and failed orders and logs failures for alerting", async () => {
    const { container, logger } = makeContainer([order("ok"), order("guest", null), order("bad")])
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      const id = (init.headers as Record<string, string>)["X-Store-Event-Id"]
      return { ok: !id.endsWith(":bad"), status: id.endsWith(":bad") ? 500 : 200 } as Response
    }) as unknown as typeof fetch

    const summary = await reconcilePlatformOrders(container, {
      fetch: fetchImpl,
      now: () => NOW,
      registry: () => registry,
      maxAttempts: 2,
      sleep: async () => undefined,
    })

    expect(summary).toEqual({ scanned: 3, delivered: 1, skipped: 1, failed: 1, failedOrderIds: ["bad"] })
    expect(logger.error).toHaveBeenLastCalledWith(expect.stringContaining("failed_orders=bad"))
  })
})
