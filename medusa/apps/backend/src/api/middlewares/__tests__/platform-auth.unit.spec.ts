import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import jwt from "jsonwebtoken"
import { parseTenantRegistry } from "../../../lib/store-tenants"
import { platformIdentityKey, type PlatformIdentity } from "../../../lib/platform-token"
import { extractBearerToken, platformAuth } from "../platform-auth"

const SECRET_A = "tenant-a-secret-".padEnd(40, "a")
const SECRET_B = "tenant-b-secret-".padEnd(40, "b")
const MEDUSA_JWT_SECRET = "medusa-own-jwt-secret"

const registry = parseTenantRegistry(
  JSON.stringify({
    eaglesneaglets: { secret: SECRET_A },
    otherplatform: { secret: SECRET_B },
  })
)

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)
const nowSeconds = Math.floor(NOW / 1000)

function mint(claims: Record<string, unknown>, secret: string): string {
  return jwt.sign(
    { iat: nowSeconds, exp: nowSeconds + 300, email: "member@example.com", ...claims },
    secret,
    { algorithm: "HS256" }
  )
}

function makeScope() {
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const config = { projectConfig: { http: { jwtSecret: MEDUSA_JWT_SECRET } } }
  return {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.LOGGER) return logger
      if (key === ContainerRegistrationKeys.CONFIG_MODULE) return config
      throw new Error(`unexpected resolve(${key})`)
    },
    logger,
  }
}

function makeReq(authorization?: string) {
  const scope = makeScope()
  return {
    headers: authorization ? { authorization } : {},
    scope,
    auth_context: undefined as unknown,
  }
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res
}

/**
 * A fake customer resolver that behaves like the real one with respect to
 * identity: one customer per (tenant, sub) pair, created on first use.
 */
function makeResolver() {
  const customers = new Map<string, { customerId: string; authIdentityId: string }>()
  const resolve = jest.fn(async (_scope: unknown, identity: PlatformIdentity) => {
    const key = platformIdentityKey(identity.tenant.id, identity.platformUserId)
    let found = customers.get(key)
    if (!found) {
      found = {
        customerId: `cus_${customers.size + 1}`,
        authIdentityId: `authid_${customers.size + 1}`,
      }
      customers.set(key, found)
    }
    return found
  })
  return { resolve, customers }
}

function run(authorization: string | undefined, resolver = makeResolver()) {
  const middleware = platformAuth({
    registry: () => registry,
    resolveCustomer: resolver.resolve as never,
    now: () => NOW,
  })
  const req = makeReq(authorization)
  const res = makeRes()
  const next = jest.fn()
  return middleware(req as never, res as never, next).then(() => ({ req, res, next, resolver }))
}

describe("extractBearerToken", () => {
  it("extracts bearer tokens case-insensitively and ignores other schemes", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi")
    expect(extractBearerToken("bearer abc")).toBe("abc")
    expect(extractBearerToken("Basic c2tfMTIz")).toBeNull()
    expect(extractBearerToken(undefined)).toBeNull()
    expect(extractBearerToken("Bearer")).toBeNull()
  })
})

