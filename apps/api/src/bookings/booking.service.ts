import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  FlightOffer,
  HotelGuest,
  HotelRate,
  HotelSearchRequest,
  InsuredTraveller,
  InsuranceRegion,
  money,
  Passenger,
  SupplierError,
  SupplierErrorCode,
} from '@tripwise/contracts';
import { nightsBetween } from '@tripwise/supplier-gateway';
import { createHash, randomBytes } from 'crypto';
import { PoolClient } from 'pg';
import { AuthUser, hasRole } from '../auth/auth.types';
import { AppError, badRequest, conflict, forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { renderETicket } from '../documents/eticket';
import { renderInsuranceCertificate } from '../documents/insurance-certificate';
import { renderHotelVoucher } from '../documents/voucher';
import { OutboxService } from '../events/outbox.service';
import { channelFor, FlightSearchService } from '../flights/flight-search.service';
import { CorporateService, TravellerContext } from '../corporate/corporate.service';
import { Cabin, needsApproval, PolicyVerdict } from '../corporate/policy-engine';
import { approvalRequested } from '../notify/templates';
import { APP_CONFIG, AppConfig } from '../config';
import { HotelSupplierRegistry, InsuranceProviderRegistry, SupplierRegistry } from '../flights/supplier-registry';
import { coverDays, InsuranceService, premiumFor, REGION_LABEL } from '../insurance/insurance.service';
import { HotelSearchService } from '../hotels/hotel-search.service';
import { LedgerService } from '../payments/ledger.service';
import { PriceQuote } from '../pricing/pricing-engine';
import { PricingService } from '../pricing/pricing.service';
import { TenancyService } from '../tenancy/tenancy.service';

/** Corporate trips only: why an out-of-policy option was chosen, and the search it came from. */
interface CorporateExtras {
  reasonForException?: string;
  searchId?: string;
}

export interface CreateBookingInput extends CorporateExtras {
  offerId: string;
  passengers: Passenger[];
  contact: { email: string; phone: string };
  /** The sell price the agent saw; if the live price differs, booking stops with PRICE_CHANGED. */
  expectedSellAmount?: number;
}

export interface CreateHotelBookingInput extends CorporateExtras {
  rateId: string;
  guests: HotelGuest[];
  contact: { email: string; phone: string };
  specialRequests?: string;
  expectedSellAmount?: number;
}

export interface CreateInsuranceBookingInput {
  quoteId: string;
  travellers: InsuredTraveller[];
  contact: { email: string; phone: string };
  expectedSellAmount?: number;
  /** The flight or hotel booking this cover is for, if any. */
  linkedReference?: string;
}

export interface InsuranceSnapshot {
  kind: 'insurance';
  plan: { code: string; name: string; summary: string; coverage: { label: string; limit: string }[] };
  request: { region: InsuranceRegion; startDate: string; endDate: string };
  days: number;
  linkedReference?: string;
}

export interface HotelSnapshot {
  kind: 'hotel';
  hotel: { id: string; name: string; city: string; address: string; stars: number };
  rate: HotelRate;
  request: HotelSearchRequest;
  specialRequests?: string;
}

type Product = 'flight' | 'hotel' | 'insurance';

export interface BookingRow {
  id: string;
  reference: string;
  tenant_id: string;
  tenant_path: string;
  created_by: string;
  product: Product;
  status: string;
  supplier: string;
  offer_snapshot: FlightOffer & HotelSnapshot;
  passengers: (Passenger | HotelGuest)[];
  contact: { email: string; phone: string };
  currency: string;
  net_amount: number;
  agent_cost_amount: number;
  sell_amount: number;
  pricing_breakdown: unknown;
  pnr: string | null;
  hold_expires_at: Date | null;
  ticket_numbers: string[];
  fulfilment: Record<string, unknown>;
  policy: PolicyRecord | null;
  channel: string;
  failure_reason: string | null;
  ops_resolved_at: Date | null;
  ops_note: string | null;
  created_at: Date;
  updated_at: Date;
}

/** What a corporate booking was checked against, stored with it for audit and reporting. */
export interface PolicyRecord {
  grade: string;
  approvalMode: string;
  inPolicy: boolean;
  violations: string[];
  reasonForException?: string;
  lowestSell?: number;
  missedSaving: number;
  approverId?: string | null;
}

const SELECT = `SELECT *, tenant_path::text AS tenant_path FROM booking.booking`;
const APPROVAL_LINK_HOURS = 48;
const RETURNING = `RETURNING *, tenant_path::text AS tenant_path`;
const TICKET_ATTEMPTS = 2;
/** Hotels have no supplier-side hold; the checked price is honoured for this long. */
const HOTEL_PRICE_LOCK_MINUTES = 20;
/** Insurance quotes are honoured for this long once the travellers are entered. */
const INSURANCE_PRICE_LOCK_MINUTES = 30;
/** Shown on certificates; the insurer's assistance line. */
const ASSISTANCE_LINE = '+254 20 000 0000 (24 hours, collect calls accepted)';

/** Booking history entries that other modules (notifications, reporting) hear about. */
const PUBLIC_EVENTS: Record<string, string> = {
  held: 'booking.held',
  paid: 'booking.paid',
  ticketed: 'booking.confirmed',
  confirmed: 'booking.confirmed',
  ticketing_failed: 'booking.failed',
  booking_failed: 'booking.failed',
  cancelled: 'booking.cancelled',
  expired: 'booking.expired',
  rejected: 'booking.rejected',
};

/**
 * Booking saga for every product: price check -> hold -> pay -> fulfil -> confirm.
 * Holding, paying, refunding and the history are shared; each product supplies its own way to
 * create, fulfil (ticket a flight, book a hotel room), release and cancel.
 * Every step is persisted with an event, so it can be retried or compensated: a failed
 * fulfilment after payment is refunded automatically and flagged for operations.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly db: DbService,
    private readonly search: FlightSearchService,
    private readonly registry: SupplierRegistry,
    private readonly hotelSearch: HotelSearchService,
    private readonly hotelRegistry: HotelSupplierRegistry,
    private readonly pricing: PricingService,
    private readonly ledger: LedgerService,
    private readonly tenancy: TenancyService,
    private readonly outbox: OutboxService,
    private readonly corporate: CorporateService,
    private readonly insurance: InsuranceService,
    private readonly insurers: InsuranceProviderRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------- create ----------

  async create(user: AuthUser, input: CreateBookingInput, idempotencyKey: string | undefined, traceId: string) {
    const existing = await this.existing(user, idempotencyKey);
    if (existing) return this.view(user, existing);
    if (!input.passengers.some((p) => p.type === 'ADT')) throw badRequest('At least one adult passenger is required');

    const cached = await this.search.getOffer(input.offerId);
    const ctx = { ...this.search.ctx(user, traceId), idempotencyKey };
    const offer = await this.registry.call(cached.supplier, ctx, (s) => s.reprice(cached, ctx));
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    const quote = pricer(offer.price.total, this.search.pricingContext(undefined, offer, channelFor(user)));
    this.checkExpectedPrice(input.expectedSellAmount, quote);

    const traveller = await this.corporate.travellerContext(user);
    const policy = traveller
      ? await this.corporatePolicy(
          traveller,
          this.corporate.flightVerdict(traveller, {
            cabin: (offer.cabin ?? 'ECONOMY') as Cabin,
            sellAmount: quote.sell.amount,
            currency: quote.sell.currency,
            travellers: input.passengers.length,
            departureDate: offer.slices[0].segments[0].departureLocal.slice(0, 10),
            refundable: offer.refundable,
          }),
          input,
          quote.sell.amount,
          input.searchId ? await this.search.lowestSell(user, input.searchId) : undefined,
        )
      : null;

    const hold = await this.registry.call(offer.supplier, ctx, (s) => s.hold(offer, input.passengers, ctx));
    return this.insertHeld(user, idempotencyKey!, traceId, {
      policy,
      product: 'flight',
      supplier: offer.supplier,
      snapshot: offer,
      passengers: input.passengers,
      contact: input.contact,
      quote,
      pnr: hold.pnr,
      holdExpiresAt: hold.holdExpiresAt ?? null,
      release: () => this.registry.call(offer.supplier, ctx, (s) => s.cancel(hold, ctx)).then(() => undefined),
    });
  }

  async createHotel(user: AuthUser, input: CreateHotelBookingInput, idempotencyKey: string | undefined, traceId: string) {
    const existing = await this.existing(user, idempotencyKey);
    if (existing) return this.view(user, existing);
    const cached = await this.hotelSearch.getRate(input.rateId);
    if (input.guests.length !== cached.request.rooms.length) {
      throw badRequest(`Give one lead guest per room (${cached.request.rooms.length})`);
    }
    const ctx = { ...this.hotelSearch.ctx(user, traceId), idempotencyKey };
    const rate = await this.hotelRegistry.call(cached.rate.supplier, ctx, (s) => s.checkRate(cached.rate, cached.request, ctx));
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    const quote = pricer(rate.price.total, this.hotelSearch.pricingContext(cached.request, rate, channelFor(user)));
    this.checkExpectedPrice(input.expectedSellAmount, quote);

    const hotel = await this.hotelContent(cached.hotelId);
    const traveller = await this.corporate.travellerContext(user);
    const policy = traveller
      ? await this.corporatePolicy(
          traveller,
          this.corporate.hotelVerdict(traveller, {
            stars: hotel.stars,
            sellAmount: quote.sell.amount,
            currency: quote.sell.currency,
            nights: nightsBetween(cached.request.checkIn, cached.request.checkOut),
            rooms: cached.request.rooms.length,
          }),
          input,
          quote.sell.amount,
          undefined,
        )
      : null;
    const snapshot: HotelSnapshot = { kind: 'hotel', hotel, rate, request: cached.request, specialRequests: input.specialRequests };
    return this.insertHeld(user, idempotencyKey!, traceId, {
      policy,
      product: 'hotel',
      supplier: rate.supplier,
      snapshot,
      passengers: input.guests,
      contact: input.contact,
      quote,
      pnr: null,
      holdExpiresAt: new Date(Date.now() + HOTEL_PRICE_LOCK_MINUTES * 60_000).toISOString(),
    });
  }

  /**
   * Holds an insurance quote for the named travellers. Nothing is reserved with the insurer; the
   * premium is re-checked against the current plan rates and the policy is issued on payment.
   */
  async createInsurance(user: AuthUser, input: CreateInsuranceBookingInput, idempotencyKey: string | undefined, traceId: string) {
    const existing = await this.existing(user, idempotencyKey);
    if (existing) return this.view(user, existing);
    const quote = await this.insurance.getQuote(input.quoteId);
    const quoted = quote.request.travellers.map((t) => t.dateOfBirth).sort();
    const named = input.travellers.map((t) => t.dateOfBirth).sort();
    if (quoted.length !== named.length || quoted.some((d, i) => d !== named[i])) {
      throw badRequest('Travellers must match the quote: same number of people and the same dates of birth');
    }
    if (input.linkedReference) await this.getRow(user, input.linkedReference);

    const plan = await this.insurance.plan(quote.planCode);
    const premium = premiumFor(plan, quote.request);
    if ('unavailable' in premium) throw conflict('OFFER_EXPIRED', `This plan no longer fits the trip: ${premium.unavailable}`);
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    const priced = pricer(money(premium.net, plan.currency), this.insurance.pricingContext(plan, channelFor(user)));
    this.checkExpectedPrice(input.expectedSellAmount, priced);

    const traveller = await this.corporate.travellerContext(user);
    const policy = traveller
      ? await this.corporatePolicy(traveller, { inPolicy: true, violations: [] }, {}, priced.sell.amount, undefined)
      : null;
    const { region, startDate, endDate } = quote.request;
    const snapshot: InsuranceSnapshot = {
      kind: 'insurance',
      plan: { code: plan.code, name: plan.name, summary: plan.summary, coverage: plan.coverage },
      request: { region, startDate, endDate },
      days: coverDays(startDate, endDate),
      linkedReference: input.linkedReference?.toUpperCase(),
    };
    return this.insertHeld(user, idempotencyKey!, traceId, {
      policy,
      product: 'insurance',
      supplier: plan.provider,
      snapshot,
      passengers: input.travellers,
      contact: input.contact,
      quote: priced,
      pnr: null,
      holdExpiresAt: new Date(Date.now() + INSURANCE_PRICE_LOCK_MINUTES * 60_000).toISOString(),
    });
  }

  // ---------- pay and fulfil ----------

  async pay(user: AuthUser, reference: string, traceId: string) {
    const b = await this.getRow(user, reference);
    if (b.tenant_id !== user.tenantId) {
      throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Only the booking organisation can pay for this booking');
    }
    if (b.status === 'pending_approval') throw conflict('APPROVAL_PENDING', 'This trip is waiting for approval');
    return this.view(user, await this.payInternal(b.reference, traceId, user.id));
  }

  /** Charges the booking organisation's wallet and fulfils. Used by agents paying and by approvals. */
  private async payInternal(reference: string, traceId: string, actorId: string): Promise<BookingRow> {
    const charged = await this.db.tx(async (client) => {
      const { rows: locked } = await client.query<BookingRow>(`${SELECT} WHERE reference = $1 FOR UPDATE`, [reference]);
      const b = locked[0];
      if (!b) throw notFound('Booking');
      if (['paid', 'ticketing', 'confirmed'].includes(b.status)) return { booking: b, charged: false };
      if (b.status !== 'held') throw conflict('INVALID_STATE', `A ${b.status} booking cannot be paid`);
      if (b.hold_expires_at && b.hold_expires_at.getTime() < Date.now()) {
        throw conflict(SupplierErrorCode.HOLD_EXPIRED, 'The hold expired. Search again to rebook.');
      }
      const operatorId = await this.operatorIdFor(b.tenant_path);
      await this.ledger.chargeBooking(client, b.tenant_id, operatorId, money(b.agent_cost_amount, b.currency), b.reference);
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'ticketing', updated_at = now() WHERE id = $1 ${RETURNING}`,
        [b.id],
      );
      await this.event(client, b, 'paid', { amount: b.agent_cost_amount, currency: b.currency, traceId, by: actorId });
      return { booking: rows[0], charged: true, operatorId };
    });
    // Already paid by an earlier (or concurrent) request: report its current state, never charge twice.
    if (!charged.charged) return charged.booking;
    // Money is taken and committed; fulfilment happens outside that transaction.
    return this.fulfil(charged.booking, charged.operatorId!, traceId);
  }

  // ---------- corporate approvals ----------

  /**
   * After a corporate trip is held: send it for approval when the policy asks for it, otherwise
   * pay from the company account and fulfil straight away.
   */
  private async afterCorporateHold(user: AuthUser, b: BookingRow, traceId: string): Promise<BookingRow> {
    const policy = b.policy!;
    if (!needsApproval(policy.approvalMode as 'always' | 'out_of_policy' | 'never', policy)) {
      return this.payInternal(b.reference, traceId, user.id);
    }
    const token = randomBytes(24).toString('base64url');
    return this.db.tx(async (client) => {
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'pending_approval', updated_at = now() WHERE id = $1 AND status = 'held' ${RETURNING}`,
        [b.id],
      );
      const { rows: req } = await client.query<{ id: string }>(
        `INSERT INTO policy.approval_request (booking_id, booking_reference, corporate_id, traveller_id, approver_id, token_hash, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7)) RETURNING id`,
        [b.id, b.reference, b.tenant_id, user.id, policy.approverId, sha256(token), APPROVAL_LINK_HOURS],
      );
      const approver = await client.query<{ email: string; name: string }>(`SELECT email, name FROM tenancy.app_user WHERE id = $1`, [
        policy.approverId,
      ]);
      const link = `${this.config.PORTAL_URL}/approve/${req[0].id}?token=${token}`;
      const msg = approvalRequested({
        approverName: approver.rows[0].name,
        travellerName: user.name,
        reference: b.reference,
        trip: this.tripSummary(b),
        price: `${b.currency} ${(b.agent_cost_amount / 100).toFixed(2)}`,
        violations: policy.violations,
        reason: policy.reasonForException,
        link,
        validHours: APPROVAL_LINK_HOURS,
      });
      // Queued directly (not via the outbox) so the one-time link never sits in an event payload.
      await client.query(
        `INSERT INTO notify.notification (channel, recipient, template, subject, body_text, body_html, ref_type, ref_id, dedupe_key)
         VALUES ('email', $1, 'approval.requested', $2, $3, $4, 'booking', $5, $6)`,
        [approver.rows[0].email, msg.subject, msg.text, msg.html, b.reference, `approval.requested:${req[0].id}`],
      );
      await this.event(client, b, 'approval_requested', { approvalId: req[0].id, approverId: policy.approverId, traceId });
      return rows[0];
    });
  }

  /**
   * Continues an approved trip. If the supplier hold lapsed while it waited, the trip is held again;
   * if the price moved in the meantime, the trip expires and the traveller rebooks, because the
   * approver agreed to a specific price.
   */
  async resumeAfterApproval(reference: string, approverId: string, traceId: string): Promise<BookingRow> {
    const b = await this.db.one<BookingRow>(`${SELECT} WHERE reference = $1`, [reference]);
    if (!b) throw notFound('Booking');
    if (b.status !== 'pending_approval') throw conflict('INVALID_STATE', `A ${b.status} booking cannot be approved`);
    let refreshed: { pnr: string | null; holdExpiresAt: string | null } | 'price_changed' | null = null;
    if (b.hold_expires_at && b.hold_expires_at.getTime() < Date.now()) refreshed = await this.reHold(b, traceId);
    if (refreshed === 'price_changed') {
      return this.db.tx(async (client) => {
        const { rows } = await client.query<BookingRow>(
          `UPDATE booking.booking SET status = 'expired', failure_reason = 'PRICE_CHANGED_BEFORE_APPROVAL', updated_at = now()
            WHERE id = $1 ${RETURNING}`,
          [b.id],
        );
        await this.event(client, b, 'expired', { reason: 'PRICE_CHANGED_BEFORE_APPROVAL', approvedBy: approverId });
        return rows[0];
      });
    }
    await this.db.tx(async (client) => {
      await client.query(
        `UPDATE booking.booking SET status = 'held', pnr = COALESCE($2, pnr), hold_expires_at = COALESCE($3, hold_expires_at), updated_at = now()
          WHERE id = $1`,
        [b.id, refreshed?.pnr ?? null, refreshed?.holdExpiresAt ?? null],
      );
      await this.event(client, b, 'approved', { by: approverId, reHeld: !!refreshed, traceId });
    });
    return this.payInternal(b.reference, traceId, approverId);
  }

  async rejectAfterApproval(reference: string, approverId: string, comment: string | undefined, traceId: string): Promise<BookingRow> {
    const b = await this.db.one<BookingRow>(`${SELECT} WHERE reference = $1`, [reference]);
    if (!b) throw notFound('Booking');
    if (b.status !== 'pending_approval') throw conflict('INVALID_STATE', `A ${b.status} booking cannot be rejected`);
    await this.release(b, traceId).catch((err) => this.logger.warn(`Release after rejection failed: ${(err as Error).message}`));
    return this.db.tx(async (client) => {
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'rejected', updated_at = now() WHERE id = $1 ${RETURNING}`,
        [b.id],
      );
      await this.event(client, b, 'rejected', { by: approverId, comment });
      return rows[0];
    });
  }

  /** Re-holds an expired hold at the supplier; returns 'price_changed' if the price is no longer the approved one. */
  private async reHold(b: BookingRow, traceId: string) {
    const ctx = { traceId, tenantId: b.tenant_id, timeoutMs: 30_000 };
    const pricer = await this.pricing.pricerFor(b.tenant_path);
    if (b.product === 'insurance') {
      const s = b.offer_snapshot as unknown as InsuranceSnapshot;
      const plan = await this.insurance.plan(s.plan.code);
      const premium = premiumFor(plan, { ...s.request, travellers: b.passengers as InsuredTraveller[] });
      if ('unavailable' in premium) return 'price_changed' as const;
      const q = pricer(money(premium.net, plan.currency), this.insurance.pricingContext(plan, 'b2e'));
      if (q.sell.amount !== b.sell_amount) return 'price_changed' as const;
      return { pnr: null, holdExpiresAt: new Date(Date.now() + INSURANCE_PRICE_LOCK_MINUTES * 60_000).toISOString() };
    }
    if (b.product === 'hotel') {
      const s = b.offer_snapshot as HotelSnapshot;
      const rate = await this.hotelRegistry.call(b.supplier, ctx, (sup) => sup.checkRate(s.rate, s.request, ctx));
      const q = pricer(rate.price.total, this.hotelSearch.pricingContext(s.request, rate, 'b2e'));
      if (q.sell.amount !== b.sell_amount) return 'price_changed' as const;
      return { pnr: null, holdExpiresAt: new Date(Date.now() + HOTEL_PRICE_LOCK_MINUTES * 60_000).toISOString() };
    }
    const offer = await this.registry.call(b.supplier, ctx, (sup) => sup.reprice(b.offer_snapshot, ctx));
    const q = pricer(offer.price.total, this.search.pricingContext(undefined, offer, 'b2e'));
    if (q.sell.amount !== b.sell_amount) return 'price_changed' as const;
    const hold = await this.registry.call(b.supplier, ctx, (sup) => sup.hold(offer, b.passengers as Passenger[], ctx));
    return { pnr: hold.pnr, holdExpiresAt: hold.holdExpiresAt ?? null };
  }

  /** Checks the policy verdict before anything is held, and builds the record stored with the booking. */
  private async corporatePolicy(
    traveller: TravellerContext,
    verdict: PolicyVerdict,
    input: CorporateExtras,
    sellAmount: number,
    lowestSell: number | undefined,
  ): Promise<PolicyRecord> {
    if (!verdict.inPolicy && !input.reasonForException?.trim()) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'REASON_REQUIRED', 'This option is outside your travel policy. Give a reason to continue.', {
        violations: verdict.violations,
      });
    }
    const record: PolicyRecord = {
      grade: traveller.grade,
      approvalMode: traveller.policy.approvalMode,
      inPolicy: verdict.inPolicy,
      violations: verdict.violations,
      reasonForException: verdict.inPolicy ? undefined : input.reasonForException?.trim(),
      lowestSell,
      missedSaving: lowestSell !== undefined ? Math.max(0, sellAmount - lowestSell) : 0,
      approverId: traveller.approverId,
    };
    if (needsApproval(traveller.policy.approvalMode, verdict) && !traveller.approverId) {
      throw conflict('NO_APPROVER', 'This trip needs approval but you have no approver. Ask your travel manager to assign one.');
    }
    return record;
  }

  private tripSummary(b: BookingRow): string {
    if (b.product === 'insurance') {
      const s = b.offer_snapshot as unknown as InsuranceSnapshot;
      return `${s.plan.name}, ${REGION_LABEL[s.request.region]}, ${s.request.startDate} to ${s.request.endDate}`;
    }
    if (b.product === 'hotel') {
      const s = b.offer_snapshot as HotelSnapshot;
      return `${s.hotel.name}, ${s.hotel.city}, ${s.request.checkIn} to ${s.request.checkOut}`;
    }
    const first = b.offer_snapshot.slices[0].segments[0];
    const last = b.offer_snapshot.slices[0].segments.at(-1)!;
    return `${first.origin} to ${last.destination}${b.offer_snapshot.slices.length > 1 ? ' and back' : ''}, ${first.departureLocal.slice(0, 10)}`;
  }

  private fulfil(b: BookingRow, operatorId: string, traceId: string): Promise<BookingRow> {
    if (b.product === 'insurance') return this.issuePolicy(b, operatorId, traceId);
    return b.product === 'hotel' ? this.bookHotel(b, operatorId, traceId) : this.ticketFlight(b, operatorId, traceId);
  }

  /** Issues the policy. One attempt, keyed by our reference, so a retry never creates a second policy. */
  private async issuePolicy(b: BookingRow, operatorId: string, traceId: string): Promise<BookingRow> {
    const s = b.offer_snapshot as unknown as InsuranceSnapshot;
    const ctx = { traceId, tenantId: b.tenant_id, timeoutMs: 30_000, idempotencyKey: `issue:${b.reference}` };
    try {
      const issued = await this.insurers.call(b.supplier, ctx, (p) =>
        p.issue(
          {
            planCode: s.plan.code,
            region: s.request.region,
            startDate: s.request.startDate,
            endDate: s.request.endDate,
            travellers: b.passengers as InsuredTraveller[],
            premium: money(b.net_amount, b.currency),
            reference: b.reference,
          },
          ctx,
        ),
      );
      return this.succeed(b, { pnr: issued.policyNumber, fulfilment: { policyNumber: issued.policyNumber } }, 'confirmed', {
        policyNumber: issued.policyNumber,
        traceId,
      });
    } catch (err) {
      this.logger.warn({ traceId, booking: b.reference }, `Policy issue failed: ${(err as Error).message}`);
      const reason = err instanceof SupplierError ? err.code : SupplierErrorCode.BOOKING_FAILED;
      return this.failAndRefund(b, operatorId, reason, 'booking_failed', traceId);
    }
  }

  private async ticketFlight(b: BookingRow, operatorId: string, traceId: string): Promise<BookingRow> {
    const ctx = { traceId, tenantId: b.tenant_id, timeoutMs: 30_000, idempotencyKey: `ticket:${b.reference}` };
    const ref = { supplier: b.supplier, pnr: b.pnr!, holdExpiresAt: b.hold_expires_at?.toISOString() };
    let lastError: unknown;
    for (let attempt = 1; attempt <= TICKET_ATTEMPTS; attempt++) {
      try {
        const result = await this.registry.call(b.supplier, ctx, (s) => s.ticket(ref, ctx));
        return this.succeed(b, { ticketNumbers: result.ticketNumbers }, 'ticketed', { ticketNumbers: result.ticketNumbers, attempt, traceId });
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
    const reason = lastError instanceof SupplierError ? lastError.code : SupplierErrorCode.TICKETING_FAILED;
    return this.failAndRefund(b, operatorId, reason, 'ticketing_failed', traceId);
  }

  /**
   * Books the room. Deliberately a single attempt: a retried hotel booking can create a second
   * reservation. A timeout is ambiguous, so it is refunded and left for operations to check with
   * the supplier.
   */
  private async bookHotel(b: BookingRow, operatorId: string, traceId: string): Promise<BookingRow> {
    const snap = b.offer_snapshot as HotelSnapshot;
    const ctx = { traceId, tenantId: b.tenant_id, timeoutMs: 30_000, idempotencyKey: `book:${b.reference}` };
    try {
      const result = await this.hotelRegistry.call(b.supplier, ctx, (s) =>
        s.book(snap.rate, snap.request, b.passengers as HotelGuest[], ctx),
      );
      return this.succeed(
        b,
        { pnr: result.supplierReference, fulfilment: { supplierReference: result.supplierReference, hotelConfirmation: result.hotelConfirmation } },
        'confirmed',
        { supplierReference: result.supplierReference, hotelConfirmation: result.hotelConfirmation, traceId },
      );
    } catch (err) {
      this.logger.warn({ traceId, booking: b.reference }, `Hotel booking failed: ${(err as Error).message}`);
      const reason = err instanceof SupplierError ? err.code : SupplierErrorCode.BOOKING_FAILED;
      return this.failAndRefund(b, operatorId, reason, 'booking_failed', traceId);
    }
  }

  private succeed(
    b: BookingRow,
    result: { ticketNumbers?: string[]; pnr?: string; fulfilment?: Record<string, unknown> },
    eventType: string,
    eventData: Record<string, unknown>,
  ): Promise<BookingRow> {
    return this.db.tx(async (client) => {
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'confirmed', ticket_numbers = COALESCE($2, ticket_numbers),
                pnr = COALESCE($3, pnr), fulfilment = fulfilment || $4::jsonb, updated_at = now()
          WHERE id = $1 ${RETURNING}`,
        [b.id, result.ticketNumbers ?? null, result.pnr ?? null, JSON.stringify(result.fulfilment ?? {})],
      );
      await this.event(client, b, eventType, eventData);
      return rows[0];
    });
  }

  private failAndRefund(b: BookingRow, operatorId: string, reason: string, eventType: string, traceId: string): Promise<BookingRow> {
    return this.db.tx(async (client) => {
      await this.ledger.refundBooking(client, b.tenant_id, operatorId, money(b.agent_cost_amount, b.currency), b.reference);
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1 ${RETURNING}`,
        [b.id, reason],
      );
      await this.event(client, b, eventType, { reason, traceId });
      await this.event(client, b, 'refunded', { amount: b.agent_cost_amount, currency: b.currency });
      return rows[0];
    });
  }

  // ---------- cancel ----------

  async cancel(user: AuthUser, reference: string, traceId: string) {
    const b = await this.getRow(user, reference);
    if (b.status === 'cancelled') return this.view(user, b);
    if (b.status === 'confirmed' && b.product === 'hotel') return this.view(user, await this.cancelConfirmedHotel(user, b, traceId));
    if (b.status === 'confirmed' && b.product === 'insurance') return this.view(user, await this.cancelPolicy(user, b, traceId));
    if (b.status !== 'held') {
      throw conflict(
        'INVALID_STATE',
        'Only held bookings can be cancelled here. Raise an offline change request for ticketed flights.',
      );
    }
    await this.release(b, traceId);
    const row = await this.db.tx(async (client) => {
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'held' ${RETURNING}`,
        [b.id],
      );
      if (rows[0]) await this.event(client, b, 'cancelled', { traceId, by: user.id });
      return rows[0] ?? b;
    });
    return this.view(user, row);
  }

  /**
   * Cancels a confirmed hotel stay with the supplier. The agency gets back what it paid, reduced in
   * proportion to the supplier's penalty (a penalty of the full net price refunds nothing).
   */
  private async cancelConfirmedHotel(user: AuthUser, b: BookingRow, traceId: string): Promise<BookingRow> {
    if (b.tenant_id !== user.tenantId && !hasRole(user, 'ops')) throw forbidden('Only the booking agency can cancel this stay');
    const ctx = { traceId, tenantId: b.tenant_id, timeoutMs: 30_000 };
    const result = await this.hotelRegistry.call(b.supplier, ctx, (s) => s.cancel(b.pnr!, ctx));
    if (!result.cancelled) throw conflict('CANCEL_REJECTED', 'The hotel supplier did not accept the cancellation');
    const penaltyShare = Math.min(1, result.penalty.amount / Math.max(b.net_amount, 1));
    const refund = Math.max(0, Math.round(b.agent_cost_amount * (1 - penaltyShare)));
    const operatorId = await this.operatorIdFor(b.tenant_path);
    return this.db.tx(async (client) => {
      if (refund > 0) await this.ledger.refundBooking(client, b.tenant_id, operatorId, money(refund, b.currency), b.reference);
      const cancellation = { penalty: result.penalty, refunded: { amount: refund, currency: b.currency } };
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'cancelled', fulfilment = fulfilment || $2::jsonb, updated_at = now()
          WHERE id = $1 ${RETURNING}`,
        [b.id, JSON.stringify({ cancellation })],
      );
      await this.event(client, b, 'cancelled', { traceId, by: user.id, ...cancellation });
      if (refund > 0) await this.event(client, b, 'refunded', { amount: refund, currency: b.currency });
      return rows[0];
    });
  }

  /** Cancels a policy before cover starts, with a full refund of what the agency paid. */
  private async cancelPolicy(user: AuthUser, b: BookingRow, traceId: string): Promise<BookingRow> {
    if (b.tenant_id !== user.tenantId && !hasRole(user, 'ops')) throw forbidden('Only the booking agency can cancel this policy');
    const s = b.offer_snapshot as unknown as InsuranceSnapshot;
    if (new Date().toISOString().slice(0, 10) >= s.request.startDate) {
      throw conflict('COVER_STARTED', 'Cover has started, so the policy can no longer be cancelled online. Contact the insurer for a claim or refund.');
    }
    const ctx = { traceId, tenantId: b.tenant_id, timeoutMs: 30_000 };
    const result = await this.insurers.call(b.supplier, ctx, (p) => p.cancel(b.pnr!, ctx));
    if (!result.cancelled) throw conflict('CANCEL_REJECTED', 'The insurer did not accept the cancellation');
    const operatorId = await this.operatorIdFor(b.tenant_path);
    return this.db.tx(async (client) => {
      await this.ledger.refundBooking(client, b.tenant_id, operatorId, money(b.agent_cost_amount, b.currency), b.reference);
      const cancellation = { penalty: money(0, b.currency), refunded: money(b.agent_cost_amount, b.currency) };
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'cancelled', fulfilment = fulfilment || $2::jsonb, updated_at = now() WHERE id = $1 ${RETURNING}`,
        [b.id, JSON.stringify({ cancellation })],
      );
      await this.event(client, b, 'cancelled', { traceId, by: user.id, ...cancellation });
      await this.event(client, b, 'refunded', { amount: b.agent_cost_amount, currency: b.currency });
      return rows[0];
    });
  }

  /** Gives back whatever the supplier is holding for an unpaid booking. Hotels hold nothing. */
  private async release(b: BookingRow, traceId: string) {
    if (b.product !== 'flight' || !b.pnr) return;
    const ctx = { traceId, tenantId: b.tenant_id, timeoutMs: 15_000 };
    await this.registry.call(b.supplier, ctx, (s) => s.cancel({ supplier: b.supplier, pnr: b.pnr! }, ctx));
  }

  // ---------- read ----------

  async list(user: AuthUser, filter: { status?: string; product?: string; limit: number }) {
    const wholeSubtree = hasRole(user, 'admin', 'ops', 'finance');
    const { rows } = await this.db.query<BookingRow>(
      `${SELECT} WHERE tenant_path <@ $1::ltree AND ($5 OR tenant_path = $1::ltree)
         AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR product = $3)
       ORDER BY created_at DESC LIMIT $4`,
      [user.tenantPath, filter.status ?? null, filter.product ?? null, filter.limit, wholeSubtree],
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

  /** The traveller document: e-ticket receipt for flights, accommodation voucher for hotels. */
  async document(user: AuthUser, reference: string): Promise<{ filename: string; pdf: Buffer }> {
    const b = await this.getRow(user, reference);
    if (b.status !== 'confirmed') throw conflict('INVALID_STATE', 'Documents are available once the booking is confirmed');
    const issuer = await this.tenancy.get(b.tenant_id);
    const total = `${b.currency} ${(b.sell_amount / 100).toFixed(2)}`;
    if (b.product === 'insurance') {
      const s = b.offer_snapshot as unknown as InsuranceSnapshot;
      const pdf = await renderInsuranceCertificate({
        reference: b.reference,
        issuedBy: issuer.name,
        policyNumber: b.pnr ?? '',
        planName: s.plan.name,
        region: REGION_LABEL[s.request.region],
        startDate: s.request.startDate,
        endDate: s.request.endDate,
        days: s.days,
        travellers: b.passengers as InsuredTraveller[],
        coverage: s.plan.coverage,
        total,
        emergencyContact: ASSISTANCE_LINE,
      });
      return { filename: `insurance-${b.reference}.pdf`, pdf };
    }
    if (b.product === 'hotel') {
      const s = b.offer_snapshot as HotelSnapshot;
      const pdf = await renderHotelVoucher({
        reference: b.reference,
        issuedBy: issuer.name,
        supplierReference: b.pnr ?? '',
        hotelConfirmation: (b.fulfilment.hotelConfirmation as string) ?? undefined,
        hotel: s.hotel,
        checkIn: s.request.checkIn,
        checkOut: s.request.checkOut,
        nights: nightsBetween(s.request.checkIn, s.request.checkOut),
        rooms: s.request.rooms.map((r, i) => ({ adults: r.adults, children: r.childAges?.length ?? 0, guest: b.passengers[i] as HotelGuest })),
        roomName: s.rate.roomName,
        board: s.rate.board,
        specialRequests: s.specialRequests,
        cancellation: s.rate.refundable ? `Free cancellation until ${s.rate.freeCancellationUntil?.slice(0, 10)}` : 'Non-refundable',
        total,
      });
      return { filename: `voucher-${b.reference}.pdf`, pdf };
    }
    const bag = b.offer_snapshot.baggage?.[0];
    const pdf = await renderETicket({
      reference: b.reference,
      pnr: b.pnr ?? '',
      issuedBy: issuer.name,
      passengers: b.passengers,
      ticketNumbers: b.ticket_numbers,
      slices: b.offer_snapshot.slices,
      fareBrand: b.offer_snapshot.fareBrand,
      baggage: bag ? `${bag.checkedPieces} checked piece(s), ${bag.cabinKg} kg cabin` : undefined,
      total,
    });
    return { filename: `eticket-${b.reference}.pdf`, pdf };
  }

  // ---------- background jobs ----------

  /**
   * Marks holds past their time limit as expired and releases anything the supplier holds.
   * Rows are claimed by the UPDATE itself, so concurrent runners never expire one booking twice.
   */
  async expireHolds(batch = 100): Promise<string[]> {
    const expired = await this.db.tx(async (client) => {
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET status = 'expired', updated_at = now()
          WHERE id IN (SELECT id FROM booking.booking WHERE status = 'held' AND hold_expires_at < now()
                        ORDER BY hold_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
          ${RETURNING}`,
        [batch],
      );
      for (const b of rows) await this.event(client, b, 'expired', { holdExpiresAt: b.hold_expires_at });
      return rows;
    });
    for (const b of expired) {
      await this.release(b, 'job:expire-holds').catch((err) =>
        this.logger.warn(`Could not release expired hold ${b.reference}: ${(err as Error).message}`),
      );
    }
    return expired.map((b) => b.reference);
  }

  /**
   * Finishes flight bookings that were paid but never reached confirmed or failed, for example
   * because the process died mid-ticketing. Ticketing is idempotent per PNR and the refund is
   * idempotent per booking, so retrying is safe. Stuck hotel bookings are NOT retried (a second
   * attempt could book a second room); they stay in the operations queue for a person to check.
   */
  async recoverStuckTicketing(olderThanSeconds = 300, batch = 20): Promise<string[]> {
    const { rows } = await this.db.query<BookingRow>(
      `UPDATE booking.booking SET updated_at = now()
        WHERE id IN (SELECT id FROM booking.booking WHERE status = 'ticketing' AND product = 'flight'
                      AND updated_at < now() - make_interval(secs => $1) LIMIT $2 FOR UPDATE SKIP LOCKED)
        ${RETURNING}`,
      [olderThanSeconds, batch],
    );
    const done: string[] = [];
    for (const b of rows) {
      const result = await this.ticketFlight(b, await this.operatorIdFor(b.tenant_path), 'job:recover-ticketing');
      done.push(`${b.reference}:${result.status}`);
    }
    return done;
  }

  // ---------- operations ----------

  /** Bookings that need a person: failed and not yet resolved, or stuck in fulfilment. */
  async opsQueue(user: AuthUser) {
    if (!hasRole(user, 'ops', 'admin')) throw forbidden('Operations access required');
    const { rows } = await this.db.query<BookingRow>(
      `${SELECT} WHERE tenant_path <@ $1::ltree
         AND ((status = 'failed' AND ops_resolved_at IS NULL)
           OR (status = 'ticketing' AND updated_at < now() - interval '10 minutes'))
       ORDER BY updated_at`,
      [user.tenantPath],
    );
    return rows.map((r) => ({ ...this.view(user, r), agencyPath: r.tenant_path }));
  }

  async resolveFailure(user: AuthUser, reference: string, note: string) {
    if (!hasRole(user, 'ops', 'admin')) throw forbidden('Operations access required');
    const b = await this.getRow(user, reference);
    if (b.status !== 'failed') throw conflict('INVALID_STATE', 'Only failed bookings can be resolved');
    const row = await this.db.tx(async (client) => {
      const { rows } = await client.query<BookingRow>(
        `UPDATE booking.booking SET ops_resolved_at = now(), ops_resolved_by = $2, ops_note = $3, updated_at = now()
          WHERE id = $1 ${RETURNING}`,
        [b.id, user.id, note],
      );
      await this.event(client, b, 'ops_resolved', { note, by: user.id });
      return rows[0];
    });
    return this.view(user, row);
  }

  // ---------- helpers ----------

  private async existing(user: AuthUser, idempotencyKey: string | undefined): Promise<BookingRow | undefined> {
    if (!idempotencyKey) throw badRequest('Idempotency-Key header is required to create a booking');
    return this.db.one<BookingRow>(`${SELECT} WHERE tenant_id = $1 AND idempotency_key = $2`, [user.tenantId, idempotencyKey]);
  }

  private checkExpectedPrice(expected: number | undefined, quote: PriceQuote) {
    if (expected !== undefined && expected !== quote.sell.amount) {
      throw conflict('PRICE_CHANGED', 'The price changed since you searched. Confirm the new price to continue.', {
        previousSellAmount: expected,
        newSellAmount: quote.sell.amount,
        currency: quote.sell.currency,
      });
    }
  }

  private async insertHeld(
    user: AuthUser,
    idempotencyKey: string,
    traceId: string,
    p: {
      policy?: PolicyRecord | null;
      product: Product;
      supplier: string;
      snapshot: object;
      passengers: object[];
      contact: object;
      quote: PriceQuote;
      pnr: string | null;
      holdExpiresAt: string | null;
      release?: () => Promise<void>;
    },
  ) {
    try {
      const row = await this.db.tx(async (client) => {
        const { rows } = await client.query<BookingRow>(
          `INSERT INTO booking.booking (reference, tenant_id, tenant_path, created_by, channel, product, status, supplier,
             offer_snapshot, passengers, contact, currency, net_amount, agent_cost_amount, sell_amount,
             pricing_breakdown, pnr, hold_expires_at, idempotency_key, policy)
           VALUES ($1,$2,$3::ltree,$4,$18,$5,'held',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$19) ${RETURNING}`,
          [
            newReference(),
            user.tenantId,
            user.tenantPath,
            user.id,
            p.product,
            p.supplier,
            JSON.stringify(p.snapshot),
            JSON.stringify(p.passengers),
            JSON.stringify(p.contact),
            p.quote.sell.currency,
            p.quote.net.amount,
            p.quote.agentCost.amount,
            p.quote.sell.amount,
            JSON.stringify(p.quote.breakdown),
            p.pnr,
            p.holdExpiresAt,
            idempotencyKey,
            channelFor(user),
            p.policy ? JSON.stringify(p.policy) : null,
          ],
        );
        await this.event(client, rows[0], 'held', { pnr: p.pnr, traceId, by: user.id });
        return rows[0];
      });
      if (row.policy) return this.view(user, await this.afterCorporateHold(user, row, traceId));
      return this.view(user, row);
    } catch (err) {
      // Two requests with the same key raced: release our duplicate hold, return the winner.
      if ((err as { code?: string }).code === '23505') {
        await p.release?.().catch(() => undefined);
        const winner = await this.db.one<BookingRow>(`${SELECT} WHERE tenant_id = $1 AND idempotency_key = $2`, [
          user.tenantId,
          idempotencyKey,
        ]);
        if (winner) return this.view(user, winner);
      }
      throw err;
    }
  }

  private async hotelContent(hotelId: string) {
    const row = await this.db.one(`SELECT id, name, city, address, stars FROM hotels.hotel WHERE id = $1`, [hotelId]);
    if (!row) throw notFound('Hotel');
    return row as HotelSnapshot['hotel'];
  }

  private async operatorIdFor(tenantPath: string): Promise<string> {
    return (await this.tenancy.ancestors(tenantPath))[0].id;
  }

  /** Agents see their own tenant's bookings; admins, ops and finance see their whole subtree. */
  private canSee(user: AuthUser, b: BookingRow): boolean {
    if (b.tenant_path === user.tenantPath) return true;
    return hasRole(user, 'admin', 'ops', 'finance') && this.tenancy.inScope(user, b.tenant_path);
  }

  private async getRow(user: AuthUser, reference: string): Promise<BookingRow> {
    const b = await this.db.one<BookingRow>(`${SELECT} WHERE reference = $1`, [reference.toUpperCase()]);
    if (!b || !this.canSee(user, b)) throw notFound('Booking');
    return b;
  }

  /** Appends to the booking's own history and, for public state changes, to the outbox in the same transaction. */
  private async event(client: PoolClient, b: Pick<BookingRow, 'id' | 'reference' | 'tenant_id'>, type: string, data: Record<string, unknown>) {
    await client.query(`INSERT INTO booking.booking_event (booking_id, type, data) VALUES ($1, $2, $3)`, [
      b.id,
      type,
      JSON.stringify(data),
    ]);
    const published = PUBLIC_EVENTS[type];
    if (published) await this.outbox.add(client, published, 'booking', b.reference, b.tenant_id, { reference: b.reference, ...data });
  }

  private view(user: AuthUser, b: BookingRow) {
    const ownMarkup = b.sell_amount - b.agent_cost_amount;
    const common = {
      reference: b.reference,
      product: b.product,
      status: b.status,
      supplier: user.tenantType === 'operator' ? b.supplier : undefined,
      pnr: b.pnr,
      holdExpiresAt: b.hold_expires_at,
      failureReason: b.failure_reason,
      opsResolution: b.ops_resolved_at ? { at: b.ops_resolved_at, note: b.ops_note } : null,
      channel: b.channel,
      policy: b.policy,
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
    if (b.product === 'insurance') {
      const s = b.offer_snapshot as unknown as InsuranceSnapshot;
      return {
        ...common,
        ticketNumbers: [],
        plan: s.plan,
        cover: { ...s.request, regionLabel: REGION_LABEL[s.request.region], days: s.days },
        policyNumber: (b.fulfilment.policyNumber as string) ?? null,
        linkedReference: s.linkedReference ?? null,
        cancellation: b.fulfilment.cancellation ?? null,
      };
    }
    if (b.product === 'hotel') {
      const s = b.offer_snapshot as HotelSnapshot;
      return {
        ...common,
        ticketNumbers: [],
        hotel: s.hotel,
        stay: {
          checkIn: s.request.checkIn,
          checkOut: s.request.checkOut,
          nights: nightsBetween(s.request.checkIn, s.request.checkOut),
          rooms: s.request.rooms,
        },
        room: { name: s.rate.roomName, board: s.rate.board, refundable: s.rate.refundable, freeCancellationUntil: s.rate.freeCancellationUntil },
        hotelConfirmation: b.fulfilment.hotelConfirmation ?? null,
        cancellation: b.fulfilment.cancellation ?? null,
        specialRequests: s.specialRequests,
      };
    }
    return {
      ...common,
      ticketNumbers: b.ticket_numbers,
      itinerary: b.offer_snapshot.slices,
      fareBrand: b.offer_snapshot.fareBrand,
      refundable: b.offer_snapshot.refundable,
    };
  }
}

/** Human-friendly reference, e.g. TW-7K3M9Q. No 0/O/1/I to avoid misreading over the phone. */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function newReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return `TW-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}
