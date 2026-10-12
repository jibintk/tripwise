-- Events, notifications and operations support.
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS notify;

-- Transactional outbox: written in the same transaction as the state change it describes,
-- then published by the dispatcher. An event is never lost and never sent for a rolled-back change.
CREATE TABLE platform.outbox_event (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  aggregate     text NOT NULL,
  aggregate_id  text NOT NULL,
  tenant_id     uuid,
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_unpublished ON platform.outbox_event (id) WHERE published_at IS NULL;

CREATE TABLE notify.notification (
  id          bigserial PRIMARY KEY,
  channel     text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient   text NOT NULL,
  template    text NOT NULL,
  subject     text NOT NULL,
  body_text   text NOT NULL,
  body_html   text,
  ref_type    text,
  ref_id      text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  -- One message per template per event, even if the event is delivered twice.
  dedupe_key  text NOT NULL UNIQUE
);
CREATE INDEX notification_pending ON notify.notification (id) WHERE status = 'pending';

-- Bookings: a hold can now expire, and failed bookings carry an operations resolution.
ALTER TABLE booking.booking DROP CONSTRAINT booking_status_check;
ALTER TABLE booking.booking ADD CONSTRAINT booking_status_check
  CHECK (status IN ('held','paid','ticketing','confirmed','cancelled','failed','expired'));
ALTER TABLE booking.booking
  ADD COLUMN ops_resolved_at timestamptz,
  ADD COLUMN ops_resolved_by uuid,
  ADD COLUMN ops_note text;
CREATE INDEX booking_status_updated ON booking.booking (status, updated_at);
CREATE INDEX booking_hold_expiry ON booking.booking (hold_expires_at) WHERE status = 'held';
