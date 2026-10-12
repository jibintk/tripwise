import { Injectable } from '@nestjs/common';
import {
  CallContext,
  CancelResult,
  FareRules,
  FlightOffer,
  FlightSearchRequest,
  FlightSupplier,
  money,
  Passenger,
  SupplierBookingRef,
  SupplierError,
  SupplierErrorCode,
  TicketResult,
} from '@tripwise/contracts';
import { randomBytes, randomInt } from 'crypto';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';

export const OWN_INVENTORY = 'owninventory';
const HOLD_MINUTES = 30;
/** Infants travel on a lap: no seat, 10% of the base fare plus taxes. */
const INFANT_SHARE = 0.1;
const MAX_RETURN_COMBINATIONS = 12;

export interface AllotmentRow {
  id: string;
  kind: 'blocked' | 'charter' | 'a2a';
  carrier: string;
  flight_number: string;
  origin: string;
  destination: string;
  departure_local: string;
  arrival_local: string;
  duration_min: number;
  cabin: FlightSearchRequest['cabin'];
  fare_brand: string | null;
  checked_pieces: number;
  cabin_kg: number;
  refundable: boolean;
  changeable: boolean;
  base_amount: number;
  tax_amount: number;
  currency: string;
  seats_total: number;
  seats_held: number;
  seats_sold: number;
  release_at: Date;
  status: string;
}

interface Pax {
  adt: number;
  chd: number;
  inf: number;
}

// Timestamps without time zone come back as local wall-clock strings, not Date objects.
const ALLOTMENT_COLUMNS = `id, kind, carrier, flight_number, origin, destination, duration_min, cabin, fare_brand, checked_pieces,
  cabin_kg, refundable, changeable, base_amount, tax_amount, currency, seats_total, seats_held, seats_sold, release_at, status,
  to_char(departure_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS departure_local, to_char(arrival_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS arrival_local`;

/**
 * Sells the operator's own seats (blocked seats, charters, A2A contracts) through the normal
 * flight search and booking saga. Seat counts live in Postgres and every change happens under a
 * row lock, so two agents can never sell the last seat twice.
 *
 * Offer ids carry the allotments and passenger mix: inv_<outbound>[_<inbound>]_<adt>-<chd>-<inf>.
 */
@Injectable()
export class OwnInventorySupplier implements FlightSupplier {
  readonly code = OWN_INVENTORY;
  readonly capabilities = { hold: true, brandedFares: false, importPnr: false };

  constructor(private readonly db: DbService) {}

  async search(req: FlightSearchRequest, _ctx: CallContext): Promise<FlightOffer[]> {
    const pax = { adt: req.passengers.ADT, chd: req.passengers.CHD ?? 0, inf: req.passengers.INF ?? 0 };
    const seats = pax.adt + pax.chd;
    const find = (origin: string, destination: string, date: string) =>
      this.db
        .query<AllotmentRow>(
          `SELECT ${ALLOTMENT_COLUMNS} FROM inventory.allotment
            WHERE origin = $1 AND destination = $2 AND departure_local::date = $3::date AND cabin = $4
              AND status = 'active' AND release_at > now() AND seats_total - seats_held - seats_sold >= $5
            ORDER BY base_amount + tax_amount, allotment.departure_local`,
          [origin, destination, date, req.cabin, seats],
        )
        .then((r) => r.rows);

    const outbound = await find(req.origin, req.destination, req.departureDate);
    if (!req.returnDate) return outbound.map((a) => this.offer([a], pax));
    if (!outbound.length) return [];
    const inbound = await find(req.destination, req.origin, req.returnDate);
    const offers: FlightOffer[] = [];
    for (const out of outbound) {
      for (const back of inbound) {
        if (offers.length < MAX_RETURN_COMBINATIONS) offers.push(this.offer([out, back], pax));
      }
    }
    return offers;
  }

  async fareRules(offer: FlightOffer, _ctx: CallContext): Promise<FareRules> {
    const [first] = await this.load(this.parse(offer.offerId).ids);
    return {
      offerId: offer.offerId,
      refundable: first.refundable,
      changeable: first.changeable,
      text:
        `${first.kind === 'charter' ? 'Charter flight' : 'Contracted seats'} sold by the operator. ` +
        (first.refundable ? 'Refundable before departure less a handling fee. ' : 'Non-refundable. ') +
        (first.changeable ? 'Date changes allowed subject to availability.' : 'No changes allowed.'),
    };
  }

