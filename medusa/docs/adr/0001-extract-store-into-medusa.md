# ADR 0001: Extract the store into a standalone Medusa service

Date: 2026-10-22
Status: Accepted

## Context

Eagles & Eaglets launched as a modular monolith (Django REST backend, React
frontend) by design, with the stated intent that major capabilities graduate
to their own services once that is justified. The store (`apps.store`) is the
first graduate. Three drivers:

- independent scaling of commerce traffic and the rest of the mentorship platform
- separate team ownership of the store, without access to the platform's admin
- reuse: the store is meant to serve other products later, not only Eagles & Eaglets

What made it tractable: nothing else imports `apps.store`, guest checkout was
already removed (every order has an authenticated member), and the module is
small (about 1,800 backend lines).

## Decision

Run Medusa v2 as its own deployable (own Postgres and Redis, own Railway
service, own admin UI) and connect it to consumer platforms over HTTP:

1. **Platforms stay the identity authority.** A platform mints a 5-minute
   HS256 store token (`iss` = tenant id, `sub` = platform user id, `email`,
   `exp`). Medusa validates it against the tenant's secret from
   `STORE_TENANTS` and maps the caller to a Medusa customer, created on first
   use. Identity is the `(iss, sub)` pair, never `sub` alone and never email.
   Medusa never sees a platform password and holds no roles for platform
   users; all store administration happens in Medusa's own admin with its
   own accounts.
2. **Paystack is a Medusa payment provider** (`src/modules/paystack`), porting
   the Django behaviour: pesewas, idempotent references, constant-time
   webhook verification, GHS.
3. **Medusa notifies the platform of order events** over signed webhooks and
   the platform keeps sending the emails it already owns templates for. A
   reconciliation job re-delivers recent paid orders; the platform
   deduplicates on deterministic event ids.
4. **The platform's store-admin screens are deleted**, not proxied. The store
   team works entirely in Medusa admin.

## Alternatives rejected

- **Medusa owns customer logins.** Two passwords per member. Unacceptable UX.
- **Proxy every store call through Django.** Keeps one auth path but defeats
  both the scaling and the reuse goals; a second platform would have to
  route through Eagles & Eaglets.
- **One shared secret for all tenants.** One compromised platform could forge
  customers on all others. Per-tenant secrets contain a leak and rotate
  independently.
- **Key customers on `sub` alone.** Two platforms will eventually both have a
  user id 123; their carts and order history would merge.
- **A Medusa auth-module provider instead of a middleware.** Idiomatic, but
  it forces the frontend into Medusa's two-step register flow and cannot
  create the customer inside the provider. The middleware keeps the plan's
  contract: the frontend sends the platform token and nothing else.

## Consequences

Accepted costs:

| Before (monolith) | After |
| --- | --- |
| `Cart.user` / `Order.user` are real foreign keys | Cross-service ids; consistency is enforced in application code (auth identity per `(tenant, sub)`, customer metadata) |
| Order to notification is an in-process signal | Signed webhook that can fail after payment succeeded; retries plus the reconciliation job |
| `@transaction.atomic` spans cart, order and stock | Distributed; Paystack success and local writes can diverge; the reconciliation job is the safety net |
| One deploy, one log stream, one backup | Two of each |
| Admin tiering enforced once | Medusa admin must be protected independently (strong passwords, MFA, `ADMIN_CORS` locked down); it is now the only way to change prices and fulfil orders |

Implementation findings that shaped the code:

- Medusa's built-in store routes only accept bearer tokens signed with
  Medusa's own `JWT_SECRET`. The platform-auth middleware therefore verifies
  the platform token, resolves the customer, then rewrites the request with
  an equivalent Medusa-signed token that inherits the platform token's
  expiry. Core routes (carts, orders, customers/me) work unchanged.
- Medusa keeps customer email unique per account type. Email can legitimately
  repeat across tenants, so when a second tenant brings an email that
  already belongs to another identity, that customer gets
  `local+tenant@domain` and the real address is stored in
  `metadata.platform_email`. Most mail providers deliver plus-addressed mail
  to the same inbox.
- Medusa has no order until the cart completes, so the Paystack reference is
  derived from the payment session id (underscores become hyphens; Paystack
  only allows `a-zA-Z0-9-.=`) and `metadata.session_id` is what the webhook
  uses to find the cart.

## Rollback

Flip `ENABLE_MEDUSA_STORE` off in the frontend and point the Paystack webhook
back at Django. Legacy store tables stay read-only, not dropped, for at least
30 days after cutover.
