import { loadEnv, defineConfig } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

// Paystack is only registered when a secret key is configured, so the service
// still boots (admin, catalog, identity bridge) without payment credentials.
const paymentProviders = process.env.PAYSTACK_SECRET_KEY
  ? [
      {
        resolve: "./src/modules/paystack",
        id: "paystack",
        options: {
          secretKey: process.env.PAYSTACK_SECRET_KEY,
          callbackUrl: process.env.PAYSTACK_CALLBACK_URL,
        },
      },
    ]
  : []

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  modules: paymentProviders.length
    ? [
        {
          resolve: "@medusajs/medusa/payment",
          options: { providers: paymentProviders },
        },
      ]
    : [],
})