  /** Re-reads the allotments: fares the operator changed are picked up, closed or full flights are refused. */
  async reprice(offer: FlightOffer, _ctx: CallContext): Promise<FlightOffer> {
    const { ids, pax } = this.parse(offer.offerId);
    const rows = await this.load(ids);
    for (const a of rows) this.assertSellable(a, pax.adt + pax.chd);
    return this.offer(rows, pax);
  }

  async hold(offer: FlightOffer, passengers: Passenger[], _ctx: CallContext): Promise<SupplierBookingRef> {
    const { ids, pax } = this.parse(offer.offerId);
    const count = (t: string) => passengers.filter((p) => p.type === t).length;
    if (count('ADT') !== pax.adt || count('CHD') !== pax.chd || count('INF') !== pax.inf) {
      throw new SupplierError(SupplierErrorCode.INVALID_PASSENGER_DATA, 'Passengers do not match the offer', this.code);
    }
    const seats = pax.adt + pax.chd;
    const pnr = newPnr();
    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000);
    await this.db.tx(async (client) => {
      // Lock in a fixed order so two return-trip holds can never deadlock each other.
      const rows = await this.lock(client, ids);
      for (const a of rows) {
        this.assertSellable(a, seats);
        await client.query(`UPDATE inventory.allotment SET seats_held = seats_held + $2, updated_at = now() WHERE id = $1`, [a.id, seats]);
        await client.query(
          `INSERT INTO inventory.seat_hold (pnr, allotment_id, seats, passengers, status, expires_at) VALUES ($1, $2, $3, $4, 'held', $5)`,
          [pnr, a.id, seats, JSON.stringify(passengers), expiresAt],
        );
      }
    });
    return { supplier: this.code, pnr, holdExpiresAt: expiresAt.toISOString() };
  }

  /**
   * Turns held seats into sold seats and issues ticket numbers. Idempotent per PNR. A hold that
   * passed its time limit is still honoured as long as nothing released it, because the booking
   * was paid in time.
   */
  async ticket(ref: SupplierBookingRef, _ctx: CallContext): Promise<TicketResult> {
    return this.db.tx(async (client) => {
      const { rows } = await client.query<{ id: string; allotment_id: string; seats: number; status: string; passengers: Passenger[]; ticket_numbers: string[] }>(
        `SELECT * FROM inventory.seat_hold WHERE pnr = $1 ORDER BY allotment_id FOR UPDATE`,
        [ref.pnr],
      );
      if (!rows.length) throw new SupplierError(SupplierErrorCode.TICKETING_FAILED, `Unknown PNR ${ref.pnr}`, this.code);
      if (rows.every((r) => r.status === 'ticketed')) return { ticketNumbers: rows[0].ticket_numbers };
      if (rows.some((r) => r.status !== 'held')) {
        throw new SupplierError(SupplierErrorCode.TICKETING_FAILED, 'The seats were released before ticketing', this.code);
      }
      await this.lock(client, rows.map((r) => r.allotment_id));
      const ticketNumbers = rows[0].passengers.map(() => `${OPERATOR_TICKET_PREFIX}${randomInt(0, 1e10).toString().padStart(10, '0')}`);
      for (const r of rows) {
        await client.query(
          `UPDATE inventory.allotment SET seats_held = seats_held - $2, seats_sold = seats_sold + $2, updated_at = now() WHERE id = $1`,
          [r.allotment_id, r.seats],
        );
      }
      await client.query(`UPDATE inventory.seat_hold SET status = 'ticketed', ticket_numbers = $2, updated_at = now() WHERE pnr = $1`, [
        ref.pnr,
        ticketNumbers,
      ]);
      return { ticketNumbers };
    });
  }

  /** Releases held seats, or puts sold seats back on sale when a ticket is voided. */
  async cancel(ref: SupplierBookingRef, _ctx: CallContext): Promise<CancelResult> {
    await this.db.tx((client) => this.releasePnr(client, ref.pnr));
    return { cancelled: true };
  }

  /**
   * Gives back seats held for bookings that never completed (for example the booking failed to
   * save after the hold). Waits a grace period past the time limit so a booking paid at the last
   * second still gets ticketed.
   */
  async releaseStaleHolds(graceMinutes = 15, batch = 50): Promise<string[]> {
    const { rows } = await this.db.query<{ pnr: string }>(
      `SELECT DISTINCT pnr FROM inventory.seat_hold WHERE status = 'held' AND expires_at < now() - make_interval(mins => $1) LIMIT $2`,
      [graceMinutes, batch],
    );
    for (const { pnr } of rows) await this.db.tx((client) => this.releasePnr(client, pnr));
    return rows.map((r) => r.pnr);
  }

  // ---------- helpers ----------

  private async releasePnr(client: PoolClient, pnr: string) {
    const { rows } = await client.query<{ allotment_id: string; seats: number; status: string }>(
      `SELECT allotment_id, seats, status FROM inventory.seat_hold WHERE pnr = $1 AND status IN ('held', 'ticketed') ORDER BY allotment_id FOR UPDATE`,
      [pnr],
    );
    if (!rows.length) return;
    await this.lock(client, rows.map((r) => r.allotment_id));
    for (const r of rows) {
      const column = r.status === 'held' ? 'seats_held' : 'seats_sold';
      await client.query(`UPDATE inventory.allotment SET ${column} = ${column} - $2, updated_at = now() WHERE id = $1`, [r.allotment_id, r.seats]);
    }
    await client.query(
      `UPDATE inventory.seat_hold SET status = CASE status WHEN 'held' THEN 'released' ELSE 'cancelled' END, updated_at = now()
        WHERE pnr = $1 AND status IN ('held', 'ticketed')`,
      [pnr],
    );
  }

  private async lock(client: PoolClient, ids: string[]): Promise<AllotmentRow[]> {
    const { rows } = await client.query<AllotmentRow>(
      `SELECT ${ALLOTMENT_COLUMNS} FROM inventory.allotment WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    if (rows.length !== new Set(ids).size) throw new SupplierError(SupplierErrorCode.SOLD_OUT, 'This flight is no longer offered', this.code);
    return ids.map((id) => rows.find((r) => r.id === id)!);
  }

  private async load(ids: string[]): Promise<AllotmentRow[]> {
    const { rows } = await this.db.query<AllotmentRow>(`SELECT ${ALLOTMENT_COLUMNS} FROM inventory.allotment WHERE id = ANY($1::uuid[])`, [ids]);
    if (rows.length !== new Set(ids).size) throw new SupplierError(SupplierErrorCode.SOLD_OUT, 'This flight is no longer offered', this.code);
    return ids.map((id) => rows.find((r) => r.id === id)!);
  }

  private assertSellable(a: AllotmentRow, seats: number) {
    if (a.status !== 'active' || a.release_at.getTime() <= Date.now()) {
      throw new SupplierError(SupplierErrorCode.SOLD_OUT, `${a.carrier}${a.flight_number} is closed for sale`, this.code);
    }
    if (a.seats_total - a.seats_held - a.seats_sold < seats) {
      throw new SupplierError(SupplierErrorCode.SOLD_OUT, `Not enough seats left on ${a.carrier}${a.flight_number}`, this.code);
    }
  }

  private parse(offerId: string): { ids: string[]; pax: Pax } {
    const m = /^inv_([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?_(\d+)-(\d+)-(\d+)$/.exec(offerId);
    if (!m) throw new SupplierError(SupplierErrorCode.SOLD_OUT, 'Unknown inventory offer', this.code);
    return { ids: [m[1], m[2]].filter(Boolean), pax: { adt: +m[3], chd: +m[4], inf: +m[5] } };
  }

  private offer(rows: AllotmentRow[], pax: Pax): FlightOffer {
    const currency = rows[0].currency;
    let base = 0;
    let taxes = 0;
    for (const a of rows) {
      base += a.base_amount * (pax.adt + pax.chd) + Math.round(a.base_amount * INFANT_SHARE) * pax.inf;
      taxes += a.tax_amount * (pax.adt + pax.chd + pax.inf);
    }
    const first = rows[0];
    return {
      offerId: `inv_${rows.map((r) => r.id).join('_')}_${pax.adt}-${pax.chd}-${pax.inf}`,
      supplier: this.code,
      slices: rows.map((a) => ({
        durationMin: a.duration_min,
        segments: [
          {
            marketingCarrier: a.carrier,
            flightNumber: `${a.carrier}${a.flight_number}`,
            origin: a.origin,
            destination: a.destination,
            departureLocal: a.departure_local,
            arrivalLocal: a.arrival_local,
            durationMin: a.duration_min,
          },
        ],
      })),
      fareBrand: first.fare_brand ?? (first.kind === 'charter' ? 'Charter' : undefined),
      baggage: [{ passengerType: 'ADT', checkedPieces: first.checked_pieces, cabinKg: first.cabin_kg }],
      refundable: rows.every((r) => r.refundable),
      cabin: first.cabin,
      price: { base: money(base, currency), taxes: money(taxes, currency), total: money(base + taxes, currency) },
      validUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }
}

/** Numeric prefix for tickets the operator issues on its own stock (not an airline's 3-digit code). */
const OPERATOR_TICKET_PREFIX = '990';

function newPnr(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}
