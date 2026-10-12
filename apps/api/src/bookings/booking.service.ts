import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { FlightOffer, money, Passenger, SupplierError, SupplierErrorCode } from '@tripwise/contracts';
import { randomBytes } from 'crypto';
import { PoolClient } from 'pg';
import { AuthUser, hasRole } from '../auth/auth.types';
import { AppError, badRequest, conflict, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { FlightSearchService } from '../flights/flight-search.service';
import { SupplierRegistry } from '../flights/supplier-registry';
import { LedgerService } from '../payments/ledger.service';
import { PricingService } from '../pricing/pricing.service';
import { TenancyService } from '../tenancy/tenancy.service';

export interface CreateBookingInput {
  offerId: string;
  passengers: Passenger[];
  contact: { email: string; phone: string };
  /** The sell price the agent saw; if the live price differs, booking stops with PRICE_CHANGED. */
  expectedSellAmount?: number;
}

interface BookingRow {
  id: string;
  reference: string;
  tenant_id: string;
  tenant_path: string;
  created_by: string;
  status: string;
  supplier: string;
  offer_snapshot: FlightOffer;
  passengers: Passenger[];
  contact: { email: string; phone: string };
  currency: string;
  net_amount: number;
  agent_cost_amount: number;
  sell_amount: number;
  pricing_breakdown: unknown;
  pnr: string | null;
  hold_expires_at: Date | null;
  ticket_numbers: string[];
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `SELECT *, tenant_path::text AS tenant_path FROM booking.booking`;
const TICKET_ATTEMPTS = 2;

/**
 * Flight booking saga: reprice -> hold -> pay -> ticket -> confirm.
 * Each step is persisted with an event, so a step can be retried or compensated:
 * a failed ticket after payment is refunded automatically and flagged for operations.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly db: DbService,
    private readonly search: FlightSearchService,
    private readonly registry: SupplierRegistry,
    private readonly pricing: PricingService,
    private readonly ledger: LedgerService,
    private readonly tenancy: TenancyService,
  ) {}

  async create(user: AuthUser, input: CreateBookingInput, idempotencyKey: string | undefined, traceId: string) {
    if (!idempotencyKey) throw badRequest('Idempotency-Key header is required to create a booking');
    const existing = await this.db.one<BookingRow>(`${SELECT} WHERE tenant_id = $1 AND idempotency_key = $2`, [
      user.tenantId,
      idempotencyKey,
    ]);
    if (existing) return this.view(user, existing);
    if (!input.passengers.some((p) => p.type === 'ADT')) throw badRequest('At least one adult passenger is required');

    const cached = await this.search.getOffer(input.offerId);
    const ctx = { ...this.search.ctx(user, traceId), idempotencyKey };
    const offer = await this.registry.call(cached.supplier, ctx, (s) => s.reprice(cached, ctx));
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    const quote = pricer(offer.price.total, this.search.pricingContext(undefined, offer));

    if (input.expectedSellAmount !== undefined && input.expectedSellAmount !== quote.sell.amount) {
      throw conflict('PRICE_CHANGED', 'The price changed since you searched. Confirm the new price to continue.', {
        previousSellAmount: input.expectedSellAmount,
        newSellAmount: quote.sell.amount,
        currency: quote.sell.currency,
      });
    }

    const hold = await this.registry.call(offer.supplier, ctx, (s) => s.hold(offer, input.passengers, ctx));
    const reference = newReference();
    try {
      const row = await this.db.tx(async (client) => {
        const { rows } = await client.query<BookingRow>(
          `INSERT INTO booking.booking (reference, tenant_id, tenant_path, created_by, channel, status, supplier,
             offer_snapshot, passengers, contact, currency, net_amount, agent_cost_amount, sell_amount,
             pricing_breakdown, pnr, hold_expires_at, idempotency_key)
           VALUES ($1,$2,$3::ltree,$4,'b2b','held',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING *, tenant_path::text AS tenant_path`,
          [
            reference,
            user.tenantId,
            user.tenantPath,
            user.id,
            offer.supplier,
            JSON.stringify(offer),
            JSON.stringify(input.passengers),
            JSON.stringify(input.contact),
            quote.sell.currency,
            quote.net.amount,
            quote.agentCost.amount,
            quote.sell.amount,
            JSON.stringify(quote.breakdown),
            hold.pnr,
            hold.holdExpiresAt ?? null,
            idempotencyKey,
          ],
        );
        await this.event(client, rows[0].id, 'held', { pnr: hold.pnr, traceId, by: user.id });
        return rows[0];
      });
      return this.view(user, row);
    } catch (err) {
      // Two requests with the same key raced: release our duplicate hold, return the winner.
      if ((err as { code?: string }).code === '23505') {
        await this.registry.call(offer.supplier, ctx, (s) => s.cancel(hold, ctx)).catch(() => undefined);
        const winner = await this.db.one<BookingRow>(`${SELECT} WHERE tenant_id = $1 AND idempotency_key = $2`, [
          user.tenantId,
          idempotencyKey,
        ]);
        if (winner) return this.view(user, winner);
      }
      throw err;
    }
  }

  async pay(user: AuthUser, reference: string, traceId: string) {
    const operatorId = (await this.tenancy.ancestors(user.tenantPath))[0].id;

    const charged = await this.db.tx(async (client) => {
      const b = await this.lockInScope(client, user, reference);
      if (['paid', 'ticketing', 'confirmed'].includes(b.status)) return { booking: b, charged: false };
      if (b.status !== 'held') throw conflict('INVALID_STATE', `A ${b.status} booking cannot be paid`);
      if (b.hold_expires_at && b.hold_expires_at.getTime() < Date.now()) {
        throw conflict(SupplierErrorCode.HOLD_EXPIRED, 'The hold expired. Search again to rebook.');
      }
      await this.ledger.chargeBooking(client, b.tenant_id, operatorId, money(b.agent_cost_amount, b.currency), b.reference);
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'ticketing', updated_at = now() WHERE id = $1 RETURNING *, tenant_path::text AS tenant_path`,
        [b.id],
      );
      await this.event(client, b.id, 'paid', { amount: b.agent_cost_amount, currency: b.currency, traceId, by: user.id });
      return { booking: rows[0], charged: true };
    });

    // Already paid by an earlier (or concurrent) request: report its current state, never charge or ticket twice.
    if (!charged.charged) return this.view(user, charged.booking);
    // Money is taken and committed; ticketing happens outside that transaction.
    // A booking left in 'ticketing' by a crash is picked up by the recovery job (see README, next steps).
    return this.view(user, await this.ticket(charged.booking, operatorId, traceId));
  }

  async cancel(user: AuthUser, reference: string, traceId: string) {
    const b = await this.getRow(user, reference);
    if (b.status === 'cancelled') return this.view(user, b);
    if (b.status !== 'held') {
      throw conflict('INVALID_STATE', 'Only held bookings can be cancelled here. Raise an offline change request for ticketed bookings.');
    }
    const ctx = this.search.ctx(user, traceId);
    await this.registry.call(b.supplier, ctx, (s) => s.cancel({ supplier: b.supplier, pnr: b.pnr! }, ctx));
    const row = await this.db.tx(async (client) => {
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'held'
         RETURNING *, tenant_path::text AS tenant_path`,
        [b.id],
      );
      if (rows[0]) await this.event(client, b.id, 'cancelled', { traceId, by: user.id });
      return rows[0] ?? b;
    });
    return this.view(user, row);
  }

  async list(user: AuthUser, filter: { status?: string; limit: number }) {
    const { rows } = await this.db.query<BookingRow>(
      `${SELECT} WHERE tenant_path <@ $1::ltree AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $3`,
      [this.scopePath(user), filter.status ?? null, filter.limit],
    );
    return rows.map((r) => this.view(user, r));
  }

  async get(user: AuthUser, reference: string) {
    const b = await this.getRow(user, reference);
    const { rows: events } = await this.db.query(
      `SELECT type, data, created_at AS "at" FROM booking.booking_event WHERE booking_id = $1 ORDER BY id`,
      [b.id],
    );
    return { ...this.view(user, b), events };
  }

  private async ticket(b: BookingRow, operatorId: string, traceId: string): Promise<BookingRow> {
    const ctx = { traceId, tenantId: b.tenant_id, timeoutMs: 30_000, idempotencyKey: `ticket:${b.reference}` };
    const ref = { supplier: b.supplier, pnr: b.pnr!, holdExpiresAt: b.hold_expires_at?.toISOString() };
    let lastError: unknown;
    for (let attempt = 1; attempt <= TICKET_ATTEMPTS; attempt++) {
      try {
        const result = await this.registry.call(b.supplier, ctx, (s) => s.ticket(ref, ctx));
        return this.db.tx(async (client) => {
          const { rows } = await client.query<BookingRow>(
            `UPDATE booking.booking SET status = 'confirmed', ticket_numbers = $2, updated_at = now() WHERE id = $1
             RETURNING *, tenant_path::text AS tenant_path`,
            [b.id, result.ticketNumbers],
          );
          await this.event(client, b.id, 'ticketed', { ticketNumbers: result.ticketNumbers, attempt, traceId });
          return rows[0];
        });
      } catch (err) {
        lastError = err;
        this.logger.warn({ traceId, booking: b.reference, attempt }, `Ticketing failed: ${(err as Error).message}`);
        const retryable =
          !(err instanceof SupplierError) ||
          ([SupplierErrorCode.SUPPLIER_TIMEOUT, SupplierErrorCode.TICKETING_FAILED, SupplierErrorCode.SUPPLIER_UNAVAILABLE] as string[]).includes(
            err.code,
          );
        if (!retryable) break;
      }
    }
    const reason = lastError instanceof SupplierError ? lastError.code : 'TICKETING_FAILED';
    return this.db.tx(async (client) => {
      await this.ledger.refundBooking(client, b.tenant_id, operatorId, money(b.agent_cost_amount, b.currency), b.reference);
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1
         RETURNING *, tenant_path::text AS tenant_path`,
        [b.id, reason],
      );
      await this.event(client, b.id, 'ticketing_failed', { reason, traceId });
      await this.event(client, b.id, 'refunded', { amount: b.agent_cost_amount, currency: b.currency });
      // Ops queue: failed bookings are listed for operations by status = 'failed'.
      return rows[0];
    });
  }

  /** Agents see their own tenant's bookings; admins see their whole subtree. */
  private scopePath(user: AuthUser): string {
    return user.tenantPath;
  }

  private canSee(user: AuthUser, b: BookingRow): boolean {
    if (b.tenant_path === user.tenantPath) return true;
    return hasRole(user, 'admin', 'ops', 'finance') && this.tenancy.inScope(user, b.tenant_path);
  }

  private async getRow(user: AuthUser, reference: string): Promise<BookingRow> {
    const b = await this.db.one<BookingRow>(`${SELECT} WHERE reference = $1`, [reference.toUpperCase()]);
    if (!b || !this.canSee(user, b)) throw notFound('Booking');
    return b;
  }

  private async lockInScope(client: PoolClient, user: AuthUser, reference: string): Promise<BookingRow> {
    const { rows } = await client.query<BookingRow>(`${SELECT} WHERE reference = $1 FOR UPDATE`, [reference.toUpperCase()]);
    const b = rows[0];
    if (!b || !this.canSee(user, b)) throw notFound('Booking');
    if (b.tenant_id !== user.tenantId) {
      throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Only the booking agency can pay for this booking');
    }
    return b;
  }

  private event(client: PoolClient, bookingId: string, type: string, data: Record<string, unknown>) {
    return client.query(`INSERT INTO booking.booking_event (booking_id, type, data) VALUES ($1, $2, $3)`, [
      bookingId,
      type,
      JSON.stringify(data),
    ]);
  }

  private view(user: AuthUser, b: BookingRow) {
    const ownMarkup = b.sell_amount - b.agent_cost_amount;
    return {
      reference: b.reference,
      status: b.status,
      supplier: b.supplier,
      pnr: b.pnr,
      holdExpiresAt: b.hold_expires_at,
      ticketNumbers: b.ticket_numbers,
      failureReason: b.failure_reason,
      itinerary: b.offer_snapshot.slices,
      fareBrand: b.offer_snapshot.fareBrand,
      refundable: b.offer_snapshot.refundable,
      passengers: b.passengers,
      contact: b.contact,
      pricing: {
        agentCost: { amount: b.agent_cost_amount, currency: b.currency },
        sell: { amount: b.sell_amount, currency: b.currency },
        yourMarkup: { amount: ownMarkup, currency: b.currency },
        ...(user.tenantType === 'operator' ? { net: { amount: b.net_amount, currency: b.currency }, breakdown: b.pricing_breakdown } : {}),
      },
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    };
  }
}

/** Human-friendly reference, e.g. TW-7K3M9Q. No 0/O/1/I to avoid misreading over the phone. */
function newReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return `TW-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}
