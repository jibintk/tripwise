import {
  CancelResult,
  FareRules,
  FlightOffer,
  FlightSearchRequest,
  Passenger,
  SupplierBookingRef,
  TicketResult,
} from './flights';

/** Carried on every supplier call: tracing, tenant, idempotency and the remaining time budget. */
export interface CallContext {
  traceId: string;
  tenantId: string;
  idempotencyKey?: string;
  timeoutMs: number;
}

export interface FlightSupplierCapabilities {
  hold: boolean;
  brandedFares: boolean;
  importPnr: boolean;
}

/**
 * Every flight content source (GDS, NDC aggregator, own inventory) implements this interface.
 * Adapters map supplier formats and errors into the canonical model; nothing outside the
 * adapter ever sees a supplier-specific payload.
 */
export interface FlightSupplier {
  readonly code: string;
  readonly capabilities: FlightSupplierCapabilities;
  search(req: FlightSearchRequest, ctx: CallContext): Promise<FlightOffer[]>;
  fareRules(offer: FlightOffer, ctx: CallContext): Promise<FareRules>;
  reprice(offer: FlightOffer, ctx: CallContext): Promise<FlightOffer>;
  hold(offer: FlightOffer, passengers: Passenger[], ctx: CallContext): Promise<SupplierBookingRef>;
  ticket(ref: SupplierBookingRef, ctx: CallContext): Promise<TicketResult>;
  cancel(ref: SupplierBookingRef, ctx: CallContext): Promise<CancelResult>;
  importPnr?(pnr: string, ctx: CallContext): Promise<{ offer: FlightOffer; passengers: Passenger[]; ref: SupplierBookingRef }>;
}

export const SupplierErrorCode = {
  SUPPLIER_TIMEOUT: 'SUPPLIER_TIMEOUT',
  PRICE_CHANGED: 'PRICE_CHANGED',
  SOLD_OUT: 'SOLD_OUT',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  INVALID_PASSENGER_DATA: 'INVALID_PASSENGER_DATA',
  TICKETING_FAILED: 'TICKETING_FAILED',
  /** Non-flight fulfilment (hotel, insurance, transfer) was rejected after payment. */
  BOOKING_FAILED: 'BOOKING_FAILED',
  SUPPLIER_UNAVAILABLE: 'SUPPLIER_UNAVAILABLE',
  AUTH_FAILED: 'AUTH_FAILED',
} as const;
export type SupplierErrorCode = (typeof SupplierErrorCode)[keyof typeof SupplierErrorCode];

export class SupplierError extends Error {
  constructor(
    public readonly code: SupplierErrorCode,
    message: string,
    public readonly supplier: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SupplierError';
  }
}
