import { HttpStatus, Injectable } from '@nestjs/common';
import { InsuranceRegion, money } from '@tripwise/contracts';
import { randomBytes } from 'crypto';
import { AuthUser, hasRole } from '../auth/auth.types';
import { CacheService } from '../cache/cache.service';
import { AppError, forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { channelFor } from '../flights/flight-search.service';
import { PricingContext } from '../pricing/pricing-engine';
import { PricingService } from '../pricing/pricing.service';

export const REGION_LABEL: Record<InsuranceRegion, string> = {
  east_africa: 'East Africa',
  africa: 'Africa',
  worldwide: 'Worldwide',
};

export interface QuoteRequest {
  region: InsuranceRegion;
  startDate: string;
  endDate: string;
  travellers: { dateOfBirth: string }[];
}

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  provider: string;
  regions: InsuranceRegion[];
  summary: string;
  coverage: { label: string; limit: string }[];
  rates: { maxDays: number; amount: number }[];
  currency: string;
  max_age: number;
  senior_age: number;
  senior_factor: string;
  active: boolean;
}

/** A quote as cached between showing plans and booking one. */
export interface CachedQuote {
  quoteId: string;
  planCode: string;
  request: QuoteRequest;
}

const QUOTE_TTL_SECONDS = 30 * 60;

export function coverDays(startDate: string, endDate: string): number {
  return Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
}

function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/**
 * Prices a plan for a trip: per-traveller net rate by trip length, loaded for seniors.
 * Returns the reason when the plan cannot cover the trip.
 */
export function premiumFor(plan: PlanRow, req: QuoteRequest): { net: number } | { unavailable: string } {
  if (!plan.regions.includes(req.region)) return { unavailable: `Does not cover ${REGION_LABEL[req.region]}` };
  const days = coverDays(req.startDate, req.endDate);
  const band = [...plan.rates].sort((a, b) => a.maxDays - b.maxDays).find((r) => days <= r.maxDays);
  if (!band) return { unavailable: `Trips up to ${Math.max(...plan.rates.map((r) => r.maxDays))} days` };
  let net = 0;
  for (const t of req.travellers) {
    const age = ageOn(t.dateOfBirth, req.startDate);
    if (age > plan.max_age) return { unavailable: `Travellers up to ${plan.max_age} years old` };
    net += Math.round(band.amount * (age >= plan.senior_age ? Number(plan.senior_factor) : 1));
  }
  return { net };
}

@Injectable()
export class InsuranceService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly pricing: PricingService,
  ) {}

  async plans(user: AuthUser) {
    const all = user.tenantType === 'operator' && hasRole(user, 'admin');
    const { rows } = await this.db.query<PlanRow>(
      `SELECT * FROM insurance.plan WHERE active OR $1 ORDER BY sort, name`,
      [all],
    );
    return rows.map((p) => ({
      code: p.code,
      name: p.name,
      summary: p.summary,
      regions: p.regions,
      coverage: p.coverage,
      maxAge: p.max_age,
      active: p.active,
      // Net rates are commercial terms between the operator and the insurer.
      ...(user.tenantType === 'operator' ? { provider: p.provider, rates: p.rates, currency: p.currency } : {}),
    }));
  }

  /** Operator admins switch plans on or off (rates and wording change through a release). */
  async setActive(user: AuthUser, code: string, active: boolean) {
    if (user.tenantType !== 'operator' || !hasRole(user, 'admin')) throw forbidden('Operator admin access required');
    const row = await this.db.one(`UPDATE insurance.plan SET active = $2, updated_at = now() WHERE code = $1 RETURNING code, active`, [code, active]);
    if (!row) throw notFound('Plan');
    return row;
  }

  /** Every active plan priced for this trip and this caller, cheapest first; unsuitable plans say why. */
  async quote(user: AuthUser, req: QuoteRequest) {
    const { rows } = await this.db.query<PlanRow>(`SELECT * FROM insurance.plan WHERE active ORDER BY sort, name`);
    const pricer = await this.pricing.pricerFor(user.tenantPath);
    const days = coverDays(req.startDate, req.endDate);
    const quotes = [];
    for (const plan of rows) {
      const p = premiumFor(plan, req);
      const info = { code: plan.code, name: plan.name, summary: plan.summary, coverage: plan.coverage };
      if ('unavailable' in p) {
        quotes.push({ quoteId: null, plan: info, unavailable: p.unavailable });
        continue;
      }
      const q = pricer(money(p.net, plan.currency), this.pricingContext(plan, channelFor(user)));
      const quoteId = `insq_${randomBytes(9).toString('base64url')}`;
      await this.cache.set(`insq:${quoteId}`, { quoteId, planCode: plan.code, request: req } satisfies CachedQuote, QUOTE_TTL_SECONDS);
      quotes.push({
        quoteId,
        plan: info,
        pricing: { agentCost: q.agentCost, sell: q.sell, yourMarkup: money(q.sell.amount - q.agentCost.amount, q.sell.currency) },
      });
    }
    quotes.sort((a, b) => (a.pricing?.sell.amount ?? Infinity) - (b.pricing?.sell.amount ?? Infinity));
    return { region: req.region, startDate: req.startDate, endDate: req.endDate, days, travellers: req.travellers.length, quotes };
  }

  async getQuote(quoteId: string): Promise<CachedQuote> {
    const q = await this.cache.get<CachedQuote>(`insq:${quoteId}`);
    if (!q) throw new AppError(HttpStatus.GONE, 'OFFER_EXPIRED', 'This quote has expired. Get a new quote.');
    return q;
  }

  async plan(code: string): Promise<PlanRow> {
    const p = await this.db.one<PlanRow>(`SELECT * FROM insurance.plan WHERE code = $1 AND active`, [code]);
    if (!p) throw new AppError(HttpStatus.GONE, 'OFFER_EXPIRED', 'This plan is no longer offered. Get a new quote.');
    return p;
  }

  pricingContext(plan: Pick<PlanRow, 'provider'>, channel: PricingContext['channel']): PricingContext {
    return { product: 'insurance', channel, supplier: plan.provider };
  }
}
