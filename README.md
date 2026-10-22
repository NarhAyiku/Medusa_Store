# Medusa Store

Standalone commerce service extracted from the Eagles & Eaglets Django
`apps.store` module, built to the plan in `../Medusa-Store-Extraction-Plan.pdf`.
Medusa is a multi-tenant store API: Eagles & Eaglets is its first consumer
platform, not its only one.

## Layout

```
Medusa_Store/
└── medusa/                      Turborepo monorepo (npm workspaces)
    ├── apps/backend/            Medusa 2.22 service (API, admin, modules, jobs)
    │   ├── src/api/middlewares/platform-auth.ts   validates platform-minted store tokens
    │   ├── src/lib/                                tenant registry, token verification,
    │   │                                           customer resolution, order events, reconciliation
    │   ├── src/modules/paystack/                   Paystack payment provider (GHS)
    │   ├── src/subscribers/                        order events delivered back to the platform
    │   ├── src/jobs/                               hourly reconciliation
    │   └── src/scripts/                            setup-ghana-region, reconcile-now
    ├── apps/storefront/         Medusa Next.js starter: a live preview of the customer side.
    │                            The production storefront is the Eagles & Eaglets React app.
    ├── docs/                    field-mapping, ADR, runbooks
    ├── Dockerfile, railway.json Railway deploy
    └── AGENTS.md                conventions for this repo
```

## Run it locally

```sh
brew services start postgresql@17 redis
cd medusa/apps/backend
cp .env.template .env            # then set DATABASE_URL=postgres://localhost:5432/medusa_store
npm exec medusa db:migrate
npm exec medusa user -- -e admin@local.test -p <password>
npm run dev                      # API http://localhost:9000, admin http://localhost:9000/app

cd ../storefront
npm run dev                      # http://localhost:8000 (needs NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY in .env.local)
```

Ghana region, GHS currency and delivery options:

```sh
cd medusa/apps/backend
GHANA_SEED_PRICES_FROM_EUR_RATE=16 npx medusa exec ./src/scripts/setup-ghana-region.ts
```

## Tests

```sh
cd medusa/apps/backend
npm run test:unit                                   # fast, no database
DB_USERNAME=postgres npm run test:integration:http  # boots the app against local Postgres
npm run lint && npx tsc --noEmit
```

## How the pieces fit

- **Identity**: the platform mints a 5-minute HS256 token (`iss` tenant id,
  `sub` user id, `email`). `platform-auth.ts` verifies it with the tenant's
  secret from `STORE_TENANTS`, resolves or creates the Medusa customer for
  the `(iss, sub)` pair, and hands Medusa's own auth an equivalent token.
- **Payments**: `src/modules/paystack` charges in pesewas, uses the payment
  session as the Paystack reference, and verifies webhooks in constant time.
  Webhook URL: `/hooks/payment/pp_paystack_paystack`.
- **Order events**: subscribers POST signed `order.*` events to the tenant's
  `events_url`; the hourly job replays recent paid orders so a lost webhook
  never loses an email.
- **Admin**: all store administration happens in Medusa admin. The platform
  keeps no store-admin screens.

See `medusa/docs/adr/0001-extract-store-into-medusa.md` for the decision
record and `medusa/docs/runbooks.md` for deploy, tenant onboarding, secret
rotation and webhook replay procedures.

## Status against the plan

| Task | Status |
| --- | --- |
| 1 Bootstrap Medusa | Done locally (scaffold, migrations, health 200, admin). Railway provisioning pending. |
| 2 Catalog parity | Field mapping documented; Ghana/GHS region script. |
| 3 Django mints store tokens | Blocked: Django repo not in this workspace. |
| 4 Medusa validates platform tokens | Done, unit + integration tested (collision guard included). |
| 5 Paystack provider | Done, unit + integration tested. Test-key end-to-end pending real keys. |
| 6 Order events | Medusa side done. Django receiver blocked on the Django repo. |
| 7, 8, 9 Frontend cutover and admin retirement | Blocked: React repo not in this workspace. |
| 10 Data migration | Import script pending (needs the legacy schema). |
| 11 Reconciliation job | Done. |
| 12 Documentation | ADR and runbooks here; CLAUDE.md update belongs in the platform repo. |
