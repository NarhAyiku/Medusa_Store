import jwt, { TokenExpiredError } from "jsonwebtoken"
import type { StoreTenant, TenantRegistry } from "./store-tenants"

/**
 * Verification of platform-issued store tokens.
 *
 * A consumer platform mints a short-lived HS256 JWT for one of its members:
 *
 *   { "iss": "<tenant id>", "sub": "<platform user id>", "email": "...", "exp": <now + 300> }
 *
 * The tenant id selects the validation secret. Identity is the (iss, sub)
 * pair, never sub alone and never email: two platforms will eventually both
 * have a user id 123, and an email can legitimately repeat across tenants.
 */

export const PLATFORM_TOKEN_MAX_TTL_SECONDS = 300
export const PLATFORM_TOKEN_CLOCK_TOLERANCE_SECONDS = 5

/** Auth provider name under which platform members are stored in Medusa's auth module. */
export const PLATFORM_AUTH_PROVIDER = "platform"

export type PlatformTokenErrorCode =
  | "malformed"
  | "unknown_tenant"
  | "inactive_tenant"
  | "invalid_signature"
  | "expired"
  | "ttl_too_long"
  | "missing_subject"

export class PlatformTokenError extends Error {
  readonly code: PlatformTokenErrorCode

  constructor(code: PlatformTokenErrorCode, message: string) {
    super(message)
    this.name = "PlatformTokenError"
    this.code = code
  }
}

export type PlatformIdentity = {
  tenant: StoreTenant
  platformUserId: string
  email: string | null
  /** Token expiry as unix seconds. */
  expiresAt: number
}

export type VerifyPlatformTokenOptions = {
  /** Current time in milliseconds. Defaults to Date.now(). */
  now?: number
}

/**
 * Reads the `iss` claim without verifying the token. Used to decide whether
 * a bearer token is a platform token at all; a token without `iss` is left
 * for Medusa's own authentication to handle.
 */
export function peekIssuer(token: string): string | undefined {
  const decoded = jwt.decode(token, { json: true })
  return decoded && typeof decoded.iss === "string" && decoded.iss
    ? decoded.iss
    : undefined
}

export function verifyPlatformToken(
  token: string,
  registry: TenantRegistry,
  options: VerifyPlatformTokenOptions = {}
): PlatformIdentity {
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)

  const decoded = jwt.decode(token, { json: true })
  if (!decoded) {
    throw new PlatformTokenError("malformed", "Store token is not a well-formed JWT")
  }

  const issuer = decoded.iss
  if (typeof issuer !== "string" || !issuer) {
    throw new PlatformTokenError("malformed", "Store token has no iss claim")
  }

  const tenant = registry.get(issuer)
  if (!tenant) {
    throw new PlatformTokenError("unknown_tenant", `Unknown tenant "${issuer}"`)
  }
  if (!tenant.active) {
    throw new PlatformTokenError("inactive_tenant", `Tenant "${issuer}" is inactive`)
  }

  let payload: jwt.JwtPayload
  try {
    const verified = jwt.verify(token, tenant.secret, {
      algorithms: ["HS256"],
      issuer: tenant.id,
      clockTimestamp: nowSeconds,
      clockTolerance: PLATFORM_TOKEN_CLOCK_TOLERANCE_SECONDS,
    })
    if (typeof verified !== "object" || verified === null) {
      throw new PlatformTokenError("malformed", "Store token payload is not an object")
    }
    payload = verified
  } catch (error) {
    if (error instanceof PlatformTokenError) {
      throw error
    }
    if (error instanceof TokenExpiredError) {
      throw new PlatformTokenError("expired", "Store token has expired")
    }
    throw new PlatformTokenError("invalid_signature", "Store token signature is invalid")
  }

  if (typeof payload.exp !== "number") {
    throw new PlatformTokenError("malformed", "Store token has no exp claim")
  }
  if (
    payload.exp - nowSeconds >
    PLATFORM_TOKEN_MAX_TTL_SECONDS + PLATFORM_TOKEN_CLOCK_TOLERANCE_SECONDS
  ) {
    throw new PlatformTokenError(
      "ttl_too_long",
      `Store token expiry exceeds ${PLATFORM_TOKEN_MAX_TTL_SECONDS} seconds`
    )
  }

  const subject = payload.sub
  if (typeof subject !== "string" || !subject.trim()) {
    throw new PlatformTokenError("missing_subject", "Store token has no sub claim")
  }

  const rawEmail = (payload as Record<string, unknown>).email
  const email =
    typeof rawEmail === "string" && rawEmail.trim()
      ? rawEmail.trim().toLowerCase()
      : null

  return {
    tenant,
    platformUserId: subject.trim(),
    email,
    expiresAt: payload.exp,
  }
}

/**
 * The provider identity key for a platform member. Unique within the
 * "platform" auth provider, so the (iss, sub) pair maps to exactly one
 * Medusa auth identity and therefore one customer.
 */
export function platformIdentityKey(tenantId: string, platformUserId: string): string {
  return `${tenantId}:${platformUserId}`
}
