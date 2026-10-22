import {
  isMedusaOrderId,
  legacyHandle,
  mapCategory,
  mapOrder,
  mapOrderStatus,
  mapProduct,
  mapProductStatus,
  slugify,
  type LegacyOrder,
  type LegacyProduct,
} from "../legacy-import"

describe("handles", () => {
  it("slugifies names and prefers the legacy slug", () => {
    expect(slugify("Mentorship Journal (2026)")).toBe("mentorship-journal-2026")
    expect(legacyHandle("my-slug", "Ignored", 1)).toBe("my-slug")
    expect(legacyHandle(null, "Eagles Hoodie", 1)).toBe("eagles-hoodie")
    expect(legacyHandle("", "!!!", 7)).toBe("legacy-7")
  })
})

describe("mapCategory", () => {
  it("keeps the legacy id in metadata", () => {
    expect(mapCategory({ id: 3, name: "Books", slug: "books", description: null, is_active: null })).toEqual({
      name: "Books",
      handle: "books",
      description: "",
      is_active: true,
      metadata: { legacy_id: "3" },
    })
  })
})

describe("mapProduct", () => {
  const product: LegacyProduct = {
    id: 12,
    name: "Mentorship Journal",
    slug: "mentorship-journal",
    description: "A journal.",
    price: "29.99",
    stock_quantity: 40,
    status: "active",
    category_id: 3,
    sku: null,
    created_at: "2026-01-05T10:00:00Z",
    images: [
      { url: "https://cdn.example/b.jpg", order: 2 },
      { url: "https://cdn.example/a.jpg", order: 1 },
    ],
  }
  const ctx = {
    categoryIdByLegacyId: new Map([["3", "pcat_books"]]),
    salesChannelId: "sc_default",
    shippingProfileId: "sp_default",
  }

  it("maps to a published single-variant product priced in GHS", () => {
    const mapped = mapProduct(product, ctx)

    expect(mapped.status).toBe("published")
    expect(mapped.handle).toBe("mentorship-journal")
    expect(mapped.images.map((i) => i.url)).toEqual(["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"])
    expect(mapped.thumbnail).toBe("https://cdn.example/a.jpg")
    expect(mapped.categories).toEqual([{ id: "pcat_books" }])
    expect(mapped.sales_channels).toEqual([{ id: "sc_default" }])
    expect(mapped.variants).toHaveLength(1)
    expect(mapped.variants[0]).toMatchObject({
      title: "Mentorship Journal",
      sku: "legacy-12",
      manage_inventory: true,
      prices: [{ currency_code: "ghs", amount: 29.99 }],
    })
    expect(mapped.metadata.legacy_id).toBe("12")
  })

  it("maps non-active statuses to draft and tolerates unknown categories", () => {
    expect(mapProductStatus("inactive")).toBe("draft")
    expect(mapProductStatus(null)).toBe("draft")
    const mapped = mapProduct({ ...product, status: "archived", category_id: 999 }, ctx)
    expect(mapped.status).toBe("draft")
    expect(mapped.categories).toEqual([])
  })
})

describe("mapOrderStatus", () => {
  it.each([
    ["pending", "pending", "awaiting", "not_fulfilled"],
    ["paid", "pending", "captured", "not_fulfilled"],
    ["processing", "pending", "captured", "not_fulfilled"],
    ["shipped", "pending", "captured", "shipped"],
    ["delivered", "completed", "captured", "delivered"],
    ["cancelled", "canceled", "canceled", "canceled"],
    ["refunded", "canceled", "refunded", "canceled"],
  ])("maps %s", (legacy, status, payment, fulfillment) => {
    expect(mapOrderStatus(legacy)).toEqual({
      status,
      payment_status: payment,
      fulfillment_status: fulfillment,
    })
  })
})

