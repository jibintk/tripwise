import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { FlightOffer, FlightSearchRequest, SupplierError } from '@tripwise/contracts';
import { createHash } from 'crypto';
import { AuthUser } from '../auth/auth.types';
import { CacheService } from '../cache/cache.service';
import { AppError } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config';
import { PriceQuote, PricingContext } from '../pricing/pricing-engine';
import { PricingService } from '../pricing/pricing.service';
import { CorporateService } from '../corporate/corporate.service';
import { Cabin } from '../corporate/policy-engine';

/** The sales channel a caller books through; it selects which markup rules apply. */
export function channelFor(user: AuthUser): 'b2b' | 'b2e' {
  return user.tenantType === 'corporate' ? 'b2e' : 'b2b';
}
import { SupplierRegistry } from './supplier-registry';

export interface SupplierStatus {
  supplier: string;
  status: 'ok' | 'error';
  offers: number;
  error?: string;
  ms: number;
}

interface CachedSearch {
  request: FlightSearchRequest;
  offerIds: string[];
  suppliers: SupplierStatus[];
  createdAt: string;
}

/** An offer as a caller sees it: supplier net is shown only to the operator. */
export interface PricedOffer extends Omit<FlightOffer, 'price'> {
  fare: FlightOffer['price'] | undefined;
  pricing: { agentCost: PriceQuote['agentCost']; sell: PriceQuote['sell']; yourMarkup: PriceQuote['sell'] };
}

@Injectable()
export class FlightSearchService {
  private readonly logger = new Logger(FlightSearchService.name);

