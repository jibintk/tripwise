import { randomUUID } from 'crypto';
import { SEED_USERS } from '../src/db/seed';
import { contact, login, passenger, startApp, stopApp } from './harness';

type Ctx = Awaited<ReturnType<typeof startApp>>;
let ctx: Ctx;
let agent: string;
let otherAgent: string;
let gsaAdmin: string;
let operator: string;

const search = (token: string, body: Record<string, unknown> = {}) =>
  ctx.http
    .post('/api/v1/flights/searches')
    .set('Authorization', `Bearer ${token}`)
    .send({ origin: 'NBO', destination: 'DXB', departureDate: '2026-12-10', passengers: { ADT: 1 }, ...body });

const book = (token: string, offerId: string, opts: { key?: string; lastName?: string; expected?: number } = {}) =>
  ctx.http
    .post('/api/v1/bookings')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', opts.key ?? randomUUID())
    .send({ offerId, passengers: [passenger(opts.lastName)], contact, expectedSellAmount: opts.expected });

const pay = (token: string, ref: string) =>
  ctx.http.post(`/api/v1/bookings/${ref}/payments`).set('Authorization', `Bearer ${token}`);

const wallet = async (token: string) =>
  (await ctx.http.get('/api/v1/accounts/me').set('Authorization', `Bearer ${token}`).expect(200)).body;

beforeAll(async () => {
  ctx = await startApp();
  agent = await login(ctx.http, SEED_USERS.agent);
  otherAgent = await login(ctx.http, SEED_USERS.otherAgent);
  gsaAdmin = await login(ctx.http, SEED_USERS.gsaAdmin);
  operator = await login(ctx.http, SEED_USERS.operatorAdmin);
});

afterAll(() => stopApp(ctx));

