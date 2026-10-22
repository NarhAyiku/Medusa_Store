import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { Client } from "@medusajs/framework/pg"
import {
  createInventoryLevelsWorkflow,
  createOrderWorkflow,
  createProductCategoriesWorkflow,
  createProductsWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  mapCategory,
  mapOrder,
  mapProduct,
  type LegacyCategory,
  type LegacyOrder,
  type LegacyOrderItem,
  type LegacyProduct,
  type LegacyProductImage,
  type LegacyStatusHistory,
  type LegacyUser,
} from "../lib/legacy-import"
import { resolvePlatformCustomer } from "../lib/platform-customer"
import { getTenantRegistry } from "../lib/store-tenants"

/**
 * One-time import of the Django store into Medusa.
 *
 *   LEGACY_DATABASE_URL=postgres://... LEGACY_TENANT=eaglesneaglets \
 *   npx medusa exec ./src/scripts/import-legacy.ts            # dry run: counts only
 *   IMPORT_APPLY=1 npx medusa exec ./src/scripts/import-legacy.ts
 *
 * Idempotent on re-runs: every imported record carries metadata.legacy_id
 * and is skipped when it already exists. Legacy table and column names are
 * Django defaults for apps.store; adjust LEGACY_SQL to the real schema and
 * compare the dry-run counts against the Django admin before applying.
 */

const LEGACY_SQL = {
  categories: `
    SELECT id, name, slug, description, is_active
    FROM store_category
    ORDER BY id`,
  products: `
    SELECT id, name, slug, description, price, stock_quantity, status, category_id, sku, created_at
    FROM store_product
    ORDER BY id`,
  productImages: `
    SELECT product_id, image AS url, "order"
    FROM store_productimage
    ORDER BY product_id, "order"`,
  users: `
    SELECT u.id::text AS id, u.email, u.first_name, u.last_name, u.phone
    FROM users_user u
    WHERE EXISTS (SELECT 1 FROM store_order o WHERE o.user_id = u.id)
    ORDER BY u.id`,
  orders: `
    SELECT id::text AS id, user_id::text AS user_id, status, total_amount, paystack_reference,
           created_at, updated_at, shipping_name, shipping_phone, shipping_address,
           shipping_city, shipping_region
    FROM store_order
    ORDER BY created_at`,
  orderItems: `
    SELECT order_id::text AS order_id, product_id, product_name, quantity, price
    FROM store_orderitem
    ORDER BY order_id, id`,
  orderHistory: `
    SELECT order_id::text AS order_id, status, changed_at, changed_by, note
    FROM store_orderstatushistory
    ORDER BY order_id, changed_at`,
}

