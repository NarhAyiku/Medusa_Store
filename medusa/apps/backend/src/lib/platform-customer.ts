import type {
  AuthIdentityDTO,
  IAuthModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { createCustomerAccountWorkflow } from "@medusajs/medusa/core-flows"
import {
  PLATFORM_AUTH_PROVIDER,
  platformIdentityKey,
  type PlatformIdentity,
} from "./platform-token"

/**
 * Maps a verified platform identity to a Medusa customer, creating one on
 * first use.
 *
 * Storage: one Medusa auth identity per (tenant, platform user id), held as a
 * provider identity with provider "platform" and entity_id "<tenant>:<sub>".
 * The auth module enforces (provider, entity_id) uniqueness, so the
 * cross-tenant collision guard is a database constraint, not just code.
 * The auth identity's app_metadata.customer_id points at the customer, which
 * also carries metadata.tenant and metadata.platform_user_id for admins.
 *
 * Email: Medusa keeps customer email unique per account type. Email is
 * display data here and can legitimately repeat across tenants, so when a
 * second tenant brings an email that already belongs to another identity the
 * customer is created with a plus-addressed alias
 * (local+tenant@domain) and the real address is kept in
 * metadata.platform_email.
 */

export type ResolvedPlatformCustomer = {
  customerId: string
  authIdentityId: string
}

export async function resolvePlatformCustomer(
  container: MedusaContainer,
  identity: PlatformIdentity
): Promise<ResolvedPlatformCustomer> {
  const authModule = container.resolve<IAuthModuleService>(Modules.AUTH)
  const entityId = platformIdentityKey(identity.tenant.id, identity.platformUserId)

  const existing = await findAuthIdentity(authModule, entityId)
  const existingCustomerId = customerIdOf(existing)
  if (existing && existingCustomerId) {
    return { customerId: existingCustomerId, authIdentityId: existing.id }
  }

  const authIdentity =
    existing ?? (await createAuthIdentity(authModule, entityId, identity))

  const customerId = await createCustomerForIdentity(
    container,
    authModule,
    authIdentity,
    identity
  )

  return { customerId, authIdentityId: authIdentity.id }
}

function customerIdOf(authIdentity: AuthIdentityDTO | null | undefined): string | null {
  const value = authIdentity?.app_metadata?.customer_id
  return typeof value === "string" && value ? value : null
}

async function findAuthIdentity(
  authModule: IAuthModuleService,
  entityId: string
): Promise<AuthIdentityDTO | null> {
  const [found] = await authModule.listAuthIdentities(
    {
      provider_identities: {
        provider: PLATFORM_AUTH_PROVIDER,
        entity_id: entityId,
      },
    },
    { take: 1 }
  )
  return found ?? null
}

async function createAuthIdentity(
  authModule: IAuthModuleService,
  entityId: string,
  identity: PlatformIdentity
): Promise<AuthIdentityDTO> {
  try {
    return await authModule.createAuthIdentities({
      provider_identities: [
        {
          provider: PLATFORM_AUTH_PROVIDER,
          entity_id: entityId,
          user_metadata: {
            tenant: identity.tenant.id,
            platform_user_id: identity.platformUserId,
            email: identity.email,
          },
        },
      ],
    })
  } catch (error) {
    // Two first-use requests for the same member can race; the unique index on
    // (provider, entity_id) makes the loser fail. Re-read instead of failing.
    const winner = await findAuthIdentity(authModule, entityId)
    if (winner) {
      return winner
    }
    throw error
  }
}

async function createCustomerForIdentity(
  container: MedusaContainer,
  authModule: IAuthModuleService,
  authIdentity: AuthIdentityDTO,
  identity: PlatformIdentity
): Promise<string> {
  const email = identity.email ?? placeholderEmail(identity)
  const baseMetadata = {
    tenant: identity.tenant.id,
    platform_user_id: identity.platformUserId,
  }

  try {
    return await runCreateCustomerAccount(container, authIdentity.id, {
      email,
      metadata: baseMetadata,
    })
  } catch (error) {
    if (!isDuplicateEmailError(error)) {
      throw error
    }
  }

  // The email is taken. Either a concurrent request for this same identity
  // already created the customer, or another identity (typically on another
  // tenant) owns the address.
  const refreshed = await authModule.retrieveAuthIdentity(authIdentity.id)
  const concurrentCustomerId = customerIdOf(refreshed)
  if (concurrentCustomerId) {
    return concurrentCustomerId
  }

  return runCreateCustomerAccount(container, authIdentity.id, {
    email: aliasEmail(email, identity.tenant.id),
    metadata: { ...baseMetadata, platform_email: email },
  })
}

async function runCreateCustomerAccount(
  container: MedusaContainer,
  authIdentityId: string,
  customerData: { email: string; metadata: Record<string, unknown> }
): Promise<string> {
  const { result } = await createCustomerAccountWorkflow(container).run({
    input: {
      authIdentityId,
      customerData: { ...customerData, has_account: true },
    },
  })
  return result.id
}

/**
 * Duck-typed on purpose: errors thrown inside a workflow step do not always
 * survive as `MedusaError` instances by the time `run()` rethrows them.
 */
function isDuplicateEmailError(error: unknown): boolean {
  const err = error as { type?: string; code?: string; message?: string } | null
  if (!err) {
    return false
  }
  if (err.type === MedusaError.Types.DUPLICATE_ERROR || err.code === "23505") {
    return true
  }
  return /already (has an account|exists)|duplicate key|unique constraint/i.test(
    err.message ?? ""
  )
}

/**
 * local+tenant@domain: still delivered to the same inbox by most providers
 * and unique per tenant within Medusa's customer table.
 */
export function aliasEmail(email: string, tenantId: string): string {
  const at = email.lastIndexOf("@")
  if (at <= 0) {
    return `${email}+${tenantId}`
  }
  return `${email.slice(0, at)}+${tenantId}${email.slice(at)}`
}

/**
 * Medusa requires an email to create a customer account. A platform token
 * without an email claim gets an undeliverable, tenant-scoped placeholder.
 */
export function placeholderEmail(identity: Pick<PlatformIdentity, "tenant" | "platformUserId">): string {
  const local = identity.platformUserId.replace(/[^a-zA-Z0-9._-]/g, "-")
  return `${local}@${identity.tenant.id}.platform.invalid`
}
