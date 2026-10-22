import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { OrderWorkflowEvents } from "@medusajs/framework/utils"
import { deliverOrderEvent } from "../lib/platform-events"

/**
 * Tells the member's platform that an order was placed, so it can send the
 * confirmation email it already owns the templates for.
 */
export default async function orderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  await deliverOrderEvent(container, { name: "order.placed", orderId: data.id })
}

export const config: SubscriberConfig = {
  event: OrderWorkflowEvents.PLACED,
  context: { subscriberId: "platform-order-placed" },
}
