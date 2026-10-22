import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { deliverOrderEvent, type DeliverOrderEventOptions } from "./platform-events"

/**
 * Re-delivers order.placed for recently paid orders. Deterministic event ids
 * make this safe: the platform ignores ids it has already processed, so the
 * only effect is to heal deliveries that failed permanently.
 */

export type ReconcileOptions = DeliverOrderEventOptions & {
  /** How far back to look. Defaults to PLATFORM_EVENTS_RECONCILE_HOURS or 24. */
  lookbackHours?: number
  /** Page size for the order query. */
  batchSize?: number
}

export type ReconcileSummary = {
  scanned: number
  delivered: number
  skipped: number
  failed: number
  failedOrderIds: string[]
}

type QueryService = {
  graph: (input: {
    entity: string
    fields: string[]
    filters: Record<string, unknown>
    pagination?: { skip: number; take: number; order?: Record<string, "ASC" | "DESC"> }
  }) => Promise<{ data: Array<{ id: string }> }>
}

export async function reconcilePlatformOrders(
  container: MedusaContainer,
  options: ReconcileOptions = {}
): Promise<ReconcileSummary> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve<QueryService>(ContainerRegistrationKeys.QUERY)
  const now = options.now ?? Date.now
  const lookbackHours =
    options.lookbackHours ?? Number(process.env.PLATFORM_EVENTS_RECONCILE_HOURS ?? 24)
  const batchSize = options.batchSize ?? 100
  const since = new Date(now() - lookbackHours * 60 * 60 * 1000)

  const summary: ReconcileSummary = {
    scanned: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
    failedOrderIds: [],
  }

  for (let skip = 0; ; skip += batchSize) {
    const { data } = await query.graph({
      entity: "order",
      fields: ["id"],
      filters: {
        payment_status: "captured",
        updated_at: { $gte: since.toISOString() },
      },
      pagination: { skip, take: batchSize, order: { updated_at: "ASC" } },
    })

    for (const order of data) {
      summary.scanned += 1
      const result = await deliverOrderEvent(
        container,
        { name: "order.placed", orderId: order.id },
        options
      )
      if (result.delivered) {
        summary.delivered += 1
      } else if (result.attempts === 0) {
        summary.skipped += 1
      } else {
        summary.failed += 1
        summary.failedOrderIds.push(order.id)
      }
    }

    if (data.length < batchSize) {
      break
    }
  }

  const line = `[platform-reconciliation] scanned=${summary.scanned} delivered=${summary.delivered} skipped=${summary.skipped} failed=${summary.failed} since=${since.toISOString()}`
  if (summary.failed > 0) {
    logger.error(`${line} failed_orders=${summary.failedOrderIds.join(",")}`)
  } else {
    logger.info(line)
  }

  return summary
}
