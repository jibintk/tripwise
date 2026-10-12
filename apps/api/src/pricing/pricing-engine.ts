import { add, Money, money, percentOf } from '@tripwise/contracts';

export interface PricingRule {
  id: string;
  ownerTenantId: string;
  name: string;
  product: string | null;
  channel: string | null;
  supplier: string | null;
  origin: string | null;
  destination: string | null;
  cabin: string | null;
  valueType: 'percent' | 'fixed';
  value: number;
  currency: string | null;
  priority: number;
  createdAt: Date | string;
}

export interface PricingContext {
  product: 'flight' | 'hotel' | 'insurance' | 'package' | 'visa';
  channel: 'b2b' | 'b2e' | 'b2c' | 'pos';
  supplier: string;
  origin?: string;
  destination?: string;
  cabin?: string;
}

export interface MarkupLine {
  tenantId: string;
  tenantName: string;
  ruleId: string;
  ruleName: string;
  amount: Money;
}

export interface PriceQuote {
  /** What the supplier charges. */
  net: Money;
  /** What the booking tenant pays its parent chain: net plus every ancestor's markup. */
  agentCost: Money;
  /** What the end customer pays: agent cost plus the booking tenant's own markup. */
  sell: Money;
  /** One line per level that applied a rule, operator first. */
  breakdown: MarkupLine[];
}

const MATCH_FIELDS = ['product', 'channel', 'supplier', 'origin', 'destination', 'cabin'] as const;

/** A rule matches when every field it sets equals the context; unset fields are wildcards. */
export function matches(rule: PricingRule, ctx: PricingContext): boolean {
  return MATCH_FIELDS.every((f) => rule[f] === null || rule[f] === (ctx as unknown as Record<string, unknown>)[f]);
}

/** Number of fields the rule pins down; more specific rules win. */
export function specificity(rule: PricingRule): number {
  return MATCH_FIELDS.filter((f) => rule[f] !== null).length;
}

/** The single rule a tenant applies: most specific match, then highest priority, then oldest. */
export function pickRule(rules: PricingRule[], ctx: PricingContext): PricingRule | undefined {
  return rules
    .filter((r) => matches(r, ctx))
    .sort(
      (a, b) =>
        specificity(b) - specificity(a) ||
        b.priority - a.priority ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )[0];
}

function markupAmount(rule: PricingRule, base: Money): Money {
  if (rule.valueType === 'percent') return percentOf(base, rule.value);
  if (rule.currency !== base.currency) {
    throw new Error(`Rule ${rule.id} is in ${rule.currency} but the price is in ${base.currency}`);
  }
  return money(rule.value, base.currency);
}

/**
 * Prices a net amount down the tenant chain (operator -> ... -> booking tenant).
 * Each level marks up the price it buys at, so markups compound in hierarchy order.
 * The booking tenant's own markup is its margin: it appears in `sell` but not in `agentCost`.
 */
export function quote(
  net: Money,
  chain: { id: string; name: string }[],
  rulesByTenant: Map<string, PricingRule[]>,
  ctx: PricingContext,
): PriceQuote {
  let running = net;
  let agentCost = net;
  const breakdown: MarkupLine[] = [];
  chain.forEach((tenant, index) => {
    const rule = pickRule(rulesByTenant.get(tenant.id) ?? [], ctx);
    if (rule) {
      const amount = markupAmount(rule, running);
      running = add(running, amount);
      breakdown.push({ tenantId: tenant.id, tenantName: tenant.name, ruleId: rule.id, ruleName: rule.name, amount });
    }
    if (index === chain.length - 2) agentCost = running;
  });
  if (chain.length === 1) agentCost = net;
  return { net, agentCost, sell: running, breakdown };
}
