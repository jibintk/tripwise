import { createHash, randomBytes } from 'crypto';
import {
  BoardBasis,
  CallContext,
  HotelAvailability,
  HotelBookingResult,
  HotelCancelResult,
  HotelGuest,
  HotelRate,
  HotelSearchRequest,
  HotelSupplier,
  money,
  SupplierError,
  SupplierErrorCode,
  SupplierHotelContent,
} from '@tripwise/contracts';

interface CatalogueHotel {
  key: string;
  name: string;
  city: string;
  stars: number;
  address: string;
  lat: number;
  lng: number;
  amenities: string[];
  /** Base price per room per night in USD minor units */
  base: number;
}

/** A small fictional catalogue: enough to exercise search, mapping and pricing in every seeded city. */
const CATALOGUE: CatalogueHotel[] = [
  { key: 'nbo1', name: 'Acacia Grand Hotel', city: 'NBO', stars: 5, address: 'Kenyatta Avenue, Nairobi', lat: -1.2864, lng: 36.8172, amenities: ['Pool', 'Spa', 'Airport shuttle', 'Wi-Fi'], base: 21000 },
  { key: 'nbo2', name: 'Westlands Business Suites', city: 'NBO', stars: 4, address: 'Waiyaki Way, Westlands', lat: -1.2676, lng: 36.8108, amenities: ['Gym', 'Wi-Fi', 'Meeting rooms'], base: 12500 },
  { key: 'nbo3', name: 'Karen Garden Lodge', city: 'NBO', stars: 3, address: 'Karen Road, Nairobi', lat: -1.3197, lng: 36.7076, amenities: ['Garden', 'Wi-Fi', 'Parking'], base: 7800 },
  { key: 'znz1', name: 'Stone Town Heritage Hotel', city: 'ZNZ', stars: 4, address: 'Shangani Street, Stone Town', lat: -6.1622, lng: 39.1871, amenities: ['Rooftop terrace', 'Wi-Fi'], base: 14500 },
  { key: 'znz2', name: 'Nungwi Coral Beach Resort', city: 'ZNZ', stars: 5, address: 'Nungwi Beach, Zanzibar', lat: -5.7266, lng: 39.2974, amenities: ['Beach', 'Pool', 'Spa', 'Diving'], base: 26000 },
  { key: 'znz3', name: 'Paje Kite House', city: 'ZNZ', stars: 3, address: 'Paje Beach, Zanzibar', lat: -6.2659, lng: 39.5352, amenities: ['Beach', 'Kitesurfing', 'Wi-Fi'], base: 6900 },
  { key: 'mba1', name: 'Diani Palm Resort', city: 'MBA', stars: 4, address: 'Diani Beach Road', lat: -4.3165, lng: 39.5797, amenities: ['Beach', 'Pool', 'Wi-Fi'], base: 13200 },
  { key: 'mba2', name: 'Fort Jesus View Inn', city: 'MBA', stars: 3, address: 'Old Town, Mombasa', lat: -4.0626, lng: 39.6797, amenities: ['Wi-Fi', 'Restaurant'], base: 6400 },
  { key: 'dxb1', name: 'Creekside Tower Hotel', city: 'DXB', stars: 4, address: 'Al Rigga, Deira, Dubai', lat: 25.2621, lng: 55.3207, amenities: ['Pool', 'Gym', 'Wi-Fi'], base: 15800 },
  { key: 'dxb2', name: 'Marina Pearl Residences', city: 'DXB', stars: 5, address: 'Dubai Marina', lat: 25.0805, lng: 55.1403, amenities: ['Pool', 'Beach access', 'Spa'], base: 29500 },
  { key: 'cpt1', name: 'Table Bay Harbour Hotel', city: 'CPT', stars: 5, address: 'V&A Waterfront, Cape Town', lat: -33.9036, lng: 18.4207, amenities: ['Sea view', 'Spa', 'Pool'], base: 24000 },
  { key: 'cpt2', name: 'Bo-Kaap Guest House', city: 'CPT', stars: 3, address: 'Wale Street, Cape Town', lat: -33.9206, lng: 18.4148, amenities: ['Wi-Fi', 'Breakfast'], base: 6200 },
  { key: 'jnb1', name: 'Sandton Gateway Hotel', city: 'JNB', stars: 4, address: 'Rivonia Road, Sandton', lat: -26.1076, lng: 28.0567, amenities: ['Gym', 'Wi-Fi', 'Airport shuttle'], base: 11800 },
];

const ROOMS: { name: string; factor: number; board: BoardBasis; refundable: boolean }[] = [
  { name: 'Standard double', factor: 1, board: 'RO', refundable: false },
  { name: 'Standard double', factor: 1.12, board: 'BB', refundable: true },
  { name: 'Deluxe king', factor: 1.45, board: 'BB', refundable: true },
  { name: 'Junior suite', factor: 2.1, board: 'HB', refundable: true },
];

export interface MockHotelSupplierOptions {
  code?: string;
  /**
   * 'a' describes hotels with tidy names and its own IDs; 'b' covers about two thirds of the same
   * hotels with different IDs, upper-case names, slightly shifted coordinates and different prices.
   * Running both shows the content-mapping step merging duplicates.
   */
  variant?: 'a' | 'b';
  currency?: string;
  /** Cities whose checkRate returns a higher price, to exercise PRICE_CHANGED. */
  priceChangeCities?: string[];
}

/**
 * Deterministic in-memory hotel supplier for development and tests.
 * Guest last-name hooks: SOLDOUT -> checkRate fails with SOLD_OUT; BOOKFAIL -> book fails after payment.
 */
