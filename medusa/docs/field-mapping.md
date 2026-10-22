# Field mapping: Django `apps.store` to Medusa v2

Reference for the legacy import script (`apps/backend/src/scripts/import-legacy.ts`)
and the frontend adapter (`medusa-adapter.js`). Both depend on this document, so
change it first when a mapping changes.

Conventions used throughout:

- Money: Django stores major units (GHS, two decimals). Medusa stores amounts as
  decimal values in the region's currency; the Paystack provider converts to
  pesewas (minor units, major x 100) at the provider boundary only. The frontend
  adapter keeps returning major units to the existing components.
- Currency: `ghs` (Medusa lower-cases currency codes). One region, "Ghana",
  currency GHS, Paystack as its payment provider.
- Legacy ids: every imported record keeps its Django id in `metadata.legacy_id`.
  Orders keep their original UUID as the Medusa order id where possible
  because `paystack_reference` equals the order id and receipts reference it.
- Platform identity: customers carry `metadata.tenant` and
  `metadata.platform_user_id`; the (tenant, platform user id) pair is the
  identity, held as a Medusa auth identity under the `platform` provider with
  `entity_id = "<tenant>:<platform_user_id>"`.

## Catalog

| Django | Medusa | Notes |
| --- | --- | --- |
| `Category.id` | `ProductCategory.metadata.legacy_id` | |
| `Category.name` | `ProductCategory.name` | |
| `Category.slug` | `ProductCategory.handle` | Medusa requires unique handles |
| `Category.description` | `ProductCategory.description` | |
| `Category.is_active` | `ProductCategory.is_active` | |
| `Product.id` | `Product.metadata.legacy_id` | |
| `Product.name` | `Product.title` and `ProductVariant.title` | Single-variant products: variant title = product title |
| `Product.slug` | `Product.handle` | |
| `Product.description` | `Product.description` | |
| `Product.price` (major) | `ProductVariant.prices[]` with `currency_code: "ghs"`, `amount: price` | One price per variant, no price lists at import |
| `Product.stock_quantity` | `InventoryLevel.stocked_quantity` at the default stock location | Medusa tracks stock per variant via `InventoryItem`; `manage_inventory: true` |
| `Product.status` | `Product.status` | `active` -> `published`, everything else -> `draft` |
| `Product.category` | `Product.categories[]` | |
| `Product.sku` (if present) | `ProductVariant.sku` | Falls back to `legacy-<id>` |
| `Product.created_at` | `Product.created_at` | Preserved by the import |
| `ProductImage.image` | `Product.images[].url` | First image also becomes `Product.thumbnail` |
| `ProductImage.order` | position in `Product.images[]` | |

## Customers

| Django | Medusa | Notes |
| --- | --- | --- |
| `User.id` (uuid) | `Customer.metadata.platform_user_id` and auth `ProviderIdentity.entity_id` suffix | Identity is the (tenant, user id) pair, never email |
| tenant id (`eaglesneaglets`) | `Customer.metadata.tenant` and `ProviderIdentity.entity_id` prefix | |
| `User.email` | `Customer.email` | Medusa keeps account emails unique per instance. If a second tenant brings an email that already exists, that customer gets `local+tenant@domain` and the real address lives in `Customer.metadata.platform_email` |
| `User.first_name`, `User.last_name` | `Customer.first_name`, `Customer.last_name` | |
| `User.phone` | `Customer.phone` | |
| (none) | `Customer.has_account` | Always `true` for platform members |

## Cart

| Django | Medusa | Notes |
| --- | --- | --- |
| `Cart.user` | `Cart.customer_id` and `Cart.email` | Set from the authenticated customer; the platform token is required, there is no guest cart |
| `Cart.created_at` | `Cart.created_at` | Carts are not imported; members start with an empty cart after cutover |
| `CartItem.product` | `LineItem.variant_id` | The product's single variant |
| `CartItem.quantity` | `LineItem.quantity` | |
| (computed) `Cart.total` | `Cart.total` (also `subtotal`, `tax_total`, `shipping_total`) | Medusa computes totals; the adapter exposes `total` in major units |

