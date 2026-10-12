import { Money } from './money';
import { CallContext } from './supplier';

export interface HotelSearchRequest {
  /** IATA city code, e.g. NBO, ZNZ, DXB */
  city: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  rooms: { adults: number; childAges?: number[] }[];
  nationality?: string; // ISO country; some hotels price by guest nationality
}

/** Static descriptive content for one property, as a supplier describes it. */
export interface SupplierHotelContent {
  supplierHotelId: string;
  name: string;
  city: string;
  stars: number;
  address: string;
  latitude: number;
  longitude: number;
  amenities: string[];
  images: string[];
}

export type BoardBasis = 'RO' | 'BB' | 'HB' | 'FB' | 'AI';

export interface CancellationPenalty {
  /** From this moment (ISO) the penalty applies. */
  from: string;
  amount: Money;
}

/** A bookable price for one room combination for the whole stay, in supplier net terms. */
export interface HotelRate {
  rateId: string;
  supplier: string;
  supplierHotelId: string;
  roomName: string;
  board: BoardBasis;
  refundable: boolean;
  /** Free cancellation until this moment (ISO), if refundable. */
  freeCancellationUntil?: string;
  penalties: CancellationPenalty[];
  price: { net: Money; total: Money };
  validUntil: string;
}

export interface HotelAvailability {
  content: SupplierHotelContent;
  rates: HotelRate[];
}

export interface HotelGuest {
  title: 'MR' | 'MRS' | 'MS' | 'MSTR' | 'MISS';
  firstName: string;
  lastName: string;
}

export interface HotelBookingResult {
  supplierReference: string;
  /** Confirmation number from the property itself, when the supplier provides it. */
  hotelConfirmation?: string;
}

export interface HotelCancelResult {
  cancelled: boolean;
  penalty: Money;
}

export interface HotelSupplier {
  readonly code: string;
  search(req: HotelSearchRequest, ctx: CallContext): Promise<HotelAvailability[]>;
  /** Re-checks a rate right before booking; may return a new price or throw SOLD_OUT. */
  checkRate(rate: HotelRate, req: HotelSearchRequest, ctx: CallContext): Promise<HotelRate>;
  book(rate: HotelRate, req: HotelSearchRequest, guests: HotelGuest[], ctx: CallContext): Promise<HotelBookingResult>;
  cancel(supplierReference: string, ctx: CallContext): Promise<HotelCancelResult>;
}