export class MockHotelSupplier implements HotelSupplier {
  readonly code: string;
  private readonly variant: 'a' | 'b';
  private readonly currency: string;
  private readonly priceChangeCities: Set<string>;
  private readonly bookings = new Map<string, { rate: HotelRate; req: HotelSearchRequest; cancelled: boolean }>();

  constructor(options: MockHotelSupplierOptions = {}) {
    this.variant = options.variant ?? 'a';
    this.code = options.code ?? (this.variant === 'a' ? 'mockbeds' : 'mockstays');
    this.currency = options.currency ?? 'USD';
    this.priceChangeCities = new Set(options.priceChangeCities ?? []);
  }

  async search(req: HotelSearchRequest, _ctx: CallContext): Promise<HotelAvailability[]> {
    const nights = nightsBetween(req.checkIn, req.checkOut);
    const rooms = req.rooms.length;
    return this.catalogue()
      .filter((h) => h.city === req.city.toUpperCase())
      .map((h) => ({
        content: this.content(h),
        rates: ROOMS.map((room, i) => {
          const adultsFactor = Math.max(...req.rooms.map((r) => r.adults)) > 2 ? 1.25 : 1;
          const variantFactor = this.variant === 'a' ? 1 : 0.92 + rand(`${h.key}:${i}`) * 0.16;
          const perNight = Math.round(h.base * room.factor * adultsFactor * variantFactor);
          const total = perNight * nights * rooms;
          return this.rate(h, req, room, i, total);
        }),
      }));
  }

  async checkRate(rate: HotelRate, req: HotelSearchRequest, _ctx: CallContext): Promise<HotelRate> {
    const validUntil = new Date(Date.now() + 20 * 60_000).toISOString();
    if (!this.priceChangeCities.has(req.city.toUpperCase())) return { ...rate, validUntil };
    const total = Math.round(rate.price.total.amount * 1.06);
    return { ...rate, price: { net: money(total, rate.price.net.currency), total: money(total, rate.price.total.currency) }, validUntil };
  }

  async book(rate: HotelRate, req: HotelSearchRequest, guests: HotelGuest[], _ctx: CallContext): Promise<HotelBookingResult> {
    if (guests.some((g) => g.lastName.toUpperCase() === 'SOLDOUT')) {
      throw new SupplierError(SupplierErrorCode.SOLD_OUT, 'Room type no longer available', this.code);
    }
    if (guests.some((g) => g.lastName.toUpperCase() === 'BOOKFAIL')) {
      throw new SupplierError(SupplierErrorCode.BOOKING_FAILED, 'Property rejected the booking', this.code);
    }
    const supplierReference = `${this.code.slice(0, 2).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;
    this.bookings.set(supplierReference, { rate, req, cancelled: false });
    return { supplierReference, hotelConfirmation: String(100000 + Math.floor(Math.random() * 899999)) };
  }

  async cancel(supplierReference: string, _ctx: CallContext): Promise<HotelCancelResult> {
    const b = this.bookings.get(supplierReference);
    if (!b || b.cancelled) return { cancelled: false, penalty: money(0, this.currency) };
    b.cancelled = true;
    const now = Date.now();
    const due = b.rate.penalties.filter((p) => Date.parse(p.from) <= now).map((p) => p.amount.amount);
    return { cancelled: true, penalty: money(due.length ? Math.max(...due) : 0, b.rate.price.net.currency) };
  }

  private catalogue(): CatalogueHotel[] {
    if (this.variant === 'a') return CATALOGUE;
    return CATALOGUE.filter((_, i) => i % 3 !== 2);
  }

  private content(h: CatalogueHotel): SupplierHotelContent {
    const b = this.variant === 'b';
    return {
      supplierHotelId: b ? `B-${hash(h.key).slice(0, 8).toUpperCase()}` : `A${hash(h.key).slice(0, 6)}`,
      name: b ? `${h.name.toUpperCase()}` : h.name,
      city: h.city,
      stars: h.stars,
      address: h.address,
      latitude: b ? h.lat + 0.0002 : h.lat,
      longitude: b ? h.lng - 0.0002 : h.lng,
      amenities: h.amenities,
      images: [],
    };
  }

  private rate(h: CatalogueHotel, req: HotelSearchRequest, room: (typeof ROOMS)[number], i: number, total: number): HotelRate {
    const content = this.content(h);
    const checkIn = Date.parse(`${req.checkIn}T14:00:00Z`);
    const freeUntil = room.refundable ? new Date(checkIn - 3 * 86_400_000).toISOString() : undefined;
    const nights = nightsBetween(req.checkIn, req.checkOut);
    const firstNight = Math.round(total / Math.max(nights, 1));
    const penalties = room.refundable
      ? [{ from: freeUntil!, amount: money(firstNight, this.currency) }]
      : [{ from: new Date().toISOString(), amount: money(total, this.currency) }];
    return {
      rateId: `${this.code}:${hash(`${content.supplierHotelId}:${i}:${req.checkIn}:${req.checkOut}:${JSON.stringify(req.rooms)}`).slice(0, 16)}`,
      supplier: this.code,
      supplierHotelId: content.supplierHotelId,
      roomName: room.name,
      board: room.board,
      refundable: room.refundable,
      freeCancellationUntil: freeUntil,
      penalties,
      price: { net: money(total, this.currency), total: money(total, this.currency) },
      validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
}

function hash(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

function rand(seed: string) {
  return parseInt(hash(seed).slice(0, 8), 16) / 0x1_0000_0000;
}