  constructor(
    private readonly registry: SupplierRegistry,
    private readonly cache: CacheService,
    private readonly pricing: PricingService,
    private readonly corporate: CorporateService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async search(user: AuthUser, req: FlightSearchRequest, traceId: string) {
    const searchId = searchKey(req);
    let cached = await this.cache.get<CachedSearch>(`search:${searchId}`);
    let offers: FlightOffer[];
    let fromCache = true;
    if (cached) {
      offers = (await Promise.all(cached.offerIds.map((id) => this.cache.get<FlightOffer>(`offer:${id}`)))).filter(
        (o): o is FlightOffer => !!o,
      );
    } else {
      fromCache = false;
      const result = await this.fanOut(user, req, traceId);
      offers = result.offers;
      cached = { request: req, offerIds: offers.map((o) => o.offerId), suppliers: result.suppliers, createdAt: new Date().toISOString() };
      // Cache only when at least one supplier answered, so an outage is not remembered for 10 minutes.
      if (result.suppliers.some((s) => s.status === 'ok')) {
        const ttl = this.config.SEARCH_CACHE_TTL_SECONDS;
        await Promise.all(offers.map((o) => this.cache.set(`offer:${o.offerId}`, o, ttl)));
        await this.cache.set(`search:${searchId}`, cached, ttl);
      }
    }
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    const priced = offers
      .map((o) => this.present(user, o, pricer(o.price.total, this.pricingContext(req, o, channelFor(user)))))
      .sort((a, b) => a.pricing.sell.amount - b.pricing.sell.amount);

    // Corporate travellers see every fare checked against their policy, and the lowest logical fare.
    const traveller = await this.corporate.travellerContext(user);
    if (traveller) {
      const travellers = req.passengers.ADT + (req.passengers.CHD ?? 0) + (req.passengers.INF ?? 0);
      const annotated = priced.map((o, i) => ({
        ...o,
        lowestFare: i === 0,
        policy: this.corporate.flightVerdict(traveller, {
          cabin: (o.cabin ?? req.cabin) as Cabin,
          sellAmount: o.pricing.sell.amount,
          currency: o.pricing.sell.currency,
          travellers,
          departureDate: req.departureDate,
          refundable: o.refundable,
        }),
      }));
      return { searchId, fromCache, suppliers: cached.suppliers, offers: annotated, policy: { grade: traveller.grade, approvalMode: traveller.policy.approvalMode } };
    }
    return { searchId, fromCache, suppliers: cached.suppliers, offers: priced };
  }

  /** The cheapest sell price in a cached search, for the caller: the "lowest logical fare". */
  async lowestSell(user: AuthUser, searchId: string): Promise<number | undefined> {
    const cached = await this.cache.get<CachedSearch>(`search:${searchId}`);
    if (!cached) return undefined;
    const offers = (await Promise.all(cached.offerIds.map((id) => this.cache.get<FlightOffer>(`offer:${id}`)))).filter(
      (o): o is FlightOffer => !!o,
    );
    if (!offers.length) return undefined;
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    return Math.min(...offers.map((o) => pricer(o.price.total, this.pricingContext(cached.request, o, channelFor(user))).sell.amount));
  }

  async getOffer(offerId: string): Promise<FlightOffer> {
    const offer = await this.cache.get<FlightOffer>(`offer:${offerId}`);
    if (!offer) {
      throw new AppError(HttpStatus.GONE, 'OFFER_EXPIRED', 'This offer is no longer available. Search again.');
    }
    return offer;
  }

  /** Live price check with the supplier; refreshes the cached offer. */
  async reprice(user: AuthUser, offerId: string, traceId: string) {
    const offer = await this.getOffer(offerId);
    const fresh = await this.registry.call(offer.supplier, this.ctx(user, traceId), (s) =>
      s.reprice(offer, this.ctx(user, traceId)),
    );
    await this.cache.set(`offer:${fresh.offerId}`, fresh, this.config.SEARCH_CACHE_TTL_SECONDS);
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    return { offer: fresh, quote: pricer(fresh.price.total, this.pricingContext(undefined, fresh, channelFor(user))) };
  }

  async fareRules(user: AuthUser, offerId: string, traceId: string) {
    const offer = await this.getOffer(offerId);
    return this.registry.call(offer.supplier, this.ctx(user, traceId), (s) => s.fareRules(offer, this.ctx(user, traceId)));
  }

  pricingContext(req: FlightSearchRequest | undefined, offer: FlightOffer, channel: 'b2b' | 'b2e' | 'b2c' | 'pos' = 'b2b'): PricingContext {
    const first = offer.slices[0].segments[0];
    const lastSeg = offer.slices[0].segments[offer.slices[0].segments.length - 1];
    return {
      product: 'flight',
      channel,
      supplier: offer.supplier,
      origin: first.origin,
      destination: lastSeg.destination,
      cabin: offer.cabin ?? req?.cabin,
    };
  }

  ctx(user: AuthUser, traceId: string) {
    return { traceId, tenantId: user.tenantId, timeoutMs: this.config.SEARCH_SUPPLIER_TIMEOUT_MS };
  }

  present(user: AuthUser, offer: FlightOffer, q: PriceQuote): PricedOffer {
    const { price, ...rest } = offer;
    return {
      ...rest,
      fare: user.tenantType === 'operator' ? price : undefined,
      pricing: {
        agentCost: q.agentCost,
        sell: q.sell,
        yourMarkup: { amount: q.sell.amount - q.agentCost.amount, currency: q.sell.currency },
      },
    };
  }

  /** Calls every supplier in parallel; a slow or failing supplier only loses its own results. */
  private async fanOut(user: AuthUser, req: FlightSearchRequest, traceId: string) {
    const ctx = this.ctx(user, traceId);
    const results = await Promise.all(
      this.registry.suppliers.map(async (s): Promise<{ status: SupplierStatus; offers: FlightOffer[] }> => {
        const started = Date.now();
        try {
          const offers = await this.registry.call(s.code, ctx, (sup) => sup.search(req, ctx));
          return { status: { supplier: s.code, status: 'ok', offers: offers.length, ms: Date.now() - started }, offers };
        } catch (err) {
          const code = err instanceof SupplierError ? err.code : 'SUPPLIER_ERROR';
          this.logger.warn({ traceId, supplier: s.code, code }, `Supplier search failed: ${(err as Error).message}`);
          return { status: { supplier: s.code, status: 'error', offers: 0, error: code, ms: Date.now() - started }, offers: [] };
        }
      }),
    );
    return { suppliers: results.map((r) => r.status), offers: results.flatMap((r) => r.offers) };
  }
}

/** Same trip, same key, regardless of field order or letter case. */
export function searchKey(req: FlightSearchRequest): string {
  const normal = [
    req.origin.toUpperCase(),
    req.destination.toUpperCase(),
    req.departureDate,
    req.returnDate ?? '',
    req.cabin,
    req.passengers.ADT,
    req.passengers.CHD ?? 0,
    req.passengers.INF ?? 0,
  ].join('|');
  return createHash('sha256').update(normal).digest('hex').slice(0, 24);
}
