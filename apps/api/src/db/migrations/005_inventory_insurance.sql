-- Own flight inventory: seats the operator has bought or contracted (blocked seats on scheduled
-- flights, charters, airline-to-agency contract fares) and sells through the normal flight search.
CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE inventory.allotment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),
  kind             text NOT NULL CHECK (kind IN ('blocked', 'charter', 'a2a')),
  carrier          text NOT NULL CHECK (carrier ~ '^[A-Z0-9]{2}$'),
  flight_number    text NOT NULL CHECK (flight_number ~ '^[0-9]{1,4}$'),
  origin           char(3) NOT NULL,
  destination      char(3) NOT NULL,
  departure_local  timestamp NOT NULL,
  arrival_local    timestamp NOT NULL,
  duration_min     int NOT NULL CHECK (duration_min > 0),
  cabin            text NOT NULL CHECK (cabin IN ('ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST')),
  fare_brand       text,
  checked_pieces   int NOT NULL DEFAULT 1,
  cabin_kg         int NOT NULL DEFAULT 7,
  refundable       boolean NOT NULL DEFAULT false,
  changeable       boolean NOT NULL DEFAULT false,
  base_amount      bigint NOT NULL CHECK (base_amount >= 0),
  tax_amount       bigint NOT NULL CHECK (tax_amount >= 0),
  currency         char(3) NOT NULL,
  seats_total      int NOT NULL CHECK (seats_total > 0),
  seats_held       int NOT NULL DEFAULT 0 CHECK (seats_held >= 0),
  seats_sold       int NOT NULL DEFAULT 0 CHECK (seats_sold >= 0),
  -- Unsold seats go back to the airline at this time; nothing is sold after it.
  release_at       timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  notes            text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allotment_capacity CHECK (seats_held + seats_sold <= seats_total),
  CONSTRAINT allotment_route CHECK (origin <> destination),
  UNIQUE (carrier, flight_number, departure_local, cabin)
);

CREATE INDEX allotment_search ON inventory.allotment (origin, destination, (departure_local::date)) WHERE status = 'active';

-- Seats taken out of an allotment for one booking. A return trip holds two rows with one PNR.
CREATE TABLE inventory.seat_hold (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pnr             text NOT NULL,
  allotment_id    uuid NOT NULL REFERENCES inventory.allotment(id),
  seats           int NOT NULL CHECK (seats > 0),
  passengers      jsonb NOT NULL,
  status          text NOT NULL CHECK (status IN ('held', 'ticketed', 'released', 'cancelled')),
  expires_at      timestamptz NOT NULL,
  ticket_numbers  text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pnr, allotment_id)
);

CREATE INDEX seat_hold_pnr ON inventory.seat_hold (pnr);
CREATE INDEX seat_hold_stale ON inventory.seat_hold (expires_at) WHERE status = 'held';
CREATE INDEX seat_hold_allotment ON inventory.seat_hold (allotment_id) WHERE status IN ('held', 'ticketed');

-- Travel insurance: plans agreed with underwriters, priced per traveller by trip length.
CREATE SCHEMA IF NOT EXISTS insurance;

CREATE TABLE insurance.plan (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  provider       text NOT NULL,
  regions        text[] NOT NULL,
  summary        text NOT NULL,
  -- [{ "label": "Emergency medical", "limit": "USD 100,000" }, ...]
  coverage       jsonb NOT NULL,
  -- Net premium per traveller: [{ "maxDays": 8, "amount": 1500 }, ...], ascending maxDays.
  rates          jsonb NOT NULL,
  currency       char(3) NOT NULL,
  max_age        int NOT NULL DEFAULT 80,
  senior_age     int NOT NULL DEFAULT 65,
  senior_factor  numeric(4,2) NOT NULL DEFAULT 2.0,
  active         boolean NOT NULL DEFAULT true,
  sort           int NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
