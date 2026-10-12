import { randomUUID } from 'crypto';
import { SEED_USERS } from '../src/db/seed';
import { JobsService } from '../src/jobs/jobs.service';
import { contact, login, passenger, startApp, stopApp } from './harness';

type Ctx = Awaited<ReturnType<typeof startApp>>;
let ctx: Ctx;
let operator: string;
let agent: string;
let staff: string;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const yearsAgo = (n: number) => `${new Date().getUTCFullYear() - n}-01-15`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Quote {
  quoteId: string | null;
  plan: { code: string; name: string };
  unavailable?: string;
  pricing?: { agentCost: { amount: number }; sell: { amount: number; currency: string } };
}

const quote = async (token: string, body: Record<string, unknown> = {}) =>
  (
    await ctx.http
      .post('/api/v1/insurance/quotes')
      .set(auth(token))
      .send({ region: 'east_africa', startDate: inDays(10), endDate: inDays(14), travellers: [{ dateOfBirth: '1988-04-12' }], ...body })
      .expect(200)
  ).body as { days: number; quotes: Quote[] };

const plan = (q: { quotes: Quote[] }, code: string) => q.quotes.find((x) => x.plan.code === code)!;

const traveller = (lastName = 'ODHIAMBO', dateOfBirth = '1988-04-12') => ({ title: 'MR', firstName: 'James', lastName, dateOfBirth });

const book = (token: string, quoteId: string, travellers = [traveller()], extra: Record<string, unknown> = {}) =>
  ctx.http
    .post('/api/v1/insurance/bookings')
    .set(auth(token))
    .set('Idempotency-Key', randomUUID())
    .send({ quoteId, travellers, contact, ...extra });

const pay = (token: string, ref: string) => ctx.http.post(`/api/v1/bookings/${ref}/payments`).set(auth(token));

const balance = async (token: string) => (await ctx.http.get('/api/v1/accounts/me').set(auth(token)).expect(200)).body.balance as number;

beforeAll(async () => {
  ctx = await startApp();
  operator = await login(ctx.http, SEED_USERS.operatorAdmin);
  agent = await login(ctx.http, SEED_USERS.agent);
  staff = await login(ctx.http, SEED_USERS.staff);
});

afterAll(() => stopApp(ctx));

describe('quotes', () => {
  it('prices every plan that covers the region, cheapest first, with operator and GSA commission', async () => {
    const q = await quote(agent, { travellers: [{ dateOfBirth: '1988-04-12' }, { dateOfBirth: '1990-09-01' }] });
    expect(q.days).toBe(5);
    expect(q.quotes.map((x) => x.plan.code)).toEqual(['essential', 'africa_plus', 'worldwide']);
    const essential = plan(q, 'essential');
    // 2 travellers x USD 12 net, +10% operator, +2% GSA; the agency has no insurance markup.
    expect(essential.pricing!.agentCost.amount).toBe(Math.round(Math.round(2_400 * 1.1) * 1.02));
    expect(essential.pricing!.sell.amount).toBe(essential.pricing!.agentCost.amount);
    expect(essential.quoteId).toMatch(/^insq_/);
  });

  it('explains why a plan cannot cover the trip', async () => {
    const worldwide = await quote(agent, { region: 'worldwide' });
    expect(plan(worldwide, 'essential').unavailable).toBe('Does not cover Worldwide');
    expect(plan(worldwide, 'worldwide').quoteId).toBeTruthy();

    const long = await quote(agent, { endDate: inDays(110) });
    expect(plan(long, 'essential').unavailable).toBe('Trips up to 92 days');

    const older = await quote(agent, { travellers: [{ dateOfBirth: yearsAgo(78) }] });
    expect(plan(older, 'essential').unavailable).toBe('Travellers up to 75 years old');
  });

  it('loads the premium for seniors', async () => {
    const adult = plan(await quote(operator, { travellers: [{ dateOfBirth: '1988-04-12' }] }), 'africa_plus');
    const senior = plan(await quote(operator, { travellers: [{ dateOfBirth: yearsAgo(70) }] }), 'africa_plus');
    expect(senior.pricing!.agentCost.amount).toBe(adult.pricing!.agentCost.amount * 2);
  });

  it('validates dates', async () => {
    const res = await ctx.http
      .post('/api/v1/insurance/quotes')
      .set(auth(agent))
      .send({ region: 'africa', startDate: inDays(5), endDate: inDays(3), travellers: [{ dateOfBirth: '1988-04-12' }] })
      .expect(400);
    expect(res.body.errors[0].field).toBe('endDate');
  });
});

