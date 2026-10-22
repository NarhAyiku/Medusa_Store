/**
 * Pure mapping from the legacy Django `apps.store` rows to Medusa workflow
 * inputs. See docs/field-mapping.md; keep the two in step.
 *
 * Everything that touches the legacy database or Medusa lives in
 * src/scripts/import-legacy.ts. This file has no I/O so it can be unit
 * tested without either database.
 */

export type LegacyCategory = {
  id: string | number
  name: string
  slug: string | null
  description: string | null
  is_active: boolean | null
}

export type LegacyProductImage = {
  url: string
  order: number | null
}

export type LegacyProduct = {
  id: string | number
  name: string
  slug: string | null
  description: string | null
  price: string | number
  stock_quantity: number | null
  status: string | null
  category_id: string | number | null
  sku: string | null
  created_at: string | Date | null
  images: LegacyProductImage[]
}

export type LegacyUser = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
}

export type LegacyOrderItem = {
  product_id: string | number | null
  product_name: string
  quantity: number
  price: string | number
}

export type LegacyStatusHistory = {
  status: string
  changed_at: string | Date
  changed_by: string | null
  note: string | null
}

export type LegacyOrder = {
  id: string
  user_id: string
  status: string
  total_amount: string | number
  paystack_reference: string | null
  created_at: string | Date
  updated_at: string | Date | null
  shipping_name: string | null
  shipping_phone: string | null
  shipping_address: string | null
  shipping_city: string | null
  shipping_region: string | null
  items: LegacyOrderItem[]
  history: LegacyStatusHistory[]
}

export const LEGACY_CURRENCY = "ghs"

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
}

export function legacyHandle(slug: string | null, name: string, id: string | number): string {
  const base = slug?.trim() ? slugify(slug) : slugify(name)
  return base || `legacy-${id}`
}

export function mapCategory(category: LegacyCategory) {
  return {
    name: category.name,
    handle: legacyHandle(category.slug, category.name, category.id),
    description: category.description ?? "",
    is_active: category.is_active ?? true,
    metadata: { legacy_id: String(category.id) },
  }
}

export function mapProductStatus(status: string | null): "published" | "draft" {
  return status?.toLowerCase() === "active" ? "published" : "draft"
}

export type ProductMappingContext = {
  categoryIdByLegacyId: Map<string, string>
  salesChannelId: string
  shippingProfileId: string
}

export function mapProduct(product: LegacyProduct, ctx: ProductMappingContext) {
  const images = [...product.images]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((image) => ({ url: image.url }))
  const categoryId =
    product.category_id !== null ? ctx.categoryIdByLegacyId.get(String(product.category_id)) : undefined
  const title = product.name

  return {
    title,
    handle: legacyHandle(product.slug, product.name, product.id),
    description: product.description ?? "",
    status: mapProductStatus(product.status),
    images,
    thumbnail: images[0]?.url,
    categories: categoryId ? [{ id: categoryId }] : [],
    sales_channels: [{ id: ctx.salesChannelId }],
    shipping_profile_id: ctx.shippingProfileId,
    options: [{ title: "Default", values: ["Default"] }],
    variants: [
      {
        title,
        sku: product.sku?.trim() || `legacy-${product.id}`,
        manage_inventory: true,
        options: { Default: "Default" },
        prices: [{ currency_code: LEGACY_CURRENCY, amount: Number(product.price) }],
        metadata: { legacy_id: String(product.id) },
      },
    ],
    metadata: {
      legacy_id: String(product.id),
      legacy_created_at: product.created_at ? new Date(product.created_at).toISOString() : null,
    },
  }
}

export type MappedOrderStatus = {
  status: "pending" | "completed" | "canceled"
  payment_status: "awaiting" | "captured" | "canceled" | "refunded"
  fulfillment_status: "not_fulfilled" | "shipped" | "delivered" | "canceled"
}

export function mapOrderStatus(status: string): MappedOrderStatus {
  switch (status.toLowerCase()) {
    case "paid":
    case "processing":
      return { status: "pending", payment_status: "captured", fulfillment_status: "not_fulfilled" }
    case "shipped":
      return { status: "pending", payment_status: "captured", fulfillment_status: "shipped" }
    case "delivered":
      return { status: "completed", payment_status: "captured", fulfillment_status: "delivered" }
    case "cancelled":
    case "canceled":
      return { status: "canceled", payment_status: "canceled", fulfillment_status: "canceled" }
    case "refunded":
      return { status: "canceled", payment_status: "refunded", fulfillment_status: "canceled" }
    case "pending":
    default:
      return { status: "pending", payment_status: "awaiting", fulfillment_status: "not_fulfilled" }
  }
}

export type OrderMappingContext = {
  customerId: string
  customerEmail: string
  regionId: string
  salesChannelId: string
  variantByLegacyProductId: Map<string, { variant_id: string; product_id: string }>
}

export function isMedusaOrderId(id: string): boolean {
  return /^order_[0-9A-Z]{26}$/.test(id)
}

export function mapOrder(order: LegacyOrder, ctx: OrderMappingContext) {
  const mapped = mapOrderStatus(order.status)
  const items = order.items.map((item) => {
    const variant =
      item.product_id !== null ? ctx.variantByLegacyProductId.get(String(item.product_id)) : undefined
    return {
      title: item.product_name,
      quantity: item.quantity,
      unit_price: Number(item.price),
      product_id: variant?.product_id,
      variant_id: variant?.variant_id,
      requires_shipping: true,
      metadata: { legacy_product_id: item.product_id !== null ? String(item.product_id) : null },
    }
  })

  const itemsTotal = items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0)
  const legacyTotal = Number(order.total_amount)
  const [firstName, ...rest] = (order.shipping_name ?? "").trim().split(/\s+/)

  const transactions =
    mapped.payment_status === "captured" || mapped.payment_status === "refunded"
      ? [
          {
            amount: legacyTotal,
            currency_code: LEGACY_CURRENCY,
            reference: "paystack",
            reference_id: order.paystack_reference ?? order.id,
          },
        ]
      : []

  return {
    // Receipts reference the legacy order id through paystack_reference;
    // Medusa ids must be ULID-based, so the legacy UUID lives in metadata.
    ...(isMedusaOrderId(order.id) ? { id: order.id } : {}),
    region_id: ctx.regionId,
    customer_id: ctx.customerId,
    sales_channel_id: ctx.salesChannelId,
    email: ctx.customerEmail,
    currency_code: LEGACY_CURRENCY,
    status: mapped.status,
    no_notification: true,
    items,
    transactions,
    shipping_address: order.shipping_address
      ? {
          first_name: firstName || null,
          last_name: rest.join(" ") || null,
          phone: order.shipping_phone,
          address_1: order.shipping_address,
          city: order.shipping_city,
          province: order.shipping_region,
          country_code: "gh",
        }
      : undefined,
    metadata: {
      legacy_id: order.id,
      legacy_status: order.status,
      legacy_total: legacyTotal,
      legacy_total_mismatch: Math.abs(itemsTotal - legacyTotal) > 0.005 ? itemsTotal : null,
      legacy_created_at: new Date(order.created_at).toISOString(),
      legacy_payment_status: mapped.payment_status,
      legacy_fulfillment_status: mapped.fulfillment_status,
      paystack_reference: order.paystack_reference ?? order.id,
      legacy_status_history: order.history.map((entry) => ({
        status: entry.status,
        changed_at: new Date(entry.changed_at).toISOString(),
        changed_by: entry.changed_by,
        note: entry.note,
      })),
    },
  }
}
