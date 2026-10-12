import { Injectable } from '@nestjs/common';
import { AuthUser, hasRole } from '../auth/auth.types';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';

export interface SeriesInput {
  kind: 'blocked' | 'charter' | 'a2a';
  carrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  dates: string[];
  departureTime: string; // HH:MM local
  arrivalTime: string; // HH:MM local
  arrivalDayOffset: number;
  durationMin: number;
  cabin: string;
  fareBrand?: string;
  checkedPieces: number;
  cabinKg: number;
  refundable: boolean;
  changeable: boolean;
  baseAmount: number;
  taxAmount: number;
  currency: string;
  seats: number;
  releaseDaysBefore: number;
  notes?: string;
}

export interface AllotmentUpdate {
  baseAmount?: number;
  taxAmount?: number;
  seatsTotal?: number;
  releaseAt?: string;
  status?: 'active' | 'closed';
  notes?: string | null;
}

const VIEW = `id, kind, carrier, flight_number AS "flightNumber", origin, destination,
  to_char(departure_local, 'YYYY-MM-DD"T"HH24:MI') AS "departureLocal", to_char(arrival_local, 'YYYY-MM-DD"T"HH24:MI') AS "arrivalLocal",
  duration_min AS "durationMin", cabin, fare_brand AS "fareBrand", checked_pieces AS "checkedPieces", cabin_kg AS "cabinKg",
  refundable, changeable, base_amount AS "baseAmount", tax_amount AS "taxAmount", currency,
  seats_total AS "seatsTotal", seats_held AS "seatsHeld", seats_sold AS "seatsSold",
  seats_total - seats_held - seats_sold AS "seatsAvailable", release_at AS "releaseAt",
  CASE WHEN status = 'active' AND release_at <= now() THEN 'released' ELSE status END AS status, notes`;

/** Back office for the operator's own seats: load series, change fares and capacity, export manifests. */
@Injectable()
export class InventoryService {
  constructor(private readonly db: DbService) {}

  async list(user: AuthUser, f: { from?: string; to?: string; origin?: string; destination?: string; status?: string }) {
    this.requireOperator(user);
    const { rows } = await this.db.query(
      `SELECT ${VIEW} FROM inventory.allotment
        WHERE owner_tenant_id = $1
          AND ($2::date IS NULL OR departure_local::date >= $2) AND ($3::date IS NULL OR departure_local::date <= $3)
          AND ($4::text IS NULL OR origin = $4) AND ($5::text IS NULL OR destination = $5)
          AND ($6::text IS NULL OR status = $6)
        ORDER BY departure_local, carrier, flight_number LIMIT 500`,
      [user.tenantId, f.from ?? null, f.to ?? null, f.origin ?? null, f.destination ?? null, f.status ?? null],
    );
    return rows;
  }

  /** Creates one allotment per date. Dates that already exist for this flight and cabin are skipped. */
  async createSeries(user: AuthUser, s: SeriesInput) {
    this.requireOperator(user);
    if (s.origin === s.destination) throw badRequest('Origin and destination must differ');
    const dates = [...new Set(s.dates)].sort();
    const created: unknown[] = [];
    const skipped: string[] = [];
    await this.db.tx(async (client) => {
      for (const date of dates) {
        const { rows } = await client.query(
          `INSERT INTO inventory.allotment (owner_tenant_id, kind, carrier, flight_number, origin, destination, departure_local,
             arrival_local, duration_min, cabin, fare_brand, checked_pieces, cabin_kg, refundable, changeable, base_amount,
             tax_amount, currency, seats_total, release_at, notes, created_by)
           SELECT $1, $2, $3, $4, $5, $6, d.dep, d.arr, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                  (d.dep - make_interval(days => $21)) AT TIME ZONE 'UTC', $22, $23
             FROM (SELECT ($7::date + $8::time) AS dep, ($7::date + $24::int + $9::time) AS arr) d
           ON CONFLICT (carrier, flight_number, departure_local, cabin) DO NOTHING
           RETURNING ${VIEW}`,
          [
            user.tenantId, s.kind, s.carrier, s.flightNumber, s.origin, s.destination, date, s.departureTime, s.arrivalTime,
            s.durationMin, s.cabin, s.fareBrand ?? null, s.checkedPieces, s.cabinKg, s.refundable, s.changeable, s.baseAmount,
            s.taxAmount, s.currency, s.seats, s.releaseDaysBefore, s.notes ?? null, user.id, s.arrivalDayOffset,
          ],
        );
        if (rows[0]) created.push(rows[0]);
        else skipped.push(date);
      }
      await this.audit(client, user, 'inventory.series_created', `${s.carrier}${s.flightNumber}`, { ...s, created: created.length, skipped });
    });
    return { created, skipped };
  }