describe('buying a policy', () => {
  it('holds the quote, charges the wallet and issues the policy with a certificate', async () => {
    const q = plan(await quote(agent), 'africa_plus');
    const before = await balance(agent);
    const held = (await book(agent, q.quoteId!, [traveller()], { expectedSellAmount: q.pricing!.sell.amount }).expect(201)).body;
    expect(held).toMatchObject({ product: 'insurance', status: 'held', plan: { code: 'africa_plus' }, cover: { days: 5, region: 'east_africa' } });

    const paid = (await pay(agent, held.reference).expect(200)).body;
    expect(paid.status).toBe('confirmed');
    expect(paid.policyNumber).toMatch(/^TI-AFRICA_PLUS-\d{8}$/);
    expect(before - (await balance(agent))).toBe(q.pricing!.agentCost.amount);

    const pdf = await ctx.http.get(`/api/v1/bookings/${held.reference}/certificate.pdf`).set(auth(agent)).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`insurance-${held.reference}.pdf`);

    await ctx.app.get(JobsService).runAll();
    const { rows } = await ctx.pool.query(`SELECT template, subject FROM notify.notification WHERE ref_id = $1 ORDER BY id`, [held.reference]);
    expect(rows.map((r) => r.template)).toEqual(['booking.held', 'booking.confirmed']);
    expect(rows[1].subject).toContain(paid.policyNumber);
  });

  it('requires the travellers the quote was for', async () => {
    const q = plan(await quote(agent), 'essential');
    const res = await book(agent, q.quoteId!, [traveller('ODHIAMBO', '1970-01-01')]).expect(400);
    expect(res.body.detail).toContain('dates of birth');
  });

  it('links to the trip it covers, and only to bookings the agent can see', async () => {
    const q = plan(await quote(agent), 'essential');
    await book(agent, q.quoteId!, [traveller()], { linkedReference: 'TW-ZZZZZZ' }).expect(404);
    const flight = await ctx.http
      .post('/api/v1/flights/searches')
      .set(auth(agent))
      .send({ origin: 'NBO', destination: 'DXB', departureDate: inDays(10), passengers: { ADT: 1 } })
      .expect(200);
    const trip = await ctx.http
      .post('/api/v1/bookings')
      .set(auth(agent))
      .set('Idempotency-Key', randomUUID())
      .send({ offerId: flight.body.offers[0].offerId, passengers: [passenger()], contact })
      .expect(201);
    const held = (await book(agent, q.quoteId!, [traveller()], { linkedReference: trip.body.reference.toLowerCase() }).expect(201)).body;
    expect(held.linkedReference).toBe(trip.body.reference);
  });

  it('refunds in full when the insurer declines', async () => {
    const q = plan(await quote(agent), 'essential');
    const before = await balance(agent);
    const held = (await book(agent, q.quoteId!, [traveller('POLICYFAIL')]).expect(201)).body;
    const paid = (await pay(agent, held.reference).expect(200)).body;
    expect(paid).toMatchObject({ status: 'failed', failureReason: 'BOOKING_FAILED' });
    expect(await balance(agent)).toBe(before);
  });

  it('can be cancelled for a full refund until cover starts', async () => {
    const q = plan(await quote(agent), 'worldwide');
    const held = (await book(agent, q.quoteId!).expect(201)).body;
    await pay(agent, held.reference).expect(200);
    const before = await balance(agent);
    const cancelled = (await ctx.http.post(`/api/v1/bookings/${held.reference}/cancel`).set(auth(agent)).expect(200)).body;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation.refunded.amount).toBe(q.pricing!.agentCost.amount);
    expect((await balance(agent)) - before).toBe(q.pricing!.agentCost.amount);
  });

  it('cannot be cancelled online once cover has started', async () => {
    const q = plan(await quote(agent, { startDate: inDays(0), endDate: inDays(3) }), 'essential');
    const held = (await book(agent, q.quoteId!).expect(201)).body;
    await pay(agent, held.reference).expect(200);
    const res = await ctx.http.post(`/api/v1/bookings/${held.reference}/cancel`).set(auth(agent)).expect(409);
    expect(res.body.code).toBe('COVER_STARTED');
  });

  it('is paid on account straight away for corporate travellers', async () => {
    const q = plan(await quote(staff), 'essential');
    const res = await book(staff, q.quoteId!).expect(201);
    expect(res.body).toMatchObject({ status: 'confirmed', channel: 'b2e', policy: { inPolicy: true } });
  });
});

describe('plan catalogue', () => {
  it('hides net rates from agencies, and lets the operator withdraw a plan', async () => {
    const asAgent = (await ctx.http.get('/api/v1/insurance/plans').set(auth(agent)).expect(200)).body;
    expect(asAgent[0].rates).toBeUndefined();
    const asOperator = (await ctx.http.get('/api/v1/insurance/plans').set(auth(operator)).expect(200)).body;
    expect(asOperator[0].rates.length).toBeGreaterThan(0);

    const q = plan(await quote(agent), 'africa_plus');
    await ctx.http.put('/api/v1/insurance/plans/africa_plus/active').set(auth(agent)).send({ active: false }).expect(403);
    await ctx.http.put('/api/v1/insurance/plans/africa_plus/active').set(auth(operator)).send({ active: false }).expect(200);
    expect((await quote(agent)).quotes.map((x) => x.plan.code)).not.toContain('africa_plus');
    expect((await book(agent, q.quoteId!).expect(410)).body.code).toBe('OFFER_EXPIRED');
    await ctx.http.put('/api/v1/insurance/plans/africa_plus/active').set(auth(operator)).send({ active: true }).expect(200);
  });

  it('expires quotes it no longer knows', async () => {
    expect((await book(agent, 'insq_unknown').expect(410)).body.code).toBe('OFFER_EXPIRED');
  });
});