## Orders

| Django | Medusa | Notes |
| --- | --- | --- |
| `Order.id` (uuid) | `Order.id` | Preserved on import where the id is a valid Medusa id; otherwise `metadata.legacy_id` |
| `Order.user` | `Order.customer_id`, `Order.email` | |
| `Order.status` | `Order.status` plus `Order.payment_status` / `Order.fulfillment_status` | See status mapping below |
| `Order.total_amount` (major) | `Order.total` | Medusa recomputes from items; the import asserts the totals match and records a mismatch in `metadata.legacy_total` |
| `Order.paystack_reference` | `Payment.data.reference` and `Order.metadata.paystack_reference` | Equals the legacy order id |
| `Order.shipping_address` fields | `Order.shipping_address` | Ghana address shape; `country_code: "gh"` |
| `Order.created_at` | `Order.created_at` | Preserved |
| `OrderItem.product` | `OrderLineItem.variant_id`, `product_title`, `variant_title` | Title and price are snapshotted at order time in both systems |
| `OrderItem.quantity` | `OrderLineItem.quantity` | |
| `OrderItem.price` (major, at order time) | `OrderLineItem.unit_price` | |
| `OrderStatusHistory` | `Order.metadata.legacy_status_history[]` | Kept as an audit trail: `[{ status, changed_at, changed_by, note }]`. Medusa's own order change log takes over after cutover |

### Order status mapping

Django keeps one status field; Medusa splits it into three. The frontend
adapter derives the single legacy status the components expect from the
Medusa triple using the same table in reverse.

| Django `Order.status` | Medusa `status` | `payment_status` | `fulfillment_status` |
| --- | --- | --- | --- |
| `pending` | `pending` | `awaiting` | `not_fulfilled` |
| `paid` | `pending` | `captured` | `not_fulfilled` |
| `processing` | `pending` | `captured` | `not_fulfilled` |
| `shipped` | `pending` | `captured` | `shipped` |
| `delivered` | `completed` | `captured` | `delivered` |
| `cancelled` | `canceled` | `canceled` or `refunded` | `canceled` |
| `refunded` | `canceled` | `refunded` | `canceled` |

Reverse derivation for the adapter: `canceled` -> `cancelled` (or `refunded`
when `payment_status` is `refunded`); `completed` -> `delivered`;
`fulfillment_status` `shipped` -> `shipped`; `payment_status` `captured` ->
`paid`; otherwise `pending`.

## Payments (Paystack)

| Django `payments.py` | Medusa Paystack provider | Notes |
| --- | --- | --- |
| amount in pesewas = major x 100 | `initiatePayment`: `Math.round(amount * 100)` | GHS has two decimals |
| reference = order id | reference = payment session id (sanitised) and `metadata.session_id` | Medusa has no order until the cart completes; the session id is what the webhook needs to find the cart. Paystack references may only contain `a-zA-Z0-9-.=`, so `_` becomes `-` |
| `X-Paystack-Signature` verified with constant-time compare | `getWebhookActionAndData` uses `crypto.timingSafeEqual` on HMAC-SHA512 of the raw body | |
| currency GHS | `currency: "GHS"` | |
| `charge.success` marks order paid | `charge.success` -> `PaymentActions.SUCCESSFUL` -> Medusa captures the payment and completes the cart | |

## What the frontend `{ data: ... }` envelope needs

The existing hooks expect `{ data: <payload> }` with major-unit prices. The
adapter wraps Medusa responses and maps:

- `product.title` -> `name`, `variants[0].calculated_price.calculated_amount` -> `price`,
  `thumbnail`/`images[0].url` -> `image`, inventory quantity -> `stock_quantity`,
  `status === "published"` -> `status: "active"`.
- `cart.items[]` -> `items[]` with `product` (mapped as above) and `quantity`;
  `cart.total` -> `total`.
- `order` -> `id`, `status` (derived as above), `total_amount: total`,
  `created_at`, `items[]`, `paystack_reference: metadata.paystack_reference`.
