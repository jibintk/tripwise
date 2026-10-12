import { money } from '@tripwise/contracts';
import { randomUUID } from 'crypto';
import { SEED_USERS } from '../src/db/seed';
import { JobsService } from '../src/jobs/jobs.service';
import { LedgerService } from '../src/payments/ledger.service';
import { contact, login, passenger, startApp, stopApp } from './harness';

type Ctx = Awaited<ReturnType<typeof startApp>>;
let ctx: Ctx;
let agent: string;
let operator: string;
let gsaAdmin: string;
let jobs: JobsService;
let day = 1;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Searches a fresh date (so offers are new) and holds the cheapest fare. */
async function hold(token: string, lastName = 'KAMAU') {
  const date = `2027-01-${String(day++).padStart(2, '0')}`;
  const search = await ctx.http
    .post('/api/v1/flights/searches')
    .set(auth(token))
    .send({ origin: 'NBO', destination: 'JNB', departureDate: date, passengers: { ADT: 1 } })
    .expect(200);
  const res = await ctx.http
    .post('/api/v1/bookings')
    .set(auth(token))
    .set('Idempotency-Key', randomUUID())
    .send({ offerId: search.body.offers[0].offerId, passengers: [passenger(lastName)], contact })
    .expect(201);
  return res.body as { reference: string; pricing: { agentCost: { amount: number; currency: string } } };
}

const pay = (token: string, ref: string) => ctx.http.post(`/api/v1/bookings/${ref}/payments`).set(auth(token));

beforeAll(async () => {
  ctx = await startApp();
  jobs = ctx.app.get(JobsService);
  agent = await login(ctx.http, SEED_USERS.agent);
  operator = await login(ctx.http, SEED_USERS.operatorAdmin);
  gsaAdmin = await login(ctx.http, SEED_USERS.gsaAdmin);
});

afterAll(() => stopApp(ctx));