describe("mapOrder", () => {
  const order: LegacyOrder = {
    id: "6c1d2b4e-9f0a-4c3b-8d2e-1f2a3b4c5d6e",
    user_id: "user-1",
    status: "paid",
    total_amount: "59.98",
    paystack_reference: "6c1d2b4e-9f0a-4c3b-8d2e-1f2a3b4c5d6e",
    created_at: "2026-02-01T09:00:00Z",
    updated_at: "2026-02-01T09:30:00Z",
    shipping_name: "Ama Mensah",
    shipping_phone: "+233200000000",
    shipping_address: "12 Liberation Rd",
    shipping_city: "Accra",
    shipping_region: "Greater Accra",
    items: [{ product_id: 12, product_name: "Mentorship Journal", quantity: 2, price: "29.99" }],
    history: [{ status: "paid", changed_at: "2026-02-01T09:05:00Z", changed_by: "paystack", note: null }],
  }
  const ctx = {
    customerId: "cus_1",
    customerEmail: "ama@example.com",
    regionId: "reg_gh",
    salesChannelId: "sc_default",
    variantByLegacyProductId: new Map([["12", { variant_id: "variant_1", product_id: "prod_1" }]]),
  }

  it("builds a paid order with its Paystack transaction and audit trail", () => {
    const mapped = mapOrder(order, ctx)

    expect(mapped.id).toBeUndefined()
    expect(mapped).toMatchObject({
      region_id: "reg_gh",
      customer_id: "cus_1",
      email: "ama@example.com",
      currency_code: "ghs",
      status: "pending",
      no_notification: true,
    })
    expect(mapped.items).toEqual([
      {
        title: "Mentorship Journal",
        quantity: 2,
        unit_price: 29.99,
        product_id: "prod_1",
        variant_id: "variant_1",
        requires_shipping: true,
        metadata: { legacy_product_id: "12" },
      },
    ])
    expect(mapped.transactions).toEqual([
      { amount: 59.98, currency_code: "ghs", reference: "paystack", reference_id: order.id },
    ])
    expect(mapped.shipping_address).toEqual({
      first_name: "Ama",
      last_name: "Mensah",
      phone: "+233200000000",
      address_1: "12 Liberation Rd",
      city: "Accra",
      province: "Greater Accra",
      country_code: "gh",
    })
    expect(mapped.metadata).toMatchObject({
      legacy_id: order.id,
      legacy_status: "paid",
      legacy_total: 59.98,
      legacy_total_mismatch: null,
      paystack_reference: order.id,
      legacy_payment_status: "captured",
      legacy_fulfillment_status: "not_fulfilled",
    })
    expect(mapped.metadata.legacy_status_history).toEqual([
      { status: "paid", changed_at: "2026-02-01T09:05:00.000Z", changed_by: "paystack", note: null },
    ])
  })

  it("records a total mismatch instead of silently trusting either side", () => {
    const mapped = mapOrder({ ...order, total_amount: "100" }, ctx)
    expect(mapped.metadata.legacy_total).toBe(100)
    expect(mapped.metadata.legacy_total_mismatch).toBeCloseTo(59.98)
  })

  it("omits the transaction for unpaid orders and keeps unknown products as plain lines", () => {
    const mapped = mapOrder(
      { ...order, status: "pending", items: [{ product_id: 404, product_name: "Gone", quantity: 1, price: 5 }] },
      ctx
    )
    expect(mapped.transactions).toEqual([])
    expect(mapped.items[0].variant_id).toBeUndefined()
    expect(mapped.items[0].title).toBe("Gone")
  })

  it("preserves ids only when they are already valid Medusa ids", () => {
    expect(isMedusaOrderId("order_01HZZ0ABCDEFGHJKMNPQRSTVWX")).toBe(true)
    expect(isMedusaOrderId(order.id)).toBe(false)
    expect(mapOrder({ ...order, id: "order_01HZZ0ABCDEFGHJKMNPQRSTVWX" }, ctx).id).toBe(
      "order_01HZZ0ABCDEFGHJKMNPQRSTVWX"
    )
  })
})