export default async function importLegacy({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const apply = process.env.IMPORT_APPLY === "1"
  const tenantId = process.env.LEGACY_TENANT ?? "eaglesneaglets"
  const legacyUrl = process.env.LEGACY_DATABASE_URL
  if (!legacyUrl) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "LEGACY_DATABASE_URL is required")
  }
  const tenant = getTenantRegistry().get(tenantId)
  if (!tenant) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `Tenant "${tenantId}" is not in STORE_TENANTS`)
  }

  const legacy = new Client({ connectionString: legacyUrl })
  await legacy.connect()
  try {
    const categories = (await legacy.query<LegacyCategory>(LEGACY_SQL.categories)).rows
    const productRows = (await legacy.query<Omit<LegacyProduct, "images">>(LEGACY_SQL.products)).rows
    const imageRows = (await legacy.query<LegacyProductImage & { product_id: string | number }>(LEGACY_SQL.productImages)).rows
    const users = (await legacy.query<LegacyUser>(LEGACY_SQL.users)).rows
    const orderRows = (await legacy.query<Omit<LegacyOrder, "items" | "history">>(LEGACY_SQL.orders)).rows
    const itemRows = (await legacy.query<LegacyOrderItem & { order_id: string }>(LEGACY_SQL.orderItems)).rows
    const historyRows = (await legacy.query<LegacyStatusHistory & { order_id: string }>(LEGACY_SQL.orderHistory)).rows

    const products: LegacyProduct[] = productRows.map((p) => ({
      ...p,
      images: imageRows.filter((i) => String(i.product_id) === String(p.id)),
    }))
    const orders: LegacyOrder[] = orderRows.map((o) => ({
      ...o,
      items: itemRows.filter((i) => i.order_id === o.id),
      history: historyRows.filter((h) => h.order_id === o.id),
    }))

    logger.info(
      `[import-legacy] legacy counts: categories=${categories.length} products=${products.length} images=${imageRows.length} customers=${users.length} orders=${orders.length} items=${itemRows.length}`
    )
    if (!apply) {
      logger.info("[import-legacy] dry run; set IMPORT_APPLY=1 to write to Medusa")
      return
    }

    // Targets in Medusa
    const [salesChannel] = await container.resolve(Modules.SALES_CHANNEL).listSalesChannels({ name: "Default Sales Channel" })
    const { data: regions } = await query.graph({ entity: "region", fields: ["id"], filters: { name: "Ghana" } })
    const { data: shippingProfiles } = await query.graph({ entity: "shipping_profile", fields: ["id"] })
    const { data: stockLocations } = await query.graph({ entity: "stock_location", fields: ["id"], filters: { name: "Accra Warehouse" } })
    if (!salesChannel || !regions[0] || !shippingProfiles[0] || !stockLocations[0]) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Run setup-ghana-region.ts first (needs the Ghana region, Accra Warehouse and a shipping profile)")
    }
    const regionId = regions[0].id
    const stockLocationId = stockLocations[0].id

    // 1. Categories
    const { data: existingCategories } = await query.graph({ entity: "product_category", fields: ["id", "metadata"] })
    const categoryIdByLegacyId = new Map<string, string>()
    for (const c of existingCategories) {
      const legacyId = (c.metadata as Record<string, unknown> | null)?.legacy_id
      if (typeof legacyId === "string") categoryIdByLegacyId.set(legacyId, c.id)
    }
    const newCategories = categories.filter((c) => !categoryIdByLegacyId.has(String(c.id)))
    if (newCategories.length) {
      const { result } = await createProductCategoriesWorkflow(container).run({
        input: { product_categories: newCategories.map(mapCategory) },
      })
      result.forEach((created, i) => categoryIdByLegacyId.set(String(newCategories[i].id), created.id))
    }
    logger.info(`[import-legacy] categories: ${newCategories.length} created, ${categories.length - newCategories.length} existing`)

    // 2. Products (single variant each) + inventory levels
    const { data: existingProducts } = await query.graph({
      entity: "product",
      fields: ["id", "metadata", "variants.id", "variants.inventory_items.inventory_item_id"],
    })
    const variantByLegacyProductId = new Map<string, { variant_id: string; product_id: string }>()
    const inventoryItemByLegacyProductId = new Map<string, string>()
    const indexProduct = (p: Record<string, unknown>) => {
      const legacyId = (p.metadata as Record<string, unknown> | null)?.legacy_id
      const variant = (p.variants as Array<Record<string, unknown>> | undefined)?.[0]
      if (typeof legacyId !== "string" || !variant) return
      variantByLegacyProductId.set(legacyId, { variant_id: variant.id as string, product_id: p.id as string })
      const inventoryItem = (variant.inventory_items as Array<Record<string, unknown>> | undefined)?.[0]
      if (inventoryItem?.inventory_item_id) {
        inventoryItemByLegacyProductId.set(legacyId, inventoryItem.inventory_item_id as string)
      }
    }
    existingProducts.forEach(indexProduct)

    const newProducts = products.filter((p) => !variantByLegacyProductId.has(String(p.id)))
    if (newProducts.length) {
      const ctx = { categoryIdByLegacyId, salesChannelId: salesChannel.id, shippingProfileId: shippingProfiles[0].id }
      const { result } = await createProductsWorkflow(container).run({
        input: { products: newProducts.map((p) => mapProduct(p, ctx)) },
      })
      const { data: created } = await query.graph({
        entity: "product",
        fields: ["id", "metadata", "variants.id", "variants.inventory_items.inventory_item_id"],
        filters: { id: result.map((p) => p.id) },
      })
      created.forEach(indexProduct)

      const levels = newProducts
        .map((p) => ({
          inventory_item_id: inventoryItemByLegacyProductId.get(String(p.id)),
          location_id: stockLocationId,
          stocked_quantity: p.stock_quantity ?? 0,
        }))
        .filter((l): l is { inventory_item_id: string; location_id: string; stocked_quantity: number } => !!l.inventory_item_id)
      if (levels.length) {
        await createInventoryLevelsWorkflow(container).run({ input: { inventory_levels: levels } })
      }
    }
    logger.info(`[import-legacy] products: ${newProducts.length} created, ${products.length - newProducts.length} existing`)

    // 3. Customers: same (tenant, platform user id) mapping the auth bridge uses
    const customerByLegacyUserId = new Map<string, { customerId: string; email: string }>()
    for (const user of users) {
      const { customerId } = await resolvePlatformCustomer(container, {
        tenant,
        platformUserId: user.id,
        email: user.email.trim().toLowerCase(),
        expiresAt: 0,
      })
      customerByLegacyUserId.set(user.id, { customerId, email: user.email.trim().toLowerCase() })
    }
    logger.info(`[import-legacy] customers: ${customerByLegacyUserId.size} resolved`)

    // 4. Orders
    const { data: existingOrders } = await query.graph({ entity: "order", fields: ["id", "metadata"] })
    const importedOrderIds = new Set(
      existingOrders
        .map((o) => (o.metadata as Record<string, unknown> | null)?.legacy_id)
        .filter((id): id is string => typeof id === "string")
    )
    let createdOrders = 0
    let skippedOrders = 0
    for (const order of orders) {
      if (importedOrderIds.has(order.id)) {
        skippedOrders += 1
        continue
      }
      const customer = customerByLegacyUserId.get(order.user_id)
      if (!customer) {
        logger.warn(`[import-legacy] order ${order.id}: legacy user ${order.user_id} not found; skipped`)
        skippedOrders += 1
        continue
      }
      await createOrderWorkflow(container).run({
        input: mapOrder(order, {
          customerId: customer.customerId,
          customerEmail: customer.email,
          regionId,
          salesChannelId: salesChannel.id,
          variantByLegacyProductId,
        }),
      })
      createdOrders += 1
    }
    logger.info(`[import-legacy] orders: ${createdOrders} created, ${skippedOrders} skipped`)
    logger.info("[import-legacy] done; compare counts and spot-check 10 orders in the admin")
  } finally {
    await legacy.end()
  }
}