describe('auth', () => {
  it('rejects a wrong password with a stable error code', async () => {
    const res = await ctx.http.post('/api/v1/auth/login').send({ email: SEED_USERS.agent, password: 'nope' }).expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('requires a token everywhere except login and health', async () => {
    await ctx.http.get('/api/v1/bookings').expect(401);
    await ctx.http.get('/health').expect(200);
  });
});

describe('flight search', () => {
  it('prices every offer down the agency chain and hides supplier net from agents', async () => {
    const asAgent = (await search(agent).expect(200)).body;
    const asOperator = (await search(operator).expect(200)).body;
    expect(asAgent.offers.length).toBe(6);
    expect(asAgent.offers[0].fare).toBeUndefined();

    const offer = asAgent.offers[0];
    const net = asOperator.offers.find((o: { offerId: string }) => o.offerId === offer.offerId).fare.total.amount;
    // operator 3%, then GSA 1.5% on top; the agency adds a USD 15 fee as its own margin
    const afterOperator = net + Math.round((net * 300) / 10_000);
    const afterGsa = afterOperator + Math.round((afterOperator * 150) / 10_000);
    expect(offer.pricing.agentCost.amount).toBe(afterGsa);
    expect(offer.pricing.sell.amount).toBe(afterGsa + 1500);
    expect(offer.pricing.yourMarkup.amount).toBe(1500);
    // results are sorted cheapest first
    const sells = asAgent.offers.map((o: { pricing: { sell: { amount: number } } }) => o.pricing.sell.amount);
    expect(sells).toEqual([...sells].sort((a, b) => a - b));
  });

  it('serves a repeat search from cache', async () => {
    const res = await search(agent).expect(200);
    expect(res.body.fromCache).toBe(true);
  });

  it('returns field-level validation errors', async () => {
    const res = await search(agent, { origin: 'NAIROBI', destination: 'DXB' }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors[0].field).toBe('origin');
  });
});

describe('booking', () => {
  it('holds, pays from the wallet and tickets', async () => {
    const before = await wallet(agent);
    const offer = (await search(agent).expect(200)).body.offers[0];

    const key = randomUUID();
    const held = (await book(agent, offer.offerId, { key, expected: offer.pricing.sell.amount }).expect(201)).body;
    expect(held.status).toBe('held');
    expect(held.pnr).toMatch(/^[0-9A-F]{6}$/);
    expect(held.reference).toMatch(/^TW-[A-Z2-9]{6}$/);

    // Same idempotency key returns the same booking instead of a second hold.
    const again = (await book(agent, offer.offerId, { key }).expect(201)).body;
    expect(again.reference).toBe(held.reference);

    const paid = (await pay(agent, held.reference).expect(200)).body;
    expect(paid.status).toBe('confirmed');
    expect(paid.ticketNumbers).toHaveLength(1);

    const after = await wallet(agent);
    expect(before.balance - after.balance).toBe(offer.pricing.agentCost.amount);

    const detail = (await ctx.http.get(`/api/v1/bookings/${held.reference}`).set('Authorization', `Bearer ${agent}`).expect(200))
      .body;
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(['held', 'paid', 'ticketed']);
  });

  it('charges only once when payment is submitted twice at the same time', async () => {
    const offer = (await search(agent, { departureDate: '2026-12-11' }).expect(200)).body.offers[1];
    const held = (await book(agent, offer.offerId).expect(201)).body;
    const [a, b] = await Promise.all([pay(agent, held.reference), pay(agent, held.reference)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM payments.ledger_entry WHERE kind = 'booking_payment' AND ref_id = $1`,
      [held.reference],
    );
    expect(rows[0].n).toBe(2); // one transaction: wallet debit + sales credit
  });

  it('stops with PRICE_CHANGED when the live price differs, then books at the new price', async () => {
    const offer = (await search(agent, { destination: 'MBA' }).expect(200)).body.offers[0];
    const changed = await book(agent, offer.offerId, { expected: offer.pricing.sell.amount }).expect(409);
    expect(changed.body.code).toBe('PRICE_CHANGED');
    expect(changed.body.newSellAmount).toBeGreaterThan(offer.pricing.sell.amount);
    await book(agent, offer.offerId, { expected: changed.body.newSellAmount }).expect(201);
  });

  it('refunds automatically when ticketing fails after payment', async () => {
    const before = await wallet(agent);
    const offer = (await search(agent, { departureDate: '2026-12-12' }).expect(200)).body.offers[0];
    const held = (await book(agent, offer.offerId, { lastName: 'TICKETFAIL' }).expect(201)).body;
    const result = (await pay(agent, held.reference).expect(200)).body;
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('TICKETING_FAILED');
    expect((await wallet(agent)).balance).toBe(before.balance);
    const { rows } = await ctx.pool.query(
      `SELECT SUM(amount)::int AS total FROM payments.ledger_entry WHERE ref_id = $1`,
      [held.reference],
    );
    expect(rows[0].total).toBe(0);
  });

  it('maps supplier sold-out to a 409 and creates no booking', async () => {
    const offer = (await search(agent).expect(200)).body.offers[2];
    const res = await book(agent, offer.offerId, { lastName: 'SOLDOUT' }).expect(409);
    expect(res.body.code).toBe('SOLD_OUT');
  });

  it('refuses payment beyond balance plus credit and leaves the booking held', async () => {
    const offer = (
      await search(otherAgent, { cabin: 'FIRST', passengers: { ADT: 4 }, departureDate: '2026-12-20' }).expect(200)
    ).body.offers[0];
    const held = (
      await ctx.http
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${otherAgent}`)
        .set('Idempotency-Key', randomUUID())
        .send({ offerId: offer.offerId, passengers: [1, 2, 3, 4].map(() => passenger()), contact })
        .expect(201)
    ).body;
    const res = await pay(otherAgent, held.reference).expect(402);
    expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
    const detail = await ctx.http.get(`/api/v1/bookings/${held.reference}`).set('Authorization', `Bearer ${otherAgent}`);
    expect(detail.body.status).toBe('held');
  });

  it('cancels a held booking', async () => {
    const offer = (await search(agent, { departureDate: '2026-12-13' }).expect(200)).body.offers[0];
    const held = (await book(agent, offer.offerId).expect(201)).body;
    const res = await ctx.http
      .post(`/api/v1/bookings/${held.reference}/cancel`)
      .set('Authorization', `Bearer ${agent}`)
      .expect(200);
    expect(res.body.status).toBe('cancelled');
    await pay(agent, held.reference).expect(409);
  });
});

describe('tenant isolation and hierarchy', () => {
  it('hides one agency’s bookings from another agency', async () => {
    const mine = (await ctx.http.get('/api/v1/bookings').set('Authorization', `Bearer ${agent}`).expect(200)).body;
    expect(mine.length).toBeGreaterThan(0);
    await ctx.http.get(`/api/v1/bookings/${mine[0].reference}`).set('Authorization', `Bearer ${otherAgent}`).expect(404);
    const theirs = (await ctx.http.get('/api/v1/bookings').set('Authorization', `Bearer ${otherAgent}`).expect(200)).body;
    expect(theirs.every((b: { reference: string }) => !mine.some((m: { reference: string }) => m.reference === b.reference))).toBe(true);
  });

  it('lets a parent admin see bookings across its subtree', async () => {
    const all = (await ctx.http.get('/api/v1/bookings').set('Authorization', `Bearer ${gsaAdmin}`).expect(200)).body;
    const mine = (await ctx.http.get('/api/v1/bookings').set('Authorization', `Bearer ${agent}`).expect(200)).body;
    expect(all.length).toBeGreaterThan(mine.length);
    await ctx.http.get(`/api/v1/bookings/${mine[0].reference}`).set('Authorization', `Bearer ${gsaAdmin}`).expect(200);
  });

  it('only operator finance can top up wallets', async () => {
    const tenants = (await ctx.http.get('/api/v1/tenants').set('Authorization', `Bearer ${operator}`).expect(200)).body;
    const coastways = tenants.find((t: { code: string }) => t.code === 'coastways');
    const body = { amount: 100_000, currency: 'USD', memo: 'Bank transfer 4471' };
    await ctx.http.post(`/api/v1/accounts/${coastways.id}/topups`).set('Authorization', `Bearer ${agent}`).send(body).expect(403);
    const res = await ctx.http
      .post(`/api/v1/accounts/${coastways.id}/topups`)
      .set('Authorization', `Bearer ${operator}`)
      .send(body)
      .expect(201);
    expect(res.body.balance).toBe(150_000);
  });

  it('lets an agency admin create a branch under itself but not under someone else', async () => {
    const owner = await login(ctx.http, SEED_USERS.agencyAdmin);
    const res = await ctx.http
      .post('/api/v1/tenants')
      .set('Authorization', `Bearer ${owner}`)
      .send({ type: 'branch', code: 'safari_desk_mombasa', name: 'Safari Desk Mombasa', country: 'ke' })
      .expect(201);
    expect(res.body.path).toBe('tripwise.kenya_gsa.safari_desk.safari_desk_mombasa');
    const tenants = (await ctx.http.get('/api/v1/tenants').set('Authorization', `Bearer ${operator}`).expect(200)).body;
    const coastways = tenants.find((t: { code: string }) => t.code === 'coastways');
    await ctx.http
      .post('/api/v1/tenants')
      .set('Authorization', `Bearer ${owner}`)
      .send({ parentId: coastways.id, type: 'branch', code: 'sneaky', name: 'Sneaky', country: 'KE' })
      .expect(404);
  });

  it('keeps every ledger transaction balanced', async () => {
    const { rows } = await ctx.pool.query(
      `SELECT txn_id FROM payments.ledger_entry GROUP BY txn_id HAVING SUM(amount) <> 0`,
    );
    expect(rows).toHaveLength(0);
  });
});
