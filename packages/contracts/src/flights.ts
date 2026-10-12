import { Money } from './money';

export type PassengerType = 'ADT' | 'CHD' | 'INF';
export type Cabin = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';

export interface FlightSearchRequest {
  origin: string; // IATA airport code
  destination: string; // IATA airport code
  departureDate: string; // YYYY-MM-DD
  returnDate?: string; // YYYY-MM-DD for a return trip
  passengers: { ADT: number; CHD?: number; INF?: number };
  cabin: Cabin;
}

export interface Segment {
  marketingCarrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureLocal: string; // ISO local time as published by the supplier
  arrivalLocal: string;
  durationMin: number;
}

export interface Slice {
  segments: Segment[];
  durationMin: number;
}

export interface BaggageAllowance {
  passengerType: PassengerType;
  checkedPieces: number;
  cabinKg: number;
}

/** A priced flight offer, in supplier net terms. Markup is never stored on the offer. */
export interface FlightOffer {
  offerId: string;
  supplier: string;
  slices: Slice[];
  fareBrand?: string;
  baggage: BaggageAllowance[];
  refundable: boolean;
  /** Cabin the fare is sold in. */
  cabin?: Cabin;
  price: { base: Money; taxes: Money; total: Money };
  validUntil: string; // ISO timestamp after which the offer must be repriced
}

export interface FareRules {
  offerId: string;
  refundable: boolean;
  changeable: boolean;
  text: string;
}

export interface Passenger {
  type: PassengerType;
  title: 'MR' | 'MRS' | 'MS' | 'MSTR' | 'MISS';
  firstName: string;
  lastName: string;
  dateOfBirth: string; // YYYY-MM-DD
  documentNumber?: string;
  documentExpiry?: string;
  nationality?: string;
}

export interface SupplierBookingRef {
  supplier: string;
  pnr: string;
  holdExpiresAt?: string;
}

export interface TicketResult {
  ticketNumbers: string[];
}

export interface CancelResult {
  cancelled: boolean;
}
