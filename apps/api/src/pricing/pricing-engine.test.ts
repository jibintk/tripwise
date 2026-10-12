import { money } from '@tripwise/contracts';
import { pickRule, PricingContext, PricingRule, quote } from './pricing-engine';

let seq = 0;
const rule = (owner: string, partial: Partial<PricingRule>): PricingRule => ({
  id: `r${++seq}`,
  ownerTenantId: owner,
  name: `rule ${seq}`,
  product: null,
  channel: null,
  supplier: null,
  origin: null,
  destination: null,
  cabin: null,
  valueType: 'percent',
  value: 0,
  currency: null,
  priority: 0,
  createdAt: new Date(2026, 0, seq),
  ...partial,
});

const ctx: PricingContext = { product: 'flight', channel: 'b2b', supplier: 'mockair', origin: 'NBO', destination: 'ZNZ' };
const chain = [
  { id: 'op', name: 'Operator' },
  { id: 'gsa', name: 'GSA' },
  { id: 'ag', name: 'Agency' },
];

describe('pickRule', () => {
  it('prefers the most specific matching rule', () => {
    const general = rule('op', { value: 300 });
    const znz = rule('op', { destination: 'ZNZ', value: 500 });
    const otherRoute = rule('op', { destination: 'DXB', origin: 'NBO', value: 900 });
    expect(pickRule([general, znz, otherRoute], ctx)).toBe(znz);
  });

  it('breaks specificity ties with priority', () => {
    const a = rule('op', { product: 'flight', value: 100 });
    const b = rule('op', { channel: 'b2b', value: 200, priority: 5 });
    expect(pickRule([a, b], ctx)).toBe(b);
  });

  it('ignores rules for other products or channels', () => {
    expect(pickRule([rule('op', { product: 'hotel', value: 100 })], ctx)).toBeUndefined();
    expect(pickRule([rule('op', { channel: 'b2c', value: 100 })], ctx)).toBeUndefined();
  });
});

describe('quote', () => {
  it('compounds markups down the hierarchy and keeps the agency margin out of its cost', () => {
    const rules = new Map([
      ['op', [rule('op', { value: 300 })]], // 3%
      ['gsa', [rule('gsa', { value: 150 })]], // 1.5%
      ['ag', [rule('ag', { valueType: 'fixed', value: 1500, currency: 'USD' })]], // USD 15
    ]);
    const q = quote(money(100_000, 'USD'), chain, rules, ctx);
    // 1000.00 +3% = 1030.00; +1.5% = 1045.45; agency adds 15.00 = 1060.45
    expect(q.net.amount).toBe(100_000);
    expect(q.agentCost.amount).toBe(104_545);
    expect(q.sell.amount).toBe(106_045);
    expect(q.breakdown.map((l) => [l.tenantId, l.amount.amount])).toEqual([
      ['op', 3000],
      ['gsa', 1545],
      ['ag', 1500],
    ]);
  });

  it('returns net prices when no rules apply', () => {
    const q = quote(money(50_000, 'USD'), chain, new Map(), ctx);
    expect(q.agentCost).toEqual(q.net);
    expect(q.sell).toEqual(q.net);
    expect(q.breakdown).toHaveLength(0);
  });

  it('prices operator direct sales with only the operator markup', () => {
    const rules = new Map([['op', [rule('op', { value: 1000 })]]]);
    const q = quote(money(10_000, 'USD'), [chain[0]], rules, ctx);
    expect(q.agentCost.amount).toBe(10_000);
    expect(q.sell.amount).toBe(11_000);
  });

  it('rejects a fixed markup in another currency', () => {
    const rules = new Map([['op', [rule('op', { valueType: 'fixed', value: 100, currency: 'KES' })]]]);
    expect(() => quote(money(10_000, 'USD'), chain, rules, ctx)).toThrow(/KES/);
  });
});
