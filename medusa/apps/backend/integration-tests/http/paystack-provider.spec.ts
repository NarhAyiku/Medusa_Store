import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import type { IPaymentModuleService } from "@medusajs/framework/types"
import { createHmac } from "node:crypto"

jest.setTimeout(120 * 1000)

const SECRET_KEY = "sk_test_integration_dummy_key"

// medusa-config.ts is evaluated before the runner applies `env`, and the
// Paystack provider is only registered when the key is present at that point.
process.env.PAYSTACK_SECRET_KEY = SECRET_KEY
process.env.PAYSTACK_CALLBACK_URL = "https://platform.example/store/payment/return"

medusaIntegrationTestRunner({
  env: {
    PAYSTACK_SECRET_KEY: SECRET_KEY,
    PAYSTACK_CALLBACK_URL: "https://platform.example/store/payment/return",
    JWT_SECRET: "medusa-integration-jwt-secret",
    COOKIE_SECRET: "medusa-integration-cookie-secret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("Paystack payment provider registration", () => {
      it("registers pp_paystack_paystack as an enabled payment provider", async () => {
        const paymentModule = getContainer().resolve<IPaymentModuleService>(Modules.PAYMENT)
        const providers = await paymentModule.listPaymentProviders({
          id: ["pp_paystack_paystack"],
        })

        expect(providers).toHaveLength(1)
        expect(providers[0].is_enabled).toBe(true)
      })

      it("exposes the core webhook route for the provider", async () => {
        const body = JSON.stringify({ event: "charge.success", data: { status: "success", amount: 100, metadata: {} } })
        const signature = createHmac("sha512", SECRET_KEY).update(body).digest("hex")

        const res = await api.post("/hooks/payment/pp_paystack_paystack", body, {
          headers: { "content-type": "application/json", "x-paystack-signature": signature },
          validateStatus: () => true,
        })

        // The route only queues the event; verification happens in the
        // payment webhook subscriber, so an accepted post returns 200.
        expect(res.status).toBe(200)
      })
    })
  },
})
