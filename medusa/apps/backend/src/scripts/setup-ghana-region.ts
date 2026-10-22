import type { ExecArgs, IPricingModuleService, IStoreModuleService } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createRegionsWorkflow,
  createShippingOptionsWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * Sets the store up for Ghana: GHS as a supported currency, a Ghana region
 * (country gh) paying through Paystack when the provider is registered, tax
 * region, an Accra stock location, a Ghana delivery zone with Standard and
 * Express options priced in GHS, and (optionally) placeholder GHS prices for
 * variants that only have EUR prices.
 *
 * Idempotent: every step checks for what already exists first.
 *
 *   npx medusa exec ./src/scripts/setup-ghana-region.ts
 *
 * Set GHANA_SEED_PRICES_FROM_EUR_RATE=16 to derive placeholder GHS prices
 * from existing EUR prices (demo data only; set real prices in the admin).
 */
export default async function setupGhanaRegion({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const storeModule = container.resolve<IStoreModuleService>(Modules.STORE)
  const pricingModule = container.resolve<IPricingModuleService>(Modules.PRICING)
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT)
  const paymentModule = container.resolve(Modules.PAYMENT)
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)

  // 1. GHS as a supported store currency
  const [store] = await storeModule.listStores({}, { relations: ["supported_currencies"] })
  const currencies = store.supported_currencies ?? []
  if (!currencies.some((c) => c.currency_code === "ghs")) {
    await updateStoresWorkflow(container).run({
      input: {
        selector: { id: store.id },
        update: {
          supported_currencies: [
            ...currencies.map((c) => ({
              currency_code: c.currency_code,
              is_default: c.is_default,
            })),
            { currency_code: "ghs", is_default: false },
          ],
        },
      },
    })
    logger.info("Added GHS to supported currencies")
  }

  // 2. Ghana region, paying through Paystack when registered
  const providers = await paymentModule.listPaymentProviders({ is_enabled: true })
  const paystack = providers.find((p) => p.id === "pp_paystack_paystack")
  const paymentProviders = paystack ? [paystack.id] : ["pp_system_default"]
  if (!paystack) {
    logger.warn(
      "Paystack provider is not registered (PAYSTACK_SECRET_KEY unset); using pp_system_default for the Ghana region"
    )
  }

  const { data: existingRegions } = await query.graph({
    entity: "region",
    fields: ["id", "name", "countries.iso_2"],
    filters: { name: "Ghana" },
  })
  let regionId = existingRegions[0]?.id
  if (!regionId) {
    const { result } = await createRegionsWorkflow(container).run({
      input: {
        regions: [
          {
            name: "Ghana",
            currency_code: "ghs",
            countries: ["gh"],
            payment_providers: paymentProviders,
          },
        ],
      },
    })
    regionId = result[0].id
    logger.info(`Created Ghana region ${regionId}`)
  }

  // 3. Tax region for gh
  const { data: taxRegions } = await query.graph({
    entity: "tax_region",
    fields: ["id", "country_code"],
    filters: { country_code: "gh" },
  })
  if (!taxRegions.length) {
    await createTaxRegionsWorkflow(container).run({
      input: [{ country_code: "gh", provider_id: "tp_system" }],
    })
    logger.info("Created tax region for gh")
  }

  // 4. Accra stock location linked to manual fulfillment and the default sales channel
  const { data: locations } = await query.graph({
    entity: "stock_location",
    fields: ["id", "name"],
    filters: { name: "Accra Warehouse" },
  })
  let stockLocationId = locations[0]?.id
  if (!stockLocationId) {
    const { result } = await createStockLocationsWorkflow(container).run({
      input: {
        locations: [
          {
            name: "Accra Warehouse",
            address: { city: "Accra", country_code: "GH", address_1: "" },
          },
        ],
      },
    })
    stockLocationId = result[0].id
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: stockLocationId },
      [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
    })
    const [defaultChannel] = await salesChannelModule.listSalesChannels({
      name: "Default Sales Channel",
    })
    if (defaultChannel) {
      await linkSalesChannelsToStockLocationWorkflow(container).run({
        input: { id: stockLocationId, add: [defaultChannel.id] },
      })
    }
    logger.info(`Created Accra Warehouse ${stockLocationId}`)
  }

  // 5. Ghana delivery zone + shipping options in GHS
  const { data: shippingProfiles } = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
  })
  const shippingProfile = shippingProfiles[0]

  const existingSets = await fulfillmentModule.listFulfillmentSets(
    { name: "Ghana delivery" },
    { relations: ["service_zones"] }
  )
  let serviceZoneId = existingSets[0]?.service_zones?.[0]?.id
  if (!serviceZoneId) {
    const fulfillmentSet = await fulfillmentModule.createFulfillmentSets({
      name: "Ghana delivery",
      type: "shipping",
      service_zones: [
        { name: "Ghana", geo_zones: [{ country_code: "gh", type: "country" }] },
      ],
    })
    serviceZoneId = fulfillmentSet.service_zones[0].id
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: stockLocationId },
      [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
    })

    const rules = [
      { attribute: "enabled_in_store", value: "true", operator: "eq" as const },
      { attribute: "is_return", value: "false", operator: "eq" as const },
    ]
    await createShippingOptionsWorkflow(container).run({
      input: [
        {
          name: "Standard delivery",
          price_type: "flat",
          provider_id: "manual_manual",
          service_zone_id: serviceZoneId,
          shipping_profile_id: shippingProfile.id,
          type: { label: "Standard", description: "Delivered in 2-4 days.", code: "standard" },
          prices: [
            { currency_code: "ghs", amount: 25 },
            { region_id: regionId, amount: 25 },
          ],
          rules,
        },
        {
          name: "Express delivery",
          price_type: "flat",
          provider_id: "manual_manual",
          service_zone_id: serviceZoneId,
          shipping_profile_id: shippingProfile.id,
          type: { label: "Express", description: "Delivered within 24 hours in Accra.", code: "express" },
          prices: [
            { currency_code: "ghs", amount: 60 },
            { region_id: regionId, amount: 60 },
          ],
          rules,
        },
      ],
    })
    logger.info("Created Ghana delivery zone and shipping options")
  }

  // 6. Optional placeholder GHS prices derived from EUR
  const rate = Number(process.env.GHANA_SEED_PRICES_FROM_EUR_RATE ?? 0)
  if (rate > 0) {
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "title", "price_set.id", "price_set.prices.amount", "price_set.prices.currency_code"],
    })
    let added = 0
    for (const variant of variants) {
      const priceSet = variant.price_set as
        | { id: string; prices?: Array<{ amount: number | string; currency_code: string }> }
        | null
      if (!priceSet?.id) continue
      const prices = priceSet.prices ?? []
      if (prices.some((p) => p.currency_code === "ghs")) continue
      const eur = prices.find((p) => p.currency_code === "eur")
      if (!eur) continue
      await pricingModule.addPrices({
        priceSetId: priceSet.id,
        prices: [{ currency_code: "ghs", amount: Math.round(Number(eur.amount) * rate) }],
      })
      added += 1
    }
    logger.info(`Added placeholder GHS prices to ${added} variant(s) at ${rate} GHS/EUR`)
  }

  logger.info("Ghana region setup complete")
}
