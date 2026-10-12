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
- **Hotels**: search across several suppliers with one result per physical hotel (content mapping by name, city and location), identical rooms collapsed to the best rate, hotel markups, a 20-minute price lock, booking at payment (never retried, to avoid double reservations), vouchers, and cancellation with supplier penalties deducted from the refund.
- **Events and email**: every booking state change is written to a transactional outbox and delivered to subscribers; customers get emails for holds, tickets, expiries and failures (Mailpit catches them locally).
- **Background jobs**: hold-expiry sweep (releases seats), recovery of bookings stuck in ticketing after a crash, outbox delivery and email sending. Safe to run on several API instances.
- **E-ticket PDF** download for ticketed bookings.
- **Back office**: agencies tree (create, suspend with immediate lock-out), users with one-time passwords, markup rules, wallets with top-ups and credit lines (operator finance), and an operations queue for failed or stuck bookings.
- **Corporate travel (B2E)**: travel policies per employee grade (cabin, fare cap, booking window, refundable fares, hotel stars and nightly cap). Search results are marked in or out of policy and the lowest fare is highlighted. Out-of-policy trips need a reason and, depending on the policy, go to the employee's approver, who decides in the portal or with a one-click link in the email (single-use, 48 hours). Approved trips are paid from the company account and ticketed straight away; if the price changed while waiting, nothing is booked. Travel managers set policies, grades, cost centres and approvers, and see spend, compliance and missed savings per traveller.
- **Own flight inventory**: the operator loads blocked seats, charters and airline (A2A) contracts as dated series with a net fare, capacity and a release date. They are sold through the normal flight search and booking flow next to GDS content, with the usual markups, one-way or return. Seat counts change under a row lock, so the last seat can never be sold twice; unpaid holds are released by the expiry job, and ticketing issues the operator's own ticket numbers. The back office shows load per flight, lets the operator change fares and capacity or close a flight, and exports the passenger manifest (CSV) for name submission to the airline.
- **Travel insurance**: plans agreed with insurers (coverage, net rates by trip length, age limits and senior loading) are quoted for a trip, priced through the markup chain, held, paid and issued by the insurer, with a certificate PDF. Insurance can be added from a ticketed flight (dates, travellers and area of cover are filled in) and cancelled for a full refund until cover starts.
- **B2B partner portal** (Next.js): sign in, search flights and hotels, enter travellers or guests, hold, pay and ticket or book, download e-tickets and vouchers, see bookings and the wallet statement. Price changes, expired fares and insufficient funds are handled on screen.

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
  web-portal/          Next.js portal for agencies, corporate travellers and back office, by role
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
pnpm dev:portal                          # http://localhost:3000 (in a second terminal)
```

The portal reads the API address from `NEXT_PUBLIC_API_URL` (default `http://localhost:4000/api/v1`).

Seeded users (password `Password123!`):

| User | Tenant | Roles |
| --- | --- | --- |
| admin@tripwise.dev | Tripwise Travel (operator) | admin, finance, ops |
| gsa@tripwise.dev | Kenya GSA | admin |
| owner@safaridesk.dev | Safari Desk Travel (agency) | admin, agent |
| agent@safaridesk.dev | Safari Desk Travel (agency) | agent |
| agent@coastways.dev | Coastways Tours (agency) | agent |
| manager@acme.dev | Acme Kenya (corporate) | travel manager (admin), traveller |
| approver@acme.dev | Acme Kenya (corporate) | approver, traveller |
| staff@acme.dev | Acme Kenya (corporate) | traveller, staff grade (approver: approver@acme.dev) |
| exec@acme.dev | Acme Kenya (corporate) | traveller, executive grade (no approval needed) |

Safari Desk starts with USD 5,000 plus a USD 1,000 credit line; Coastways with USD 500; Acme Kenya has a USD 20,000 company account.

Own inventory is seeded on NBO–ZNZ (KQ480/481, four days a week) and a Saturday Masai Mara charter (NBO–MRE, XK701/702); search those routes to see it next to the mock supplier. Flights inside their release window show as released.

To see an approval, sign in as staff@acme.dev, search a business-class flight, give a reason and send it. Without `SMTP_URL` the approval email (with its one-click link) is printed in the API log; or sign in as approver@acme.dev and open Approvals.

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

The mock hotel suppliers use the lead guest's last name the same way: `SOLDOUT` and `BOOKFAIL`; hotels in `MBA` change price at the price check. The mock flight supplier simulates failures from the passenger's last name: `SOLDOUT` (hold fails), `BADDATA` (passenger rejected), `TICKETFAIL` (ticketing fails after payment, which triggers the automatic refund). Searches to `MBA` change price at reprice, to exercise `PRICE_CHANGED`. The mock insurer declines any policy with a traveller named `POLICYFAIL`.

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
| POST | /api/v1/bookings/{ref}/cancel | Cancel a held booking, or a confirmed hotel stay |
| POST | /api/v1/hotels/searches | Search hotels (one result per property) |
| GET | /api/v1/hotels/searches/{searchId}/hotels/{hotelId} | Room offers for one hotel |
| POST | /api/v1/hotels/bookings | Hold a hotel price (Idempotency-Key required) |
| GET | /api/v1/bookings/{ref}/document.pdf | E-ticket (flights) or voucher (hotels) |
| PATCH | /api/v1/tenants/{id} | Suspend or reactivate |
| GET / POST | /api/v1/tenants/{id}/users | List / create users |
| GET | /api/v1/accounts | Wallets in scope (admin, finance) |
| PUT | /api/v1/accounts/{tenantId}/credit-limit | Set a credit line (operator finance) |
| GET | /api/v1/ops/queue | Failed and stuck bookings |
| POST | /api/v1/ops/bookings/{ref}/resolve | Record what operations did |
| POST | /api/v1/ops/jobs/run | Run background jobs now (operator admin) |
| GET | /api/v1/corporate/me | The traveller's grade, policy and approver |
| GET / PUT | /api/v1/corporate/policies | Travel policies per grade (travel manager) |
| GET / PUT | /api/v1/corporate/employees[/{userId}] | Grades, cost centres, approvers (travel manager) |
| GET | /api/v1/corporate/reports/spend?from&to | Spend, compliance and missed savings |
| GET | /api/v1/approvals | Trips waiting for the signed-in approver |
| POST | /api/v1/approvals/{id}/decision | Approve or reject in the portal |
| GET / POST | /api/v1/approvals/{id}/by-token | One-click decision from the email link (no login) |
| GET / POST | /api/v1/inventory/allotments | List own-inventory flights / load a series (operator) |
| PATCH | /api/v1/inventory/allotments/{id} | Change fare, capacity, release date or close (operator) |
| GET | /api/v1/inventory/allotments/{id}/manifest[.csv] | Passenger manifest (operator) |
| GET | /api/v1/insurance/plans | Insurance plans (net rates for the operator only) |
| PUT | /api/v1/insurance/plans/{code}/active | Withdraw or reinstate a plan (operator admin) |
| POST | /api/v1/insurance/quotes | Price every plan for a trip |
| POST | /api/v1/insurance/bookings | Hold a quote for named travellers (Idempotency-Key required) |
| GET | /health | Liveness |

## Next steps

Following the delivery plan, Phase 1:

1. Holiday packages and visa services.
2. B2C website, front-office desk (POS) and the AI agent.
3. First real flight adapter once the supplier is chosen; Keycloak; Kafka in place of the in-process event bus.
