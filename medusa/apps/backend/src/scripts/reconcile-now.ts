import type { ExecArgs } from "@medusajs/framework/types"
import { reconcilePlatformOrders } from "../lib/platform-reconciliation"

/**
 * On-demand run of the order-event reconciliation (see docs/runbooks.md).
 *
 *   PLATFORM_EVENTS_RECONCILE_HOURS=168 npx medusa exec ./src/scripts/reconcile-now.ts
 */
export default async function reconcileNow({ container }: ExecArgs) {
  const summary = await reconcilePlatformOrders(container)
  if (summary.failed > 0) {
    throw new Error(`Reconciliation left ${summary.failed} order(s) undelivered: ${summary.failedOrderIds.join(", ")}`)
  }
}
