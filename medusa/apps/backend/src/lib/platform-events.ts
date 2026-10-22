import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createHmac } from "node:crypto"
import { getTenantRegistry, type StoreTenant, type TenantRegistry } from "./store-tenants"

/**
 * Order lifecycle events delivered from Medusa back to the consumer platform.
 *
 * The platform (Django) keeps sending order emails; Medusa tells it what
 * happened. Delivery is an HTTP POST to the tenant's events_url, signed with
 * the tenant's events_secret:
 *
 *   X-Store-Event-Id:    deterministic per event occurrence (platform dedupes on it)
 *   X-Store-Event-Type:  order.placed | order.updated | order.canceled | order.completed
 *   X-Store-Timestamp:   unix seconds when this delivery attempt was signed
 *   X-Store-Signature:   sha256=HMAC_SHA256(events_secret, "<timestamp>.<body>")
 *
 * Retries with exponential backoff cover transient failures; the
 * reconciliation job covers everything else. Replays reuse the same event id,
 * so the platform's idempotency table ignores duplicates.
 */

export type OrderEventName =
  | "order.placed"
  | "order.updated"
  | "order.canceled"
  | "order.completed"

export type PlatformOrderItem = {
  id: string
  title: string
  variant_title: string | null
  product_id: string | null
  variant_id: string | null
  quantity: number
  unit_price: number
  total: number
}

export type PlatformOrderPayload = {
  id: string
  display_id: number | null
  status: string
  payment_status: string | null
  fulfillment_status: string | null
  email: string | null
  currency_code: string
  total: number
  subtotal: number
  tax_total: number
  shipping_total: number
  created_at: string
  updated_at: string
  paystack_reference: string | null
  customer: {
    id: string | null
    email: string | null
    tenant: string | null
    platform_user_id: string | null
  }
  items: PlatformOrderItem[]
  shipping_address: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}

export type PlatformOrderEvent = {
  id: string
  type: OrderEventName
  tenant: string
  occurred_at: string
  order: PlatformOrderPayload
}

export type DeliveryResult =
  | { delivered: true; attempts: number; status: number; eventId: string }
  | { delivered: false; attempts: number; status: number | null; eventId: string | null; reason: string }

export type DeliverOrderEventOptions = {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
  baseDelayMs?: number
  now?: () => number
  registry?: () => TenantRegistry
}

const ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "payment_status",
  "fulfillment_status",
  "email",
  "currency_code",
  "total",
  "subtotal",
  "tax_total",
  "shipping_total",
  "created_at",
  "updated_at",
  "metadata",
  "customer.id",
  "customer.email",
  "customer.metadata",
  "items.id",
  "items.title",
  "items.variant_title",
  "items.product_id",
  "items.variant_id",
  "items.quantity",
  "items.unit_price",
  "items.total",
  "shipping_address.*",
  "payment_collections.payments.data",
]

type QueryService = {
  graph: (input: {
    entity: string
    fields: string[]
    filters: Record<string, unknown>
  }) => Promise<{ data: Array<Record<string, unknown>> }>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function eventIdFor(name: OrderEventName, order: { id: string; updated_at: string }): string {
  // Placing happens once per order; every other event is keyed by the
  // order's updated_at so each distinct change gets its own id while a
  // retried delivery of the same change keeps the same id.
  return name === "order.placed" ? `${name}:${order.id}` : `${name}:${order.id}:${order.updated_at}`
}

export function signEvent(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string") return Number(value)
  if (value && typeof value === "object" && "numeric" in value) {
    return Number((value as { numeric: unknown }).numeric)
  }
  return 0
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") return new Date(value).toISOString()
  return new Date(0).toISOString()
}

export function toPlatformOrder(raw: Record<string, unknown>): PlatformOrderPayload {
  const customer = (raw.customer ?? null) as Record<string, unknown> | null
  const customerMetadata = (customer?.metadata ?? {}) as Record<string, unknown>
  const items = ((raw.items ?? []) as Array<Record<string, unknown>>).map((item) => ({
    id: String(item.id),
    title: String(item.title ?? ""),
    variant_title: (item.variant_title as string | null) ?? null,
    product_id: (item.product_id as string | null) ?? null,
    variant_id: (item.variant_id as string | null) ?? null,
    quantity: asNumber(item.quantity),
    unit_price: asNumber(item.unit_price),
    total: asNumber(item.total),
  }))

  const collections = (raw.payment_collections ?? []) as Array<Record<string, unknown>>
  let paystackReference: string | null = null
  for (const collection of collections) {
    for (const payment of (collection.payments ?? []) as Array<Record<string, unknown>>) {
      const data = (payment.data ?? {}) as Record<string, unknown>
      if (typeof data.reference === "string" && data.reference) {
        paystackReference = data.reference
      }
    }
  }

  return {
    id: String(raw.id),
    display_id: typeof raw.display_id === "number" ? raw.display_id : null,
    status: String(raw.status ?? ""),
    payment_status: (raw.payment_status as string | null) ?? null,
    fulfillment_status: (raw.fulfillment_status as string | null) ?? null,
    email: (raw.email as string | null) ?? null,
    currency_code: String(raw.currency_code ?? ""),
    total: asNumber(raw.total),
    subtotal: asNumber(raw.subtotal),
    tax_total: asNumber(raw.tax_total),
    shipping_total: asNumber(raw.shipping_total),
    created_at: asIso(raw.created_at),
    updated_at: asIso(raw.updated_at),
    paystack_reference: paystackReference,
    customer: {
      id: (customer?.id as string | null) ?? null,
      email: (customer?.email as string | null) ?? null,
      tenant: (customerMetadata.tenant as string | null) ?? null,
      platform_user_id: (customerMetadata.platform_user_id as string | null) ?? null,
    },
    items,
    shipping_address: (raw.shipping_address as Record<string, unknown> | null) ?? null,
    metadata: (raw.metadata as Record<string, unknown> | null) ?? null,
  }
}

export async function loadOrder(
  container: MedusaContainer,
  orderId: string
): Promise<PlatformOrderPayload | null> {
  const query = container.resolve<QueryService>(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ORDER_FIELDS,
    filters: { id: orderId },
  })
  return data[0] ? toPlatformOrder(data[0]) : null
}

