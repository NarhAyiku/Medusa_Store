import { configureStoreSearch, defineMiddlewares } from "@medusajs/framework/http"
import { platformAuth } from "./middlewares/platform-auth"

export default defineMiddlewares({
  routes: [
    // Platform-issued store tokens: validated per tenant, mapped to a Medusa
    // customer, then handed to Medusa's own customer auth. Registered without
    // methods so it runs ahead of the core's route-level authenticate().
    {
      matcher: "/store/*",
      middlewares: [platformAuth()],
    },
    // The product index declares filterable `status` and `sales_channel_ids`, so
    // the route narrows it to published products in the key's sales channels.
    {
      method: ["POST"],
      matcher: "/store/search",
      middlewares: [
        configureStoreSearch({
          allowed_indexes: {
            product: true,
          },
        }),
      ],
    },
  ],
})
