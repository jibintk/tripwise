-- Hotels: one master record per physical property, mapped from every supplier's own ID.
CREATE SCHEMA IF NOT EXISTS hotels;

CREATE TABLE hotels.hotel (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  normalised_name  text NOT NULL,
  city             char(3) NOT NULL,
  stars            smallint NOT NULL CHECK (stars BETWEEN 0 AND 5),
  address          text NOT NULL,
  latitude         double precision NOT NULL,
  longitude        double precision NOT NULL,
  amenities        text[] NOT NULL DEFAULT '{}',
  images           text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_city_name ON hotels.hotel (city, normalised_name);

CREATE TABLE hotels.supplier_map (
  supplier           text NOT NULL,
  supplier_hotel_id  text NOT NULL,
  hotel_id           uuid NOT NULL REFERENCES hotels.hotel(id),
  supplier_name      text NOT NULL,
  mapped_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier, supplier_hotel_id)
);
CREATE INDEX supplier_map_hotel ON hotels.supplier_map (hotel_id);

-- Product-specific results of fulfilment: hotel confirmation numbers, cancellation penalties, ...
ALTER TABLE booking.booking ADD COLUMN fulfilment jsonb NOT NULL DEFAULT '{}';
ALTER TABLE booking.booking ADD CONSTRAINT booking_product_check
  CHECK (product IN ('flight', 'hotel', 'insurance', 'package', 'visa'));
