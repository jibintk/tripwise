# Tripwise

Multi-channel travel booking platform: one booking engine and supplier layer, sold through B2B agent portals, corporate travel (B2E), a B2C website, a front-office desk (POS) and an AI agent.

This repository follows the Tripwise Development Kickoff Pack (architecture, requirements, data model, API contracts, NFRs, standards, delivery plan, QA strategy).

## What works today (v0.1)

The first vertical slice: an agency searches flights, books, pays from its wallet and gets a ticket.

- **Agency hierarchy**: operator → GSA → agencies → branches, stored as a Postgres `ltree`. Admins create children only under themselves.
- **Auth**: email/password login issuing a JWT that carries tenant, path and roles. Keycloak replaces the login in a later sprint; the claims stay the same.
- **Pricing engine**: markup rules per tenant (percent or fixed, by product, channel, supplier, route, cabin). The most specific rule wins at each level, and markups compound down the chain. The booking agency's own markup is its margin.
- **Supplier gateway**: one `FlightSupplier` interface for every content source, with a timeout and a circuit breaker per supplier. A deterministic mock supplier is used for development and tests.
- **Flight search**: parallel fan-out to suppliers, results cached by normalised search key (Redis, or in memory locally), priced per caller, cheapest first. Supplier net prices are shown to the operator only.
- **Booking saga**: reprice → hold → pay → ticket → confirm, with every step logged as an event. Payment is idempotent and race-safe. A ticketing failure after payment is retried, then refunded automatically.
- **Ledger**: double-entry, append-only. Wallet balance plus credit limit decides what an agency can spend. Operator finance tops up wallets.
- **Errors**: every error is `application/problem+json` with a stable `code` and a `traceId`.

## Repository layout

```
apps/
  api/                 NestJS core app (modular monolith)
    src/
      auth/            login, JWT guard, roles
      tenancy/         agency hierarchy
      pricing/         markup rules and the pricing engine
      payments/        wallets and double-entry ledger
      flights/         search, supplier registry, cache
      bookings/        booking saga
      db/              SQL migrations, migration runner, seed data
    test/              integration tests against a real Postgres
packages/
  contracts/           canonical models (Money, FlightOffer, ...), supplier interface, error codes
  supplier-gateway/    resilience (timeouts, circuit breaker) and supplier adapters (mock for now)
```

## Run it locally

Requirements: Node.js 22, pnpm 10, Docker.

```bash
pnpm install
docker compose up -d                     # Postgres, Redis, Mailpit
cp .env.example apps/api/.env
pnpm --filter "./packages/**" build
pnpm db:migrate
pnpm db:seed
pnpm dev:api                             # http://localhost:4000/api/v1
```

Seeded users (password `Password123!`):

| User | Tenant | Roles |
| --- | --- | --- |
| admin@tripwise.dev | Tripwise Travel (operator) | admin, finance, ops |
| gsa@tripwise.dev | Kenya GSA | admin |
| owner@safaridesk.dev | Safari Desk Travel (agency) | admin, agent |
| agent@safaridesk.dev | Safari Desk Travel (agency) | agent |
| agent@coastways.dev | Coastways Tours (agency) | agent |

Safari Desk starts with USD 5,000 plus a USD 1,000 credit line; Coastways with USD 500.

### Try the flow with curl

```bash
TOKEN=$(curl -s localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"agent@safaridesk.dev","password":"Password123!"}' | jq -r .accessToken)

curl -s localhost:4000/api/v1/flights/searches -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"origin":"NBO","destination":"DXB","departureDate":"2026-12-10","passengers":{"ADT":1}}' | jq '.offers[0]'

curl -s localhost:4000/api/v1/bookings -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"offerId":"<offerId>","passengers":[{"type":"ADT","title":"MR","firstName":"James","lastName":"Odhiambo","dateOfBirth":"1988-04-12"}],"contact":{"email":"james@example.com","phone":"+254700000001"}}'

curl -s -X POST localhost:4000/api/v1/bookings/<reference>/payments -H "authorization: Bearer $TOKEN"
```

### Mock supplier test hooks

The mock supplier simulates failures from the passenger's last name: `SOLDOUT` (hold fails), `BADDATA` (passenger rejected), `TICKETFAIL` (ticketing fails after payment, which triggers the automatic refund). Searches to `MBA` change price at reprice, to exercise `PRICE_CHANGED`.

## Tests

```bash
pnpm test
```

API integration tests need a Postgres database; they reset it on every run. Default: `postgres://tripwise:tripwise@localhost:5432/tripwise_test` (override with `TEST_DATABASE_URL`). Create it once with `docker compose exec postgres createdb -U tripwise tripwise_test`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /api/v1/auth/login | Get a token |
| GET | /api/v1/auth/me | Current user |
| GET / POST | /api/v1/tenants | List subtree / create a child tenant |
| GET / POST / DELETE | /api/v1/pricing/rules | Own markup rules |
| GET | /api/v1/accounts/me, /accounts/me/ledger | Wallet summary and statement |
| POST | /api/v1/accounts/{tenantId}/topups | Operator finance tops up a wallet |
| POST | /api/v1/flights/searches | Search flights |
| GET | /api/v1/flights/offers/{offerId}/rules | Fare rules |
| POST | /api/v1/flights/offers/{offerId}/reprice | Live price check |
| POST | /api/v1/bookings | Hold a booking (Idempotency-Key required) |
| GET | /api/v1/bookings, /bookings/{ref} | List and view bookings in scope |
| POST | /api/v1/bookings/{ref}/payments | Pay from wallet and ticket |
| POST | /api/v1/bookings/{ref}/cancel | Cancel a held booking |
| GET | /health | Liveness |

## Next steps

Following the delivery plan, Phase 1:

1. B2B portal screens for search, booking and wallet (Next.js).
2. Recovery job for bookings left in `ticketing` by a crash, and hold-expiry sweeps.
3. Outbox table and Kafka events (`booking.confirmed`, ...), then e-ticket PDFs and email.
4. First real flight adapter once the supplier is chosen, behind the same `FlightSupplier` interface.
5. Keycloak for login, Postgres row-level security as a second tenant guard.
6. Hotel module and hotel content mapping.
