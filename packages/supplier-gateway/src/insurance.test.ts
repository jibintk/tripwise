import { money, SupplierError } from '@tripwise/contracts';
import { MockInsuranceProvider } from './mock-insurance-provider';

const ctx = { traceId: 't', tenantId: 'x', timeoutMs: 1000 };
const req = (lastName = 'ODHIAMBO', reference = 'TW-AAAAAA') => ({
  planCode: 'essential',
  region: 'east_africa' as const,
  startDate: '2026-12-01',
  endDate: '2026-12-07',
  travellers: [{ title: 'MR' as const, firstName: 'James', lastName, dateOfBirth: '1988-04-12' }],
  premium: money(1_200, 'USD'),
  reference,
});

describe('MockInsuranceProvider', () => {
  it('issues one policy per booking reference, however often it is asked', async () => {
    const p = new MockInsuranceProvider();
    const a = await p.issue(req(), ctx);
    const b = await p.issue(req(), ctx);
    expect(a.policyNumber).toMatch(/^TI-ESSENTIAL-\d{8}$/);
    expect(b.policyNumber).toBe(a.policyNumber);
    expect((await p.issue(req('ODHIAMBO', 'TW-BBBBBB'), ctx)).policyNumber).not.toBe(a.policyNumber);
  });

  it('declines when asked to by the POLICYFAIL test hook', async () => {
    await expect(new MockInsuranceProvider().issue(req('POLICYFAIL'), ctx)).rejects.toMatchObject({ code: 'BOOKING_FAILED' });
    await expect(new MockInsuranceProvider().issue(req('POLICYFAIL'), ctx)).rejects.toBeInstanceOf(SupplierError);
  });

  it('cancels policies', async () => {
    const p = new MockInsuranceProvider();
    const { policyNumber } = await p.issue(req(), ctx);
    expect(await p.cancel(policyNumber, ctx)).toEqual({ cancelled: true });
  });
});
