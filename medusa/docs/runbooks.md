# Runbooks

Operational procedures for the Medusa store service. Paths are relative to
`Medusa_Store/medusa`.

## 1. Deploying Medusa

Railway builds `Dockerfile` at the monorepo root (`railway.json` points at
it). The container runs `medusa db:migrate` and then `medusa start` on
every deploy; migrations are idempotent.

Environment variables the service needs:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Railway Postgres plugin |
| `REDIS_URL` | Railway Redis plugin |
| `JWT_SECRET`, `COOKIE_SECRET` | Medusa's own secrets; long random strings, never equal to any tenant secret |
| `STORE_CORS` | The consumer platforms' storefront origins |
| `ADMIN_CORS`, `AUTH_CORS` | The Medusa admin origin only |
| `STORE_TENANTS` | JSON tenant registry (see runbook 2 and `.env.template`) |
| `PAYSTACK_SECRET_KEY` | Paystack secret key; the provider is only registered when set |
| `PAYSTACK_CALLBACK_URL` | Where Paystack returns the customer after paying |
| `PLATFORM_EVENTS_RECONCILE_HOURS` | Optional, default 24 |

First deploy only:

```sh
npx medusa user -e <store admin email> -p <strong password>   # inside the service shell
npx medusa exec ./src/scripts/setup-ghana-region.ts            # region, currency, delivery zone
```

Then register the Paystack webhook (test mode until cutover):

```
POST https://<medusa host>/hooks/payment/pp_paystack_paystack
```

Verify: `GET /health` returns 200, the admin loads at `/app`, and
`GET /store/customers/me` with a platform token returns the member.

Local development:

```sh
brew services start postgresql@17 redis
cd apps/backend && npm exec medusa db:migrate && npm run dev     # http://localhost:9000, admin at /app
cd apps/storefront && npm run dev                                # http://localhost:8000 (preview storefront)
```

## 2. Onboarding a new consumer platform (tenant)

1. Generate a tenant secret (at least 32 characters) and an events secret:

   ```sh
   openssl rand -hex 32   # tenant secret
   openssl rand -hex 32   # events secret
   ```

2. Add the tenant to `STORE_TENANTS` on the Medusa service and redeploy:

   ```json
   {
     "eaglesneaglets": { "...": "existing tenant unchanged" },
     "newplatform": {
       "name": "New Platform",
       "secret": "<tenant secret>",
       "active": true,
       "events_url": "https://newplatform.example/api/v1/store/events/",
       "events_secret": "<events secret>"
     }
   }
   ```

   Tenant ids are lowercase slugs. The service refuses to boot a registry
   with a short secret, a secret shared between tenants, or a secret equal
   to `JWT_SECRET` / `COOKIE_SECRET`.

3. The new platform implements its own `/store-token/` equivalent: an
   authenticated endpoint that returns

   ```json
   { "iss": "newplatform", "sub": "<its user id>", "email": "...", "exp": <now + 300> }
   ```

   signed HS256 with the tenant secret. Expiry further than 5 minutes out is
   rejected.

4. The platform implements an events receiver at `events_url` that verifies
   `X-Store-Signature` (`sha256=` HMAC-SHA256 of `"<X-Store-Timestamp>.<body>"`
   with the events secret), rejects stale timestamps, and ignores repeated
   `X-Store-Event-Id` values.

5. Verify with the collision test: mint a token for the new tenant with the
   same `sub` as an existing member of another tenant and confirm
   `GET /store/customers/me` returns a different customer id for each.
   `integration-tests/http/platform-auth.spec.ts` is the reference.

## 3. Rotating a tenant secret

1. Generate the new secret.
2. Deploy the platform with the new secret first, so tokens it mints from now
   on use it. Tokens already issued expire within 5 minutes.
3. Update `STORE_TENANTS` on Medusa with the new secret and redeploy.
   Expect at most 5 minutes of 401s with `code: "invalid_signature"` for
   members holding old tokens; the frontend refetches a token on 401.
4. If the order of steps 2 and 3 cannot be guaranteed, do step 3 first and
   step 2 immediately after; the window is the same.

Rotating the events secret works the same way in reverse: update Medusa's
`events_secret` and the platform's verifier in the same window. Failed
deliveries during the window are healed by the reconciliation job.

Deactivating a tenant: set `"active": false`. Its tokens are rejected with
`code: "inactive_tenant"` and its events are no longer delivered.

## 4. Replaying failed order webhooks

Every delivery failure is logged as

```
[platform-events] failed to deliver <event id> to <tenant> after N attempts (<reason>); reconciliation will pick it up
```

The reconciliation job (`src/jobs/reconcile-platform-orders.ts`, hourly)
re-delivers `order.placed` for paid orders updated in the last
`PLATFORM_EVENTS_RECONCILE_HOURS` hours. The platform deduplicates on event
id, so replays are safe. Its summary line is

```
[platform-reconciliation] scanned=.. delivered=.. skipped=.. failed=.. since=..
```

and it is logged at error level with `failed_orders=<ids>` when anything
still fails. Alert on that line.

To replay further back or on demand, run it with a wider window:

```sh
PLATFORM_EVENTS_RECONCILE_HOURS=168 npx medusa exec ./src/scripts/reconcile-now.ts
```

The script exits non-zero when any order is still undelivered.

`skipped` counts orders without a platform tenant (for example orders placed
from the Medusa admin) and tenants with no `events_url`; those are expected.

## 5. Paystack

- Test mode: `PAYSTACK_SECRET_KEY=sk_test_...`, webhook pointed at the
  staging service. A real test-mode transaction must move an order to paid
  before cutover.
- Cutover: swap to `sk_live_...` and repoint the live webhook from Django to
  Medusa in the same change. Until then Django owns the live webhook.
- The webhook route always answers 200 and queues the event; verification
  happens in Medusa's payment webhook subscriber. A bad signature shows up
  as `Invalid Paystack webhook signature` in the logs and nothing is
  captured.
- Refunds are issued from the Medusa admin and go through Paystack's
  `/refund` endpoint in minor units.
