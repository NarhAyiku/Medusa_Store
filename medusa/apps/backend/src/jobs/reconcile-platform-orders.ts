import type { MedusaContainer } from "@medusajs/framework/types"
import { reconcilePlatformOrders } from "../lib/platform-reconciliation"

/**
 * Safety net for the distributed-transaction risk: a payment can succeed
 * while the order.placed delivery to the platform fails for good.
 *
 * Every hour, re-deliver order.placed for every paid order updated within
 * the lookback window. Event ids are deterministic, so the platform's
 * idempotency table drops anything it already processed and only genuinely
 * missed orders get through. Divergence is logged by the reconciliation
 * helper; alerting hooks into those log lines.
 */
export default async function reconcilePlatformOrdersJob(container: MedusaContainer) {
  await reconcilePlatformOrders(container)
}

export const config = {
  name: "reconcile-platform-orders",
  schedule: process.env.PLATFORM_EVENTS_RECONCILE_CRON ?? "0 * * * *",
}
