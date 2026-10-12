-- Corporate travel (B2E): policies per grade, employee settings and approvals.
CREATE SCHEMA IF NOT EXISTS policy;

CREATE TABLE policy.travel_policy (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_id   uuid NOT NULL,
  grade          text NOT NULL,
  -- { flight: { maxCabin, maxFarePerTraveller, minAdvanceDays, refundableOnly }, hotel: { maxStars, maxNightlyPerRoom } }
  rules          jsonb NOT NULL DEFAULT '{}',
  -- always: every trip needs approval; out_of_policy: only trips outside the rules; never: no approval
  approval_mode  text NOT NULL DEFAULT 'out_of_policy' CHECK (approval_mode IN ('always', 'out_of_policy', 'never')),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (corporate_id, grade)
);

CREATE TABLE policy.employee (
  user_id           uuid PRIMARY KEY,
  corporate_id      uuid NOT NULL,
  grade             text NOT NULL,
  cost_centre       text,
  approver_user_id  uuid,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_corporate ON policy.employee (corporate_id);

CREATE TABLE policy.approval_request (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL,
  booking_reference  text NOT NULL,
  corporate_id       uuid NOT NULL,
  traveller_id       uuid NOT NULL,
  approver_id        uuid NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  token_hash         text NOT NULL,
  token_expires_at   timestamptz NOT NULL,
  comment            text,
  decided_at         timestamptz,
  decided_via        text CHECK (decided_via IN ('portal', 'email')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_pending ON policy.approval_request (approver_id) WHERE status = 'pending';
CREATE UNIQUE INDEX approval_one_open ON policy.approval_request (booking_id) WHERE status = 'pending';

-- Bookings carry the policy outcome they were made under, and two new states.
ALTER TABLE booking.booking ADD COLUMN policy jsonb;
ALTER TABLE booking.booking DROP CONSTRAINT booking_status_check;
ALTER TABLE booking.booking ADD CONSTRAINT booking_status_check
  CHECK (status IN ('held','pending_approval','rejected','paid','ticketing','confirmed','cancelled','failed','expired'));
