import type {
  AuthContext,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { ConfigModule, Logger } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import jwt from "jsonwebtoken"
import { resolvePlatformCustomer } from "../../lib/platform-customer"
import {
  peekIssuer,
  PlatformTokenError,
  verifyPlatformToken,
  type PlatformIdentity,
} from "../../lib/platform-token"
import { getTenantRegistry, type TenantRegistry } from "../../lib/store-tenants"

/**
 * Platform authentication for /store routes.
 *
 * Consumer platforms stay the identity authority for their members. The
 * frontend calls Medusa with a platform-minted store token; this middleware
 * validates it against the tenant's secret, maps the caller to a Medusa
 * customer and then hands Medusa's own customer authentication an equivalent
 * Medusa-signed token, so every built-in store route (carts, orders,
 * customers/me) works unchanged.
 *
 * Tokens without an `iss` claim are not platform tokens (for example a
 * Medusa-native customer JWT) and are passed through untouched.
 */

export type PlatformAuthOptions = {
  registry?: () => TenantRegistry
  resolveCustomer?: typeof resolvePlatformCustomer
  now?: () => number
}

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null
  }
  const match = authorization.match(/^\s*bearer\s+(\S+)\s*$/i)
  return match ? match[1] : null
}

export function platformAuth(options: PlatformAuthOptions = {}) {
  const getRegistry = options.registry ?? getTenantRegistry
  const resolveCustomer = options.resolveCustomer ?? resolvePlatformCustomer
  const now = options.now ?? Date.now

  return async function platformAuthMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ): Promise<void> {
    const token = extractBearerToken(req.headers.authorization)
    if (!token || !peekIssuer(token)) {
      return next()
    }

    let identity: PlatformIdentity
    try {
      identity = verifyPlatformToken(token, getRegistry(), { now: now() })
    } catch (error) {
      if (error instanceof PlatformTokenError) {
        const logger = req.scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
        logger.debug(`Rejected platform store token: ${error.code} (${error.message})`)
        res.status(401).json({ message: "Unauthorized", code: error.code })
        return
      }
      return next(error)
    }

    try {
      const { customerId, authIdentityId } = await resolveCustomer(req.scope, identity)
      const authContext: AuthContext = {
        actor_id: customerId,
        actor_type: "customer",
        auth_identity_id: authIdentityId,
        app_metadata: { customer_id: customerId },
        user_metadata: {
          tenant: identity.tenant.id,
          platform_user_id: identity.platformUserId,
          email: identity.email,
        },
      }

      const config = req.scope.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE)
      const jwtSecret = config.projectConfig.http.jwtSecret
      if (!jwtSecret) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "projectConfig.http.jwtSecret is not configured"
        )
      }

      // The Medusa-signed token inherits the platform token's expiry exactly,
      // so a member never holds a Medusa credential that outlives the token
      // the platform minted for them.
      ;(req as MedusaRequest & { auth_context: AuthContext }).auth_context = authContext
      req.headers.authorization = `Bearer ${jwt.sign(
        { ...authContext, exp: identity.expiresAt },
        jwtSecret,
        { algorithm: "HS256" }
      )}`

      return next()
    } catch (error) {
      return next(error)
    }
  }
}