describe('events and notifications', () => {
  it('emails the customer once when a booking is ticketed', async () => {
    const b = await hold(agent);
    await pay(agent, b.reference).expect(200);
    const first = await jobs.runAll();
    expect(first.eventsDelivered).toBeGreaterThanOrEqual(3); // held, paid, confirmed
    await jobs.runAll();
    const { rows } = await ctx.pool.query(
      `SELECT template, recipient, status, subject FROM notify.notification WHERE ref_id = $1 ORDER BY id`,
      [b.reference],
    );
    expect(rows.map((r) => r.template)).toEqual(['booking.held', 'booking.confirmed']);
    expect(rows.every((r) => r.status === 'sent' && r.recipient === contact.email)).toBe(true);
    expect(rows[1].subject).toContain(b.reference);
  });

  it('leaves no event unpublished after a run', async () => {
    await jobs.runAll();
    const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM platform.outbox_event WHERE published_at IS NULL`);
    expect(rows[0].n).toBe(0);
  });
});

describe('hold expiry', () => {
  it('expires holds past their time limit and blocks payment', async () => {
    const b = await hold(agent);
    await ctx.pool.query(`UPDATE booking.booking SET hold_expires_at = now() - interval '1 minute' WHERE reference = $1`, [
      b.reference,
    ]);
    const result = await jobs.runAll();
    expect(result.holdsExpired).toContain(b.reference);
    const detail = await ctx.http.get(`/api/v1/bookings/${b.reference}`).set(auth(agent)).expect(200);
    expect(detail.body.status).toBe('expired');
    await pay(agent, b.reference).expect(409);
  });
});

describe('ticketing recovery', () => {
  it('finishes a booking that was paid but never ticketed', async () => {
    const b = await hold(agent);
    // Simulate a crash right after payment: money taken, status left in 'ticketing'.
    const ledger = ctx.app.get(LedgerService);
    const { rows: op } = await ctx.pool.query(`SELECT id FROM tenancy.tenant WHERE type = 'operator'`);
    const { rows: me } = await ctx.pool.query(`SELECT tenant_id FROM booking.booking WHERE reference = $1`, [b.reference]);
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await ledger.chargeBooking(client, me[0].tenant_id, op[0].id, money(b.pricing.agentCost.amount, 'USD'), b.reference);
      await client.query(
        `UPDATE booking.booking SET status = 'ticketing', updated_at = now() - interval '1 hour' WHERE reference = $1`,
        [b.reference],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const result = await jobs.runAll();
    expect(result.ticketingRecovered).toEqual([`${b.reference}:confirmed`]);
  });
});

describe('operations queue', () => {
  it('lists failed bookings until operations resolves them', async () => {
    const b = await hold(agent, 'TICKETFAIL');
    await pay(agent, b.reference).expect(200);
    const queue = await ctx.http.get('/api/v1/ops/queue').set(auth(operator)).expect(200);
    expect(queue.body.map((x: { reference: string }) => x.reference)).toContain(b.reference);
    await ctx.http.get('/api/v1/ops/queue').set(auth(agent)).expect(403);
    await ctx.http
      .post(`/api/v1/ops/bookings/${b.reference}/resolve`)
      .set(auth(operator))
      .send({ note: 'Called the airline; customer rebooked on TW-NEXT' })
      .expect(200);
    const after = await ctx.http.get('/api/v1/ops/queue').set(auth(operator)).expect(200);
    expect(after.body.map((x: { reference: string }) => x.reference)).not.toContain(b.reference);
  });
});

describe('e-ticket', () => {
  it('serves a PDF for ticketed bookings only', async () => {
    const held = await hold(agent);
    await ctx.http.get(`/api/v1/bookings/${held.reference}/eticket.pdf`).set(auth(agent)).expect(409);
    await pay(agent, held.reference).expect(200);
    const res = await ctx.http
      .get(`/api/v1/bookings/${held.reference}/eticket.pdf`)
      .set(auth(agent))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('back office', () => {
  let agencyId: string;
  let newUser: { email: string; temporaryPassword: string };

  it('lets a GSA admin open an agency and create its first user', async () => {
    const created = await ctx.http
      .post('/api/v1/tenants')
      .set(auth(gsaAdmin))
      .send({ type: 'agency', code: 'lakeside_travel', name: 'Lakeside Travel', country: 'KE' })
      .expect(201);
    agencyId = created.body.id;
    const user = await ctx.http
      .post(`/api/v1/tenants/${agencyId}/users`)
      .set(auth(gsaAdmin))
      .send({ email: 'desk@lakeside.dev', name: 'Lakeside Desk', roles: ['admin', 'agent'] })
      .expect(201);
    expect(user.body.temporaryPassword).toHaveLength(12);
    newUser = user.body;
    const list = await ctx.http.get(`/api/v1/tenants/${agencyId}/users`).set(auth(gsaAdmin)).expect(200);
    expect(list.body.map((u: { email: string }) => u.email)).toEqual(['desk@lakeside.dev']);
  });

  it('refuses to grant roles the creator does not hold', async () => {
    const res = await ctx.http
      .post(`/api/v1/tenants/${agencyId}/users`)
      .set(auth(gsaAdmin))
      .send({ email: 'money@lakeside.dev', name: 'Money', roles: ['finance'] })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('suspending an agency locks out its users immediately', async () => {
    const login1 = await ctx.http
      .post('/api/v1/auth/login')
      .send({ email: newUser.email, password: newUser.temporaryPassword })
      .expect(200);
    const token = login1.body.accessToken;
    await ctx.http.patch(`/api/v1/tenants/${agencyId}`).set(auth(gsaAdmin)).send({ status: 'suspended' }).expect(200);
    const blocked = await ctx.http.get('/api/v1/bookings').set(auth(token)).expect(401);
    expect(blocked.body.code).toBe('ACCOUNT_INACTIVE');
    await ctx.http.post('/api/v1/auth/login').send({ email: newUser.email, password: newUser.temporaryPassword }).expect(403);
  });

  it('shows wallets in scope and lets only operator finance set credit lines', async () => {
    const wallets = await ctx.http.get('/api/v1/accounts').set(auth(operator)).expect(200);
    const safari = wallets.body.find((w: { name: string }) => w.name === 'Safari Desk Travel');
    expect(safari.creditLimit).toBe(100_000);
    expect(safari.available).toBe(safari.balance + safari.creditLimit);
    await ctx.http
      .put(`/api/v1/accounts/${safari.tenantId}/credit-limit`)
      .set(auth(gsaAdmin))
      .send({ creditLimit: 900_000, currency: 'USD' })
      .expect(403);
    const updated = await ctx.http
      .put(`/api/v1/accounts/${safari.tenantId}/credit-limit`)
      .set(auth(operator))
      .send({ creditLimit: 250_000, currency: 'USD' })
      .expect(200);
    expect(updated.body.creditLimit).toBe(250_000);
  });
});