describe("platformAuth middleware", () => {
  it("passes through when there is no bearer token", async () => {
    const { next, res, resolver } = await run(undefined)

    expect(next).toHaveBeenCalledWith()
    expect(res.statusCode).toBe(200)
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it("passes a Medusa-native token (no iss) through untouched", async () => {
    const native = jwt.sign({ actor_id: "cus_native", actor_type: "customer" }, MEDUSA_JWT_SECRET)
    const { req, next, resolver } = await run(`Bearer ${native}`)

    expect(next).toHaveBeenCalledWith()
    expect(req.headers.authorization).toBe(`Bearer ${native}`)
    expect(req.auth_context).toBeUndefined()
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it("resolves a valid platform token to a customer and hands Medusa an equivalent token", async () => {
    const token = mint({ iss: "eaglesneaglets", sub: "user-1" }, SECRET_A)
    const { req, next, res } = await run(`Bearer ${token}`)

    expect(res.statusCode).toBe(200)
    expect(next).toHaveBeenCalledWith()
    expect(req.auth_context).toMatchObject({
      actor_id: "cus_1",
      actor_type: "customer",
      auth_identity_id: "authid_1",
      app_metadata: { customer_id: "cus_1" },
      user_metadata: {
        tenant: "eaglesneaglets",
        platform_user_id: "user-1",
        email: "member@example.com",
      },
    })

    const rewritten = extractBearerToken(req.headers.authorization as string)
    expect(rewritten).not.toBe(token)
    const verified = jwt.verify(rewritten as string, MEDUSA_JWT_SECRET, {
      algorithms: ["HS256"],
      clockTimestamp: nowSeconds,
    }) as jwt.JwtPayload
    expect(verified.actor_id).toBe("cus_1")
    expect(verified.actor_type).toBe("customer")
    expect(verified.exp).toBe(nowSeconds + 300)
  })

  it("resolves the same member to the same customer on every call", async () => {
    const resolver = makeResolver()
    const token = mint({ iss: "eaglesneaglets", sub: "user-1" }, SECRET_A)

    const first = await run(`Bearer ${token}`, resolver)
    const second = await run(`Bearer ${token}`, resolver)

    expect((first.req.auth_context as { actor_id: string }).actor_id).toBe("cus_1")
    expect((second.req.auth_context as { actor_id: string }).actor_id).toBe("cus_1")
  })

  it("resolves the same sub on two tenants to two different customers (collision guard)", async () => {
    const resolver = makeResolver()
    const a = mint({ iss: "eaglesneaglets", sub: "123" }, SECRET_A)
    const b = mint({ iss: "otherplatform", sub: "123" }, SECRET_B)

    const resA = await run(`Bearer ${a}`, resolver)
    const resB = await run(`Bearer ${b}`, resolver)

    const actorA = (resA.req.auth_context as { actor_id: string }).actor_id
    const actorB = (resB.req.auth_context as { actor_id: string }).actor_id
    expect(actorA).toBe("cus_1")
    expect(actorB).toBe("cus_2")
    expect(actorA).not.toBe(actorB)
  })

  it("never resolves identity by email", async () => {
    const resolver = makeResolver()
    const a = mint({ iss: "eaglesneaglets", sub: "user-1", email: "same@example.com" }, SECRET_A)
    const b = mint({ iss: "eaglesneaglets", sub: "user-2", email: "same@example.com" }, SECRET_A)

    const resA = await run(`Bearer ${a}`, resolver)
    const resB = await run(`Bearer ${b}`, resolver)

    expect((resA.req.auth_context as { actor_id: string }).actor_id).not.toBe(
      (resB.req.auth_context as { actor_id: string }).actor_id
    )
  })

  it.each([
    ["expired", mint({ iss: "eaglesneaglets", sub: "u", iat: nowSeconds - 900, exp: nowSeconds - 300 }, SECRET_A)],
    ["invalid_signature", mint({ iss: "eaglesneaglets", sub: "u" }, SECRET_B)],
    ["unknown_tenant", mint({ iss: "nobody", sub: "u" }, SECRET_A)],
    ["ttl_too_long", mint({ iss: "eaglesneaglets", sub: "u", exp: nowSeconds + 3600 }, SECRET_A)],
    ["missing_subject", mint({ iss: "eaglesneaglets" }, SECRET_A)],
  ])("responds 401 with code %s and does not call next", async (code, token) => {
    const { res, next, resolver } = await run(`Bearer ${token}`)

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ message: "Unauthorized", code })
    expect(next).not.toHaveBeenCalled()
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it("forwards resolver failures to the error handler", async () => {
    const failing = {
      resolve: jest.fn(async () => {
        throw new Error("database down")
      }),
      customers: new Map(),
    }
    const token = mint({ iss: "eaglesneaglets", sub: "user-1" }, SECRET_A)
    const { next, res } = await run(`Bearer ${token}`, failing as never)

    expect(res.statusCode).toBe(200)
    expect(next).toHaveBeenCalledTimes(1)
    expect((next.mock.calls[0][0] as Error).message).toBe("database down")
  })
})
