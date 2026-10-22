import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { OrderWorkflowEvents } from "@medusajs/framework/utils"
import { deliverOrderEvent, type OrderEventName } from "../lib/platform-events"

const EVENT_NAMES: Record<string, OrderEventName> = {
  [OrderWorkflowEvents.UPDATED]: "order.updated",
  [OrderWorkflowEvents.CANCELED]: "order.canceled",
  [OrderWorkflowEvents.COMPLETED]: "order.completed",
}

/**
 * Relays later order lifecycle changes to the member's platform.
 */
export default async function orderUpdatedHandler({
  event: { data, name },
  container,
}: SubscriberArgs<{ id: string }>) {
  const eventName = EVENT_NAMES[name] ?? "order.updated"
  await deliverOrderEvent(container, { name: eventName, orderId: data.id })
}

export const config: SubscriberConfig = {
  event: [
    OrderWorkflowEvents.UPDATED,
    OrderWorkflowEvents.CANCELED,
    OrderWorkflowEvents.COMPLETED,
  ],
  context: { subscriberId: "platform-order-updated" },
}
