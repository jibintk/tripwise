import { createHash, randomBytes } from 'crypto';
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

export interface MockFlightSupplierOptions {
  code?: string;
  currency?: string;
  /** Simulated network latency per call. */
  latencyMs?: number;
  /** Routes such as "NBO-XPC" whose reprice returns a 5% higher price. */
  priceChangeRoutes?: string[];
  /** Hold time limit given to new PNRs. */
  holdMinutes?: number;
}

interface MockPnr {
  ref: SupplierBookingRef;
  offer: FlightOffer;
  passengers: Passenger[];
  status: 'HELD' | 'TICKETED' | 'CANCELLED';
  ticketNumbers: string[];
}

const CARRIERS = ['KQ', 'ET', 'EK', 'QR', 'TK', 'WB'];
const BRANDS = ['Lite', 'Classic', 'Flex'];

/**
 * Deterministic in-memory flight supplier for local development and tests.
 * The same search always returns the same offers, so tests and demos are repeatable.
 *
 * Test hooks, driven by passenger last names:
 * - SOLDOUT     -> hold fails with SOLD_OUT
 * - BADDATA     -> hold fails with INVALID_PASSENGER_DATA
 * - TICKETFAIL  -> ticketing fails with TICKETING_FAILED
 */
export class MockFlightSupplier implements FlightSupplier {
  readonly code: string;
  readonly capabilities = { hold: true, brandedFares: true, importPnr: true };
  private readonly currency: string;
  private readonly latencyMs: number;
  private readonly priceChangeRoutes: Set<string>;
  private readonly holdMinutes: number;
  private readonly pnrs = new Map<string, MockPnr>();

  constructor(options: MockFlightSupplierOptions = {}) {
    this.code = options.code ?? 'mockair';
    this.currency = options.currency ?? 'USD';
    this.latencyMs = options.latencyMs ?? 0;
    this.priceChangeRoutes = new Set(options.priceChangeRoutes ?? []);
    this.holdMinutes = options.holdMinutes ?? 60;
  }

