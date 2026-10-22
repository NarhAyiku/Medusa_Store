import { MedusaError } from "@medusajs/framework/utils"

/**
 * Tenant registry for consumer platforms (STORE_TENANTS).
 *
 * Each consumer platform (Eagles & Eaglets first) is a tenant. The platform
 * mints short-lived HS256 store tokens for its own members, signed with the
 * tenant secret registered here. Adding a platform is a config change plus a
 * new secret, never a code change.
 *
 * STORE_TENANTS is a JSON object keyed by tenant id:
 *
 *   {
 *     "eaglesneaglets": {
 *       "name": "Eagles & Eaglets",
 *       "secret": "<at least 32 chars, unique to this tenant>",
 *       "active": true,
 *       "events_url": "https://platform.example/api/v1/store/events/",
 *       "events_secret": "<HMAC secret for order events sent to the platform>"
 *     }
 *   }
 *
 * An array of objects carrying an "id" field is accepted as well.
 */

export type StoreTenant = {
  id: string
  name: string
  secret: string
  active: boolean
  eventsUrl: string | null
  eventsSecret: string | null
}

export type TenantRegistry = ReadonlyMap<string, StoreTenant>

export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/
export const MIN_TENANT_SECRET_LENGTH = 32

export type ParseTenantRegistryOptions = {
  /**
   * Secrets a tenant secret must never equal, e.g. Medusa's own JWT_SECRET
   * and COOKIE_SECRET. A tenant secret that matched one of them would let a
   * platform mint tokens Medusa itself trusts.
   */
  reservedSecrets?: Array<string | undefined | null>
}

type RawTenant = Record<string, unknown>

function invalid(message: string): MedusaError {
  return new MedusaError(MedusaError.Types.INVALID_DATA, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toEntries(parsed: unknown): RawTenant[] {
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => {
      if (!isPlainObject(entry)) {
        throw invalid("STORE_TENANTS array entries must be objects")
      }
      return entry
    })
  }

  if (isPlainObject(parsed)) {
    return Object.entries(parsed).map(([id, value]) => {
      if (!isPlainObject(value)) {
        throw invalid(`STORE_TENANTS entry "${id}" must be an object`)
      }
      return { ...value, id }
    })
  }

  throw invalid("STORE_TENANTS must be a JSON object keyed by tenant id")
}

function optionalString(value: unknown, field: string, tenantId: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null
  }
  if (typeof value !== "string") {
    throw invalid(`STORE_TENANTS tenant "${tenantId}": ${field} must be a string`)
  }
  return value
}

export function parseTenantRegistry(
  raw: string | undefined | null,
  options: ParseTenantRegistryOptions = {}
): TenantRegistry {
  const registry = new Map<string, StoreTenant>()

  if (!raw || !raw.trim()) {
    return registry
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw invalid("STORE_TENANTS is not valid JSON")
  }

  const reserved = new Set(
    (options.reservedSecrets ?? []).filter((s): s is string => !!s)
  )
  const seenSecrets = new Set<string>()

  for (const entry of toEntries(parsed)) {
    const id = entry.id
    if (typeof id !== "string" || !TENANT_ID_PATTERN.test(id)) {
      throw invalid(
        `STORE_TENANTS tenant id "${String(id)}" is invalid: use lowercase letters, digits, "-" or "_" (max 63 chars)`
      )
    }
    if (registry.has(id)) {
      throw invalid(`STORE_TENANTS tenant "${id}" is defined more than once`)
    }

    const secret = entry.secret
    if (typeof secret !== "string" || secret.length < MIN_TENANT_SECRET_LENGTH) {
      throw invalid(
        `STORE_TENANTS tenant "${id}": secret must be a string of at least ${MIN_TENANT_SECRET_LENGTH} characters`
      )
    }
    if (reserved.has(secret)) {
      throw invalid(
        `STORE_TENANTS tenant "${id}": secret must differ from Medusa's own JWT_SECRET and COOKIE_SECRET`
      )
    }
    if (seenSecrets.has(secret)) {
      throw invalid(
        `STORE_TENANTS tenant "${id}": secret is shared with another tenant; every tenant needs its own secret`
      )
    }
    seenSecrets.add(secret)

    const active = entry.active === undefined ? true : entry.active
    if (typeof active !== "boolean") {
      throw invalid(`STORE_TENANTS tenant "${id}": active must be a boolean`)
    }

    const name = optionalString(entry.name, "name", id) ?? id
    const eventsUrl = optionalString(entry.events_url, "events_url", id)
    const eventsSecret = optionalString(entry.events_secret, "events_secret", id)

    if (eventsUrl && !eventsSecret) {
      throw invalid(
        `STORE_TENANTS tenant "${id}": events_secret is required when events_url is set`
      )
    }

    registry.set(id, { id, name, secret, active, eventsUrl, eventsSecret })
  }

  return registry
}

let cachedRegistry: TenantRegistry | null = null

/**
 * Registry parsed from the process environment, parsed once per process.
 * Use `resetTenantRegistryCache()` in tests that change the environment.
 */
export function getTenantRegistry(env: NodeJS.ProcessEnv = process.env): TenantRegistry {
  if (!cachedRegistry) {
    cachedRegistry = parseTenantRegistry(env.STORE_TENANTS, {
      reservedSecrets: [env.JWT_SECRET, env.COOKIE_SECRET],
    })
  }
  return cachedRegistry
}

export function resetTenantRegistryCache(): void {
  cachedRegistry = null
}