export async function deliverOrderEvent(
  container: MedusaContainer,
  input: { name: OrderEventName; orderId: string },
  options: DeliverOrderEventOptions = {}
): Promise<DeliveryResult> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const maxAttempts = options.maxAttempts ?? 5
  const baseDelayMs = options.baseDelayMs ?? 1000
  const now = options.now ?? Date.now
  const registry = (options.registry ?? getTenantRegistry)()

  const order = await loadOrder(container, input.orderId)
  if (!order) {
    logger.warn(`[platform-events] ${input.name}: order ${input.orderId} not found`)
    return { delivered: false, attempts: 0, status: null, eventId: null, reason: "order_not_found" }
  }

  const tenantId = order.customer.tenant
  if (!tenantId) {
    logger.info(`[platform-events] ${input.name}: order ${order.id} has no platform tenant; skipping`)
    return { delivered: false, attempts: 0, status: null, eventId: null, reason: "no_tenant" }
  }

  const tenant: StoreTenant | undefined = registry.get(tenantId)
  if (!tenant?.eventsUrl || !tenant.eventsSecret) {
    logger.warn(`[platform-events] ${input.name}: tenant "${tenantId}" has no events_url/events_secret configured`)
    return { delivered: false, attempts: 0, status: null, eventId: null, reason: "tenant_not_configured" }
  }

  const eventId = eventIdFor(input.name, order)
  const event: PlatformOrderEvent = {
    id: eventId,
    type: input.name,
    tenant: tenantId,
    occurred_at: new Date(now()).toISOString(),
    order,
  }
  const body = JSON.stringify(event)

  let lastStatus: number | null = null
  let lastReason = "unknown"

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timestamp = Math.floor(now() / 1000)
    try {
      const response = await fetchImpl(tenant.eventsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Store-Event-Id": eventId,
          "X-Store-Event-Type": input.name,
          "X-Store-Timestamp": String(timestamp),
          "X-Store-Signature": signEvent(tenant.eventsSecret, timestamp, body),
        },
        body,
      })
      lastStatus = response.status

      if (response.ok) {
        logger.info(`[platform-events] delivered ${eventId} to ${tenantId} (attempt ${attempt})`)
        return { delivered: true, attempts: attempt, status: response.status, eventId }
      }

      const retryable = response.status >= 500 || response.status === 429
      lastReason = `http_${response.status}`
      if (!retryable) {
        break
      }
    } catch (error) {
      lastStatus = null
      lastReason = `network: ${(error as Error).message}`
    }

    if (attempt < maxAttempts) {
      const jitter = 0.5 + Math.random() * 0.5
      await sleep(baseDelayMs * 2 ** (attempt - 1) * jitter)
    }
  }

  logger.error(
    `[platform-events] failed to deliver ${eventId} to ${tenantId} after ${maxAttempts} attempts (${lastReason}); reconciliation will pick it up`
  )
  return { delivered: false, attempts: maxAttempts, status: lastStatus, eventId, reason: lastReason }
}