  async search(req: FlightSearchRequest, _ctx: CallContext): Promise<FlightOffer[]> {
    await this.delay();
    const pax = req.passengers.ADT + (req.passengers.CHD ?? 0) + (req.passengers.INF ?? 0) * 0.1;
    const seed = `${req.origin}${req.destination}${req.departureDate}${req.returnDate ?? ''}${req.cabin}`;
    const cabinFactor = { ECONOMY: 1, PREMIUM_ECONOMY: 1.6, BUSINESS: 3.2, FIRST: 5 }[req.cabin];
    const offers: FlightOffer[] = [];
    for (let i = 0; i < 6; i++) {
      const r = rand(`${seed}:${i}`);
      const carrier = CARRIERS[Math.floor(r * CARRIERS.length)];
      const brand = BRANDS[i % BRANDS.length];
      const baseFare = Math.round((18000 + r * 42000 + (i % 3) * 6500) * cabinFactor * pax);
      const taxes = Math.round(baseFare * 0.18);
      const depHour = 6 + Math.floor(rand(`${seed}:h${i}`) * 15);
      const duration = 95 + Math.floor(rand(`${seed}:d${i}`) * 240);
      const slices = [this.slice(carrier, i, req.origin, req.destination, req.departureDate, depHour, duration)];
      if (req.returnDate) {
        slices.push(this.slice(carrier, i + 50, req.destination, req.origin, req.returnDate, (depHour + 7) % 22, duration));
      }
      offers.push({
        offerId: `${this.code}:${hash(`${seed}:${i}`).slice(0, 16)}`,
        supplier: this.code,
        slices,
        fareBrand: brand,
        baggage: [{ passengerType: 'ADT', checkedPieces: brand === 'Lite' ? 0 : brand === 'Classic' ? 1 : 2, cabinKg: 7 }],
        refundable: brand === 'Flex',
        cabin: req.cabin,
        price: {
          base: money(baseFare, this.currency),
          taxes: money(taxes, this.currency),
          total: money(baseFare + taxes, this.currency),
        },
        validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    }
    return offers;
  }

  async fareRules(offer: FlightOffer, _ctx: CallContext): Promise<FareRules> {
    await this.delay();
    return {
      offerId: offer.offerId,
      refundable: offer.refundable,
      changeable: offer.fareBrand !== 'Lite',
      text: offer.refundable
        ? 'Refundable before departure with a fee. Changes permitted with a fee plus fare difference.'
        : 'Non-refundable. Taxes refundable on request. Changes permitted on Classic and Flex brands only.',
    };
  }

  async reprice(offer: FlightOffer, _ctx: CallContext): Promise<FlightOffer> {
    await this.delay();
    const first = offer.slices[0].segments[0];
    const route = `${first.origin}-${offer.slices[0].segments[offer.slices[0].segments.length - 1].destination}`;
    const validUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    if (!this.priceChangeRoutes.has(route)) {
      return { ...offer, validUntil };
    }
    const base = Math.round(offer.price.base.amount * 1.05);
    const taxes = offer.price.taxes.amount;
    return {
      ...offer,
      price: {
        base: money(base, offer.price.base.currency),
        taxes: offer.price.taxes,
        total: money(base + taxes, offer.price.total.currency),
      },
      validUntil,
    };
  }

  async hold(offer: FlightOffer, passengers: Passenger[], _ctx: CallContext): Promise<SupplierBookingRef> {
    await this.delay();
    if (passengers.some((p) => p.lastName.toUpperCase() === 'SOLDOUT')) {
      throw new SupplierError(SupplierErrorCode.SOLD_OUT, 'No seats left in this fare class', this.code);
    }
    if (passengers.some((p) => p.lastName.toUpperCase() === 'BADDATA')) {
      throw new SupplierError(SupplierErrorCode.INVALID_PASSENGER_DATA, 'Passenger name rejected', this.code, {
        field: 'lastName',
      });
    }
    const pnr = randomBytes(3).toString('hex').toUpperCase();
    const ref: SupplierBookingRef = {
      supplier: this.code,
      pnr,
      holdExpiresAt: new Date(Date.now() + this.holdMinutes * 60_000).toISOString(),
    };
    this.pnrs.set(pnr, { ref, offer, passengers, status: 'HELD', ticketNumbers: [] });
    return ref;
  }

  async ticket(ref: SupplierBookingRef, _ctx: CallContext): Promise<TicketResult> {
    await this.delay();
    const record = this.pnrs.get(ref.pnr);
    if (!record) throw new SupplierError(SupplierErrorCode.HOLD_EXPIRED, 'PNR not found', this.code);
    if (record.status === 'TICKETED') return { ticketNumbers: record.ticketNumbers };
    if (record.status === 'CANCELLED') throw new SupplierError(SupplierErrorCode.HOLD_EXPIRED, 'PNR cancelled', this.code);
    if (record.ref.holdExpiresAt && Date.parse(record.ref.holdExpiresAt) < Date.now()) {
      throw new SupplierError(SupplierErrorCode.HOLD_EXPIRED, 'Hold time limit passed', this.code);
    }
    if (record.passengers.some((p) => p.lastName.toUpperCase() === 'TICKETFAIL')) {
      throw new SupplierError(SupplierErrorCode.TICKETING_FAILED, 'Ticketing rejected by carrier', this.code);
    }
    record.status = 'TICKETED';
    record.ticketNumbers = record.passengers.map(() => `176${Math.floor(1e9 + Math.random() * 9e9)}`);
    return { ticketNumbers: record.ticketNumbers };
  }

  async cancel(ref: SupplierBookingRef, _ctx: CallContext): Promise<CancelResult> {
    await this.delay();
    const record = this.pnrs.get(ref.pnr);
    if (!record) return { cancelled: false };
    record.status = 'CANCELLED';
    return { cancelled: true };
  }

  async importPnr(pnr: string, _ctx: CallContext) {
    await this.delay();
    const record = this.pnrs.get(pnr.toUpperCase());
    if (!record) throw new SupplierError(SupplierErrorCode.HOLD_EXPIRED, 'PNR not found', this.code);
    return { offer: record.offer, passengers: record.passengers, ref: record.ref };
  }

  private slice(carrier: string, i: number, from: string, to: string, date: string, depHour: number, duration: number) {
    const dep = `${date}T${String(depHour).padStart(2, '0')}:${i % 2 ? '35' : '05'}:00`;
    const arrMs = Date.parse(`${dep}Z`) + duration * 60_000;
    const arr = new Date(arrMs).toISOString().slice(0, 19);
    return {
      durationMin: duration,
      segments: [
        {
          marketingCarrier: carrier,
          flightNumber: `${carrier}${100 + ((i * 37) % 800)}`,
          origin: from,
          destination: to,
          departureLocal: dep,
          arrivalLocal: arr,
          durationMin: duration,
        },
      ],
    };
  }

  private delay() {
    return this.latencyMs > 0 ? new Promise((r) => setTimeout(r, this.latencyMs)) : Promise.resolve();
  }
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Deterministic pseudo-random number in [0, 1) from a string seed. */
function rand(seed: string): number {
  return parseInt(hash(seed).slice(0, 8), 16) / 0x1_0000_0000;
}
