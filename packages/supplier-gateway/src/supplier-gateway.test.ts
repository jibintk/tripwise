import { CallContext, Passenger, SupplierError, SupplierErrorCode } from '@tripwise/contracts';
import { CircuitBreaker, MockFlightSupplier, withTimeout } from './index';

const ctx: CallContext = { traceId: 't', tenantId: 'x', timeoutMs: 1000 };
const req = {
  origin: 'NBO',
  destination: 'DXB',
  departureDate: '2026-12-01',
  passengers: { ADT: 1 },
  cabin: 'ECONOMY' as const,
};
const pax = (lastName: string): Passenger => ({
  type: 'ADT',
  title: 'MR',
  firstName: 'Test',
  lastName,
  dateOfBirth: '1990-01-01',
});

describe('MockFlightSupplier', () => {
  const supplier = new MockFlightSupplier({ priceChangeRoutes: ['NBO-ZNZ'] });

  it('returns the same offers for the same search', async () => {
    const a = await supplier.search(req, ctx);
    const b = await supplier.search(req, ctx);
    expect(a).toHaveLength(6);
    expect(a.map((o) => o.offerId)).toEqual(b.map((o) => o.offerId));
    expect(a[0].price.total.amount).toBe(a[0].price.base.amount + a[0].price.taxes.amount);
  });

  it('holds, tickets and is idempotent on re-ticketing', async () => {
    const [offer] = await supplier.search(req, ctx);
    const ref = await supplier.hold(offer, [pax('OKAFOR')], ctx);
    const first = await supplier.ticket(ref, ctx);
    const again = await supplier.ticket(ref, ctx);
    expect(first.ticketNumbers).toHaveLength(1);
    expect(again.ticketNumbers).toEqual(first.ticketNumbers);
  });

  it('raises the price on configured routes at reprice', async () => {
    const [offer] = await supplier.search({ ...req, destination: 'ZNZ' }, ctx);
    const repriced = await supplier.reprice(offer, ctx);
    expect(repriced.price.total.amount).toBeGreaterThan(offer.price.total.amount);
  });

  it('simulates sold out and ticketing failures', async () => {
    const [offer] = await supplier.search(req, ctx);
    await expect(supplier.hold(offer, [pax('SOLDOUT')], ctx)).rejects.toMatchObject({ code: 'SOLD_OUT' });
    const ref = await supplier.hold(offer, [pax('TICKETFAIL')], ctx);
    await expect(supplier.ticket(ref, ctx)).rejects.toMatchObject({ code: 'TICKETING_FAILED' });
  });
});

describe('resilience', () => {
  it('times out slow calls', async () => {
    const slow = () => new Promise((r) => setTimeout(r, 200));
    await expect(withTimeout('s', 20, slow)).rejects.toMatchObject({ code: 'SUPPLIER_TIMEOUT' });
  });

  it('opens after repeated infrastructure failures and recovers after the open period', async () => {
    let now = 0;
    const breaker = new CircuitBreaker('s', { failureThreshold: 2, openMs: 1000, now: () => now });
    const boom = () => Promise.reject(new Error('connection reset'));
    await expect(breaker.call(boom)).rejects.toThrow('connection reset');
    await expect(breaker.call(boom)).rejects.toThrow('connection reset');
    await expect(breaker.call(() => Promise.resolve(1))).rejects.toMatchObject({ code: 'SUPPLIER_UNAVAILABLE' });
    now = 1500;
    await expect(breaker.call(() => Promise.resolve(42))).resolves.toBe(42);
    expect(breaker.currentState).toBe('closed');
  });

  it('does not count business errors as failures', async () => {
    const breaker = new CircuitBreaker('s', { failureThreshold: 1, openMs: 1000 });
    const soldOut = () => Promise.reject(new SupplierError(SupplierErrorCode.SOLD_OUT, 'gone', 's'));
    await expect(breaker.call(soldOut)).rejects.toMatchObject({ code: 'SOLD_OUT' });
    expect(breaker.currentState).toBe('closed');
  });
});
