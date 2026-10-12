-- Tripwise initial schema. Each module owns one Postgres schema; no foreign keys cross schemas.
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS tenancy;
CREATE SCHEMA IF NOT EXISTS pricing;
CREATE SCHEMA IF NOT EXISTS payments;
CREATE SCHEMA IF NOT EXISTS booking;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------- tenancy ----------
CREATE TABLE tenancy.tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('operator','gsa','agency','sub_agency','branch','corporate')),
  parent_id   uuid REFERENCES tenancy.tenant(id),
  code        text NOT NULL UNIQUE,
  path        ltree NOT NULL UNIQUE,
  name        text NOT NULL,
  country     text NOT NULL,
  currency    char(3) NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_path_gist ON tenancy.tenant USING gist (path);

CREATE TABLE tenancy.app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenancy.tenant(id),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  roles          text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- pricing ----------
CREATE TABLE pricing.pricing_rule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_tenant_id  uuid NOT NULL,
  name             text NOT NULL,
  product          text CHECK (product IN ('flight','hotel','insurance','package','visa')),
  channel          text CHECK (channel IN ('b2b','b2e','b2c','pos')),
  supplier         text,
  origin           char(3),
  destination      char(3),
  cabin            text,
  value_type       text NOT NULL CHECK (value_type IN ('percent','fixed')),
  -- percent: basis points (250 = 2.5%); fixed: minor units in `currency`
  value            integer NOT NULL CHECK (value >= 0),
  currency         char(3),
  priority         integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (value_type = 'percent' OR currency IS NOT NULL)
);
CREATE INDEX pricing_rule_owner ON pricing.pricing_rule (owner_tenant_id) WHERE active;

-- ---------- payments ----------
CREATE TABLE payments.account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  type          text NOT NULL CHECK (type IN ('wallet','sales','funding')),
  currency      char(3) NOT NULL,
  credit_limit  bigint NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, type, currency)
);

-- Signed amounts: the balance of an account is SUM(amount). Every txn_id sums to zero.
CREATE TABLE payments.ledger_entry (
  id          bigserial PRIMARY KEY,
  txn_id      uuid NOT NULL,
  account_id  uuid NOT NULL REFERENCES payments.account(id),
  amount      bigint NOT NULL,
  currency    char(3) NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('topup','booking_payment','refund')),
  ref_type    text NOT NULL,
  ref_id      text NOT NULL,
  memo        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entry_account ON payments.ledger_entry (account_id, created_at DESC);
CREATE INDEX ledger_entry_txn ON payments.ledger_entry (txn_id);
-- A booking can be charged once and refunded once.
CREATE UNIQUE INDEX ledger_entry_once ON payments.ledger_entry (kind, ref_type, ref_id, account_id)
  WHERE kind IN ('booking_payment','refund');

-- ---------- booking ----------
CREATE TABLE booking.booking (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL UNIQUE,
  tenant_id          uuid NOT NULL,
  tenant_path        ltree NOT NULL,
  created_by         uuid NOT NULL,
  channel            text NOT NULL,
  product            text NOT NULL DEFAULT 'flight',
  status             text NOT NULL CHECK (status IN ('held','paid','ticketing','confirmed','cancelled','failed')),
  supplier           text NOT NULL,
  offer_snapshot     jsonb NOT NULL,
  passengers         jsonb NOT NULL,
  contact            jsonb NOT NULL,
  currency           char(3) NOT NULL,
  net_amount         bigint NOT NULL,
  agent_cost_amount  bigint NOT NULL,
  sell_amount        bigint NOT NULL,
  pricing_breakdown  jsonb NOT NULL,
  pnr                text,
  hold_expires_at    timestamptz,
  ticket_numbers     text[] NOT NULL DEFAULT '{}',
  failure_reason     text,
  idempotency_key    text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX booking_tenant_path ON booking.booking USING gist (tenant_path);
CREATE INDEX booking_pnr ON booking.booking (pnr);

-- Saga log: every state change of a booking, in order.
CREATE TABLE booking.booking_event (
  id          bigserial PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES booking.booking(id),
  type        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_event_booking ON booking.booking_event (booking_id, id);

-- ---------- audit ----------
CREATE TABLE audit.audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid,
  tenant_id   uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  trace_id    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
