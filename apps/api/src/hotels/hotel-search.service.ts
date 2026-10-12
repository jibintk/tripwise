import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { HotelRate, HotelSearchRequest, Money, SupplierError } from '@tripwise/contracts';
import { nightsBetween } from '@tripwise/supplier-gateway';
import { createHash } from 'crypto';
import { AuthUser } from '../auth/auth.types';
import { CacheService } from '../cache/cache.service';
import { AppError, notFound } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config';
import { HotelSupplierRegistry } from '../flights/supplier-registry';
import { PriceQuote, PricingContext } from '../pricing/pricing-engine';
import { PricingService } from '../pricing/pricing.service';
import { Hotel, HotelContentService } from './hotel-content.service';

export interface CachedHotelRate {
  rate: HotelRate;
  hotelId: string;
  request: HotelSearchRequest;
}

interface CachedHotelSearch {
  request: HotelSearchRequest;
  hotels: { hotelId: string; rateIds: string[]; suppliers: string[] }[];
  suppliers: { supplier: string; status: 'ok' | 'error'; hotels: number; error?: string }[];
}

type Pricer = (net: Money, ctx: PricingContext) => PriceQuote;

@Injectable()
export class HotelSearchService {
  private readonly logger = new Logger(HotelSearchService.name);

  constructor(
    private readonly registry: HotelSupplierRegistry,
    private readonly content: HotelContentService,
    private readonly cache: CacheService,
    private readonly pricing: PricingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** One result per physical hotel, priced for the caller, cheapest first. */
  async search(user: AuthUser, req: HotelSearchRequest, traceId: string) {
    const searchId = hotelSearchKey(req);
    let cached = await this.cache.get<CachedHotelSearch>(`hsearch:${searchId}`);
    if (!cached) cached = await this.fanOut(user, req, traceId, searchId);

    const hotels = await this.content.getMany(cached.hotels.map((h) => h.hotelId));
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    const results = [];
    for (const entry of cached.hotels) {
      const rates = await this.rates(entry.rateIds);
      const hotel = hotels.get(entry.hotelId);
      if (!rates.length || !hotel) continue;
      const cheapest = rates.reduce((a, b) => (b.rate.price.total.amount < a.rate.price.total.amount ? b : a));
      const q = pricer(cheapest.rate.price.total, this.pricingContext(req, cheapest.rate));
      results.push({
        ...hotel,
        suppliers: entry.suppliers.length,
        rooms: rates.length,
        from: { agentCost: q.agentCost, sell: q.sell },
        cheapestBoard: cheapest.rate.board,
        freeCancellation: rates.some((r) => r.rate.refundable),
      });
    }
    results.sort((a, b) => a.from.sell.amount - b.from.sell.amount);
    return { searchId, nights: nightsBetween(req.checkIn, req.checkOut), suppliers: cached.suppliers, hotels: results };
  }

  /**
   * Every room offer for one hotel in a search. Identical offers (same room, board and cancellation
   * terms) from several suppliers collapse to the cheapest one.
   */
  async rooms(user: AuthUser, searchId: string, hotelId: string) {
    const cached = await this.cache.get<CachedHotelSearch>(`hsearch:${searchId}`);
    if (!cached) throw new AppError(HttpStatus.GONE, 'OFFER_EXPIRED', 'This search has expired. Search again.');
    const entry = cached.hotels.find((h) => h.hotelId === hotelId);
    const hotel = await this.content.get(hotelId);
    if (!entry || !hotel) throw notFound('Hotel');
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    const best = new Map<string, CachedHotelRate>();
    for (const r of await this.rates(entry.rateIds)) {
      const key = `${r.rate.roomName}|${r.rate.board}|${r.rate.refundable}`;
      const current = best.get(key);
      if (!current || r.rate.price.total.amount < current.rate.price.total.amount) best.set(key, r);
    }
    const offers = [...best.values()]
      .map((r) => this.present(user, r.rate, pricer(r.rate.price.total, this.pricingContext(cached.request, r.rate))))
      .sort((a, b) => a.pricing.sell.amount - b.pricing.sell.amount);
    return { hotel, request: cached.request, nights: nightsBetween(cached.request.checkIn, cached.request.checkOut), offers };
  }

  async getRate(rateId: string): Promise<CachedHotelRate> {
    const r = await this.cache.get<CachedHotelRate>(`hrate:${rateId}`);
    if (!r) throw new AppError(HttpStatus.GONE, 'OFFER_EXPIRED', 'This room offer is no longer available. Search again.');
    return r;
  }

  pricingContext(req: HotelSearchRequest, rate: HotelRate): PricingContext {
    return { product: 'hotel', channel: 'b2b', supplier: rate.supplier, destination: req.city.toUpperCase() };
  }

  present(user: AuthUser, rate: HotelRate, q: PriceQuote) {
    return {
      rateId: rate.rateId,
      roomName: rate.roomName,
      board: rate.board,
      refundable: rate.refundable,
      freeCancellationUntil: rate.freeCancellationUntil,
      supplier: user.tenantType === 'operator' ? rate.supplier : undefined,
      net: user.tenantType === 'operator' ? rate.price.net : undefined,
      pricing: {
        agentCost: q.agentCost,
        sell: q.sell,
        yourMarkup: { amount: q.sell.amount - q.agentCost.amount, currency: q.sell.currency },
      },
    };
  }

  ctx(user: AuthUser, traceId: string) {
    return { traceId, tenantId: user.tenantId, timeoutMs: this.config.SEARCH_SUPPLIER_TIMEOUT_MS };
  }

  private async rates(ids: string[]): Promise<CachedHotelRate[]> {
    const all = await Promise.all(ids.map((id) => this.cache.get<CachedHotelRate>(`hrate:${id}`)));
    return all.filter((r): r is CachedHotelRate => !!r);
  }

  private async fanOut(user: AuthUser, req: HotelSearchRequest, traceId: string, searchId: string): Promise<CachedHotelSearch> {
    const ctx = this.ctx(user, traceId);
    const ttl = this.config.SEARCH_CACHE_TTL_SECONDS;
    const byHotel = new Map<string, { rateIds: string[]; suppliers: Set<string> }>();
    const suppliers = await Promise.all(
      this.registry.suppliers.map(async (s) => {
        try {
          const availability = await this.registry.call(s.code, ctx, (sup) => sup.search(req, ctx));
          const mapping = await this.content.resolve(s.code, availability.map((a) => a.content));
          for (const a of availability) {
            const hotel: Hotel | undefined = mapping.get(a.content.supplierHotelId);
            if (!hotel) continue;
            const entry = byHotel.get(hotel.id) ?? { rateIds: [], suppliers: new Set<string>() };
            entry.suppliers.add(s.code);
            for (const rate of a.rates) {
              entry.rateIds.push(rate.rateId);
              await this.cache.set(`hrate:${rate.rateId}`, { rate, hotelId: hotel.id, request: req } satisfies CachedHotelRate, ttl);
            }
            byHotel.set(hotel.id, entry);
          }
          return { supplier: s.code, status: 'ok' as const, hotels: availability.length };
        } catch (err) {
          const code = err instanceof SupplierError ? err.code : 'SUPPLIER_ERROR';
          this.logger.warn({ traceId, supplier: s.code, code }, `Hotel search failed: ${(err as Error).message}`);
          return { supplier: s.code, status: 'error' as const, hotels: 0, error: code };
        }
      }),
    );
    const result: CachedHotelSearch = {
      request: req,
      suppliers,
      hotels: [...byHotel.entries()].map(([hotelId, e]) => ({ hotelId, rateIds: e.rateIds, suppliers: [...e.suppliers] })),
    };
    if (suppliers.some((s) => s.status === 'ok')) await this.cache.set(`hsearch:${searchId}`, result, ttl);
    return result;
  }
}

export function hotelSearchKey(req: HotelSearchRequest): string {
  const rooms = req.rooms.map((r) => `${r.adults}:${(r.childAges ?? []).join(',')}`).join(';');
  const normal = [req.city.toUpperCase(), req.checkIn, req.checkOut, rooms, req.nationality ?? ''].join('|');
  return createHash('sha256').update(normal).digest('hex').slice(0, 24);
}