  async update(user: AuthUser, id: string, u: AllotmentUpdate) {
    this.requireOperator(user);
    try {
      const row = await this.db.tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE inventory.allotment SET
             base_amount = COALESCE($3, base_amount), tax_amount = COALESCE($4, tax_amount),
             seats_total = COALESCE($5, seats_total), release_at = COALESCE($6, release_at),
             status = COALESCE($7, status), notes = CASE WHEN $8 THEN $9 ELSE notes END, updated_at = now()
           WHERE id = $1 AND owner_tenant_id = $2 RETURNING ${VIEW}`,
          [id, user.tenantId, u.baseAmount ?? null, u.taxAmount ?? null, u.seatsTotal ?? null, u.releaseAt ?? null, u.status ?? null,
           u.notes !== undefined, u.notes ?? null],
        );
        if (!rows[0]) throw notFound('Allotment');
        await this.audit(client, user, 'inventory.allotment_updated', id, u);
        return rows[0];
      });
      return row;
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'allotment_capacity') {
        throw conflict('CAPACITY_BELOW_SOLD', 'Capacity cannot be lower than the seats already held and sold');
      }
      throw err;
    }
  }

  /** Who is on the flight: every held or ticketed passenger, for name submission to the airline. */
  async manifest(user: AuthUser, id: string) {
    this.requireOperator(user);
    const allotment = await this.db.one(`SELECT ${VIEW} FROM inventory.allotment WHERE id = $1 AND owner_tenant_id = $2`, [id, user.tenantId]);
    if (!allotment) throw notFound('Allotment');
    const { rows } = await this.db.query<{ pnr: string; status: string; passengers: Record<string, string>[]; ticket_numbers: string[] }>(
      `SELECT pnr, status, passengers, ticket_numbers FROM inventory.seat_hold
        WHERE allotment_id = $1 AND status IN ('held', 'ticketed') ORDER BY created_at`,
      [id],
    );
    const passengers = rows.flatMap((r) =>
      r.passengers.map((p, i) => ({
        pnr: r.pnr,
        status: r.status,
        type: p.type,
        title: p.title,
        firstName: p.firstName,
        lastName: p.lastName,
        dateOfBirth: p.dateOfBirth,
        documentNumber: p.documentNumber ?? null,
        ticketNumber: r.ticket_numbers[i] ?? null,
      })),
    );
    return { allotment, passengers };
  }

  manifestCsv(m: Awaited<ReturnType<InventoryService['manifest']>>): string {
    const cols = ['pnr', 'status', 'type', 'title', 'lastName', 'firstName', 'dateOfBirth', 'documentNumber', 'ticketNumber'] as const;
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      // Quote everything and neutralise spreadsheet formulas.
      return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
    };
    return [cols.join(','), ...m.passengers.map((p) => cols.map((c) => esc(p[c])).join(','))].join('\r\n') + '\r\n';
  }

  /** Checked before the request body is validated, so outsiders learn nothing about the API shape. */
  requireOperator(user: AuthUser) {
    if (user.tenantType !== 'operator' || !hasRole(user, 'admin', 'ops')) throw forbidden('Operator admin or operations access required');
  }

  private audit(client: Queryable, user: AuthUser, action: string, entityId: string, data: unknown) {
    return client.query(
      `INSERT INTO audit.audit_log (actor_id, tenant_id, action, entity, entity_id, data) VALUES ($1, $2, $3, 'allotment', $4, $5)`,
      [user.id, user.tenantId, action, entityId, JSON.stringify(data)],
    );
  }
}
