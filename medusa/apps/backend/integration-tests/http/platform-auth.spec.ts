import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import type { IApiKeyModuleService } from "@medusajs/framework/types"
import jwt from "jsonwebtoken"

jest.setTimeout(120 * 1000)

const SECRET_A = "eaglesneaglets-integration-secret-".padEnd(48, "a")
const SECRET_B = "otherplatform-integration-secret-".padEnd(48, "b")

function mint(claims: Record<string, unknown>, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign({ iat: now, exp: now + 300, ...claims }, secret, { algorithm: "HS256" })
}

medusaIntegrationTestRunner({
  env: {
    STORE_TENANTS: JSON.stringify({
      eaglesneaglets: { name: "Eagles & Eaglets", secret: SECRET_A },
      otherplatform: { name: "Other Platform", secret: SECRET_B },
    }),
    JWT_SECRET: "medusa-integration-jwt-secret",
    COOKIE_SECRET: "medusa-integration-cookie-secret",
  },
  testSuite: ({ api, getContainer }) => {
    let headers: Record<string, string>

    beforeAll(async () => {
      const apiKeyModule = getContainer().resolve<IApiKeyModuleService>(Modules.API_KEY)
      const key = await apiKeyModule.createApiKeys({
        title: "platform-auth tests",
        type: "publishable",
        created_by: "integration-test",
      })
      headers = { "x-publishable-api-key": key.token }
    })

    const me = (token?: string) =>
      api
        .get("/store/customers/me", {
          headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers,
          validateStatus: () => true,
        })

    describe("platform store tokens on /store routes", () => {
      it("creates the customer on first use and returns the same one afterwards", async () => {
        const token = mint(
          { iss: "eaglesneaglets", sub: "user-1", email: "Member@Example.com" },
          SECRET_A
        )

        const first = await me(token)
        expect(first.status).toBe(200)
        expect(first.data.customer.email).toBe("member@example.com")
        expect(first.data.customer.has_account).toBe(true)
        expect(first.data.customer.metadata).toMatchObject({
          tenant: "eaglesneaglets",
          platform_user_id: "user-1",
        })

        const second = await me(token)
        expect(second.status).toBe(200)
        expect(second.data.customer.id).toBe(first.data.customer.id)
      })

      it("keeps the same sub on two tenants as two different customers, even with one email", async () => {
        const sameSub = "123"
        const sameEmail = "shared@example.com"
        const tokenA = mint({ iss: "eaglesneaglets", sub: sameSub, email: sameEmail }, SECRET_A)
        const tokenB = mint({ iss: "otherplatform", sub: sameSub, email: sameEmail }, SECRET_B)

        const a = await me(tokenA)
        const b = await me(tokenB)

        expect(a.status).toBe(200)
        expect(b.status).toBe(200)
        expect(a.data.customer.id).not.toBe(b.data.customer.id)
        expect(a.data.customer.metadata.tenant).toBe("eaglesneaglets")
        expect(b.data.customer.metadata.tenant).toBe("otherplatform")

        // Medusa keeps account emails unique, so the second tenant's customer
        // gets a plus-addressed alias and keeps the real address in metadata.
        expect(a.data.customer.email).toBe(sameEmail)
        expect(b.data.customer.email).toBe("shared+otherplatform@example.com")
        expect(b.data.customer.metadata.platform_email).toBe(sameEmail)

        // Both tokens keep resolving to their own customer.
        expect((await me(tokenA)).data.customer.id).toBe(a.data.customer.id)
        expect((await me(tokenB)).data.customer.id).toBe(b.data.customer.id)
      })

      it("satisfies the core's strict route-level customer authentication", async () => {
        const token = mint({ iss: "eaglesneaglets", sub: "user-2", email: "u2@example.com" }, SECRET_A)

        const orders = await api.get("/store/orders", {
          headers: { ...headers, authorization: `Bearer ${token}` },
          validateStatus: () => true,
        })

        expect(orders.status).toBe(200)
        expect(orders.data.orders).toEqual([])
      })

      it("rejects a token signed with the wrong secret", async () => {
        const token = mint({ iss: "eaglesneaglets", sub: "user-3" }, SECRET_B)
        const res = await me(token)
        expect(res.status).toBe(401)
        expect(res.data.code).toBe("invalid_signature")
      })

      it("rejects an unknown tenant", async () => {
        const token = mint({ iss: "nobody", sub: "user-3" }, SECRET_A)
        const res = await me(token)
        expect(res.status).toBe(401)
        expect(res.data.code).toBe("unknown_tenant")
      })

      it("rejects an expired token", async () => {
        const now = Math.floor(Date.now() / 1000)
        const token = jwt.sign(
          { iss: "eaglesneaglets", sub: "user-3", iat: now - 900, exp: now - 300 },
          SECRET_A
        )
        const res = await me(token)
        expect(res.status).toBe(401)
        expect(res.data.code).toBe("expired")
      })

      it("still requires authentication without a token", async () => {
        const res = await me()
        expect(res.status).toBe(401)
      })
    })
  },
})
