import jwt from "jsonwebtoken"
import {
  peekIssuer,
  PLATFORM_TOKEN_MAX_TTL_SECONDS,
  platformIdentityKey,
  PlatformTokenError,
  verifyPlatformToken,
} from "../platform-token"
import { parseTenantRegistry } from "../store-tenants"

const SECRET_A = "tenant-a-secret-".padEnd(40, "a")
const SECRET_B = "tenant-b-secret-".padEnd(40, "b")

const registry = parseTenantRegistry(
  JSON.stringify({
    eaglesneaglets: { secret: SECRET_A },
    otherplatform: { secret: SECRET_B },
    retired: { secret: "c".repeat(40), active: false },
  })
)

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)
const nowSeconds = Math.floor(NOW / 1000)

type Claims = Record<string, unknown>

function mint(
  claims: Claims,
  secret: string,
  options: jwt.SignOptions = { algorithm: "HS256" }
): string {
  const present = Object.fromEntries(
    Object.entries(claims).filter(([, value]) => value !== undefined)
  )
  return jwt.sign(present, secret, options)
}

function validClaims(overrides: Claims = {}): Claims {
  return {
    iss: "eaglesneaglets",
    sub: "6f1c2a1e-0f1d-4a0e-9c47-6b1f4d2f3a11",
    email: "Member@Example.com",
    iat: nowSeconds,
    exp: nowSeconds + 300,
    ...overrides,
  }
}

function expectCode(fn: () => unknown, code: PlatformTokenError["code"]) {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformTokenError)
    expect((error as PlatformTokenError).code).toBe(code)
    return
  }
  throw new Error(`expected PlatformTokenError(${code}) to be thrown`)
}

describe("verifyPlatformToken", () => {
  it("resolves a valid token to its tenant, subject and normalised email", () => {
    const token = mint(validClaims(), SECRET_A)

    const identity = verifyPlatformToken(token, registry, { now: NOW })

    expect(identity.tenant.id).toBe("eaglesneaglets")
    expect(identity.platformUserId).toBe("6f1c2a1e-0f1d-4a0e-9c47-6b1f4d2f3a11")
    expect(identity.email).toBe("member@example.com")
    expect(identity.expiresAt).toBe(nowSeconds + 300)
  })

  it("treats a missing email as null", () => {
    const token = mint(validClaims({ email: undefined }), SECRET_A)
    expect(verifyPlatformToken(token, registry, { now: NOW }).email).toBeNull()
  })

  it("rejects an expired token", () => {
    const token = mint(
      validClaims({ iat: nowSeconds - 600, exp: nowSeconds - 60 }),
      SECRET_A
    )
    expectCode(() => verifyPlatformToken(token, registry, { now: NOW }), "expired")
  })

  it("rejects a tampered token", () => {
    const token = mint(validClaims(), SECRET_A)
    const [header, payload, signature] = token.split(".")
    const tampered = Buffer.from(
      JSON.stringify({ ...validClaims(), sub: "someone-else" })
    ).toString("base64url")

    expectCode(
      () => verifyPlatformToken(`${header}.${tampered}.${signature}`, registry, { now: NOW }),
      "invalid_signature"
    )
    expect(payload).not.toBe(tampered)
  })

  it("rejects a token signed with another tenant's secret", () => {
    const token = mint(validClaims(), SECRET_B)
    expectCode(() => verifyPlatformToken(token, registry, { now: NOW }), "invalid_signature")
  })

  it("rejects an unknown tenant", () => {
    const token = mint(validClaims({ iss: "nobody" }), SECRET_A)
    expectCode(() => verifyPlatformToken(token, registry, { now: NOW }), "unknown_tenant")
  })

  it("rejects an inactive tenant even with a valid signature", () => {
    const token = mint(validClaims({ iss: "retired" }), "c".repeat(40))
    expectCode(() => verifyPlatformToken(token, registry, { now: NOW }), "inactive_tenant")
  })

  it("rejects a token whose expiry is further out than the maximum TTL", () => {
    const token = mint(
      validClaims({ exp: nowSeconds + PLATFORM_TOKEN_MAX_TTL_SECONDS + 60 }),
      SECRET_A
    )
    expectCode(() => verifyPlatformToken(token, registry, { now: NOW }), "ttl_too_long")
  })

  it("rejects a token without an exp claim", () => {
    const token = mint(validClaims({ exp: undefined }), SECRET_A)
    expectCode(() => verifyPlatformToken(token, registry, { now: NOW }), "malformed")
  })

  it("rejects a token without a subject", () => {
    const token = mint(validClaims({ sub: undefined }), SECRET_A)
    expectCode(() => verifyPlatformToken(token, registry, { now: NOW }), "missing_subject")
  })

  it("rejects a token without an issuer", () => {
    const token = mint(validClaims({ iss: undefined }), SECRET_A)
    expectCode(() => verifyPlatformToken(token, registry, { now: NOW }), "malformed")
  })

  it("rejects garbage", () => {
    expectCode(() => verifyPlatformToken("not-a-jwt", registry, { now: NOW }), "malformed")
  })

  it("rejects algorithms other than HS256", () => {
    const token = mint(validClaims(), SECRET_A, { algorithm: "HS512" })
    expectCode(() => verifyPlatformToken(token, registry, { now: NOW }), "invalid_signature")
  })

  it("keeps identities apart when two tenants share a subject (collision guard)", () => {
    const sameSub = "123"
    const a = verifyPlatformToken(
      mint(validClaims({ iss: "eaglesneaglets", sub: sameSub }), SECRET_A),
      registry,
      { now: NOW }
    )
    const b = verifyPlatformToken(
      mint(validClaims({ iss: "otherplatform", sub: sameSub }), SECRET_B),
      registry,
      { now: NOW }
    )

    expect(a.platformUserId).toBe(b.platformUserId)
    expect(a.tenant.id).not.toBe(b.tenant.id)
    expect(platformIdentityKey(a.tenant.id, a.platformUserId)).not.toBe(
      platformIdentityKey(b.tenant.id, b.platformUserId)
    )
  })
})

describe("peekIssuer", () => {
  it("reads iss without verifying", () => {
    expect(peekIssuer(mint(validClaims(), "whatever-secret-it-is-not-checked"))).toBe(
      "eaglesneaglets"
    )
  })

  it("returns undefined for tokens without iss or for garbage", () => {
    expect(peekIssuer(mint({ actor_id: "cus_1" }, SECRET_A))).toBeUndefined()
    expect(peekIssuer("garbage")).toBeUndefined()
  })
})
