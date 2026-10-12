import { randomUUID } from 'crypto';
import { SEED_USERS } from '../src/db/seed';
import { JobsService } from '../src/jobs/jobs.service';
import { login, startApp, stopApp } from './harness';

type Ctx = Awaited<ReturnType<typeof startApp>>;
let ctx: Ctx;
let staff: string;
let approver: string;
let manager: string;
let exec: string;
let day = 1;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const contact = { email: 'mary@acme.dev', phone: '+254722000000' };
const pax = { type: 'ADT', title: 'MS', firstName: 'Mary', lastName: 'Akinyi', dateOfBirth: '1991-06-01' };

interface Offer {
  offerId: string;
  lowestFare?: boolean;
  policy?: { inPolicy: boolean; violations: string[] };
  pricing: { sell: { amount: number }; agentCost: { amount: number } };
}

async function search(token: string, body: Record<string, unknown> = {}) {
  const date = `2027-0${(day % 9) + 1}-${String(10 + (day++ % 18)).padStart(2, '0')}`;
  const res = await ctx.http
    .post('/api/v1/flights/searches')
    .set(auth(token))
    .send({ origin: 'NBO', destination: 'DXB', departureDate: date, passengers: { ADT: 1 }, ...body })
    .expect(200);
  return res.body as { searchId: string; offers: Offer[]; policy?: { grade: string } };
}

const book = (token: string, offerId: string, extra: Record<string, unknown> = {}) =>
  ctx.http
    .post('/api/v1/bookings')
    .set(auth(token))
    .set('Idempotency-Key', randomUUID())
    .send({ offerId, passengers: [pax], contact, ...extra });

async function pendingTrip(reason = 'Client meeting moved; only later flights left') {
  const s = await search(staff, { cabin: 'BUSINESS' });
  const res = await book(staff, s.offers[0].offerId, { reasonForException: reason, searchId: s.searchId }).expect(201);
  expect(res.body.status).toBe('pending_approval');
  const { rows } = await ctx.pool.query(`SELECT id FROM policy.approval_request WHERE booking_reference = $1`, [res.body.reference]);
  return { booking: res.body, approvalId: rows[0].id as string };
}

/** Reads the one-time token out of the approval email, as the approver's mail client would. */
async function tokenFromEmail(reference: string): Promise<string> {
  const { rows } = await ctx.pool.query(
    `SELECT body_text FROM notify.notification WHERE template = 'approval.requested' AND ref_id = $1`,
    [reference],
  );
  return /token=([A-Za-z0-9_-]+)/.exec(rows[0].body_text)![1];
}

const corporateBalance = async () =>
  (await ctx.http.get('/api/v1/accounts/me').set(auth(manager)).expect(200)).body.balance as number;

beforeAll(async () => {
  ctx = await startApp();
  staff = await login(ctx.http, SEED_USERS.staff);
  approver = await login(ctx.http, SEED_USERS.approver);
  manager = await login(ctx.http, SEED_USERS.travelManager);
  exec = await login(ctx.http, SEED_USERS.executive);
});

afterAll(() => stopApp(ctx));

describe('policy in search', () => {
  it('marks every fare against the traveller’s policy and flags the lowest fare', async () => {
    const s = await search(staff);
    expect(s.policy?.grade).toBe('staff');
    expect(s.offers.every((o) => o.policy !== undefined)).toBe(true);
    expect(s.offers[0].lowestFare).toBe(true);
    expect(s.offers.filter((o) => o.lowestFare)).toHaveLength(1);
    const business = await search(staff, { cabin: 'BUSINESS' });
    expect(business.offers.every((o) => !o.policy!.inPolicy)).toBe(true);
    expect(business.offers[0].policy!.violations[0]).toBe('Business is above the allowed Economy');
  });

  it('does not annotate agency searches', async () => {
    const agent = await login(ctx.http, SEED_USERS.agent);
    const s = await search(agent);
    expect(s.offers[0].policy).toBeUndefined();
  });
});

describe('in-policy trips', () => {
  it('are paid from the company account and ticketed without approval', async () => {
    const before = await corporateBalance();
    const s = await search(staff);
    const offer = s.offers.find((o) => o.policy!.inPolicy)!;
    const res = await book(staff, offer.offerId, { searchId: s.searchId }).expect(201);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.channel).toBe('b2e');
    expect(res.body.policy).toMatchObject({ grade: 'staff', inPolicy: true, violations: [] });
    expect(before - (await corporateBalance())).toBe(offer.pricing.agentCost.amount);

    // Paid on account, so the traveller gets the confirmation but no "pay before" hold email.
    await ctx.app.get(JobsService).runAll();
    const { rows } = await ctx.pool.query(`SELECT template FROM notify.notification WHERE ref_id = $1 ORDER BY id`, [
      res.body.reference,
    ]);
    expect(rows.map((r) => r.template)).toEqual(['booking.confirmed']);
  });

  it('record the saving missed when a dearer in-policy fare is chosen', async () => {
    const s = await search(staff);
    const inPolicy = s.offers.filter((o) => o.policy!.inPolicy);
    const chosen = inPolicy[inPolicy.length - 1];
    const res = await book(staff, chosen.offerId, { searchId: s.searchId }).expect(201);
    expect(res.body.policy.missedSaving).toBe(chosen.pricing.sell.amount - s.offers[0].pricing.sell.amount);
  });

  it('need no approval for grades whose policy says never', async () => {
    const s = await search(exec, { cabin: 'BUSINESS' });
    const res = await book(exec, s.offers[0].offerId).expect(201);
    expect(res.body.status).toBe('confirmed');
  });
});

describe('out-of-policy trips', () => {
  it('need a reason before anything is held', async () => {
    const s = await search(staff, { cabin: 'BUSINESS' });
    const res = await book(staff, s.offers[0].offerId).expect(422);
    expect(res.body.code).toBe('REASON_REQUIRED');
    expect(res.body.violations).toContain('Business is above the allowed Economy');
  });

  it('go to the approver, who approves in the portal; then they are ticketed', async () => {
    const { booking, approvalId } = await pendingTrip();
    const { rows } = await ctx.pool.query(
      `SELECT recipient, subject FROM notify.notification WHERE template = 'approval.requested' AND ref_id = $1`,
      [booking.reference],
    );
    expect(rows[0].recipient).toBe(SEED_USERS.approver);
    expect(rows[0].subject).toContain('Mary Akinyi');

    const pending = await ctx.http.get('/api/v1/approvals').set(auth(approver)).expect(200);
    expect(pending.body.map((p: { reference: string }) => p.reference)).toContain(booking.reference);
    await ctx.http.post(`/api/v1/bookings/${booking.reference}/payments`).set(auth(staff)).expect(409);
    await ctx.http.post(`/api/v1/approvals/${approvalId}/decision`).set(auth(staff)).send({ decision: 'approve' }).expect(403);

    const res = await ctx.http
      .post(`/api/v1/approvals/${approvalId}/decision`)
      .set(auth(approver))
      .send({ decision: 'approve', comment: 'Fine for this client' })
      .expect(200);
    expect(res.body.bookingStatus).toBe('confirmed');
    const detail = await ctx.http.get(`/api/v1/bookings/${booking.reference}`).set(auth(staff)).expect(200);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual([
      'held',
      'approval_requested',
      'approved',
      'paid',
      'ticketed',
    ]);
  });

  it('can be rejected from the email link, once, and the hold is released', async () => {
    const { booking, approvalId } = await pendingTrip();
    const token = await tokenFromEmail(booking.reference);
    await ctx.http.get(`/api/v1/approvals/${approvalId}/by-token?token=wrong-token-123`).expect(404);
    const page = await ctx.http.get(`/api/v1/approvals/${approvalId}/by-token?token=${token}`).expect(200);
    expect(page.body).toMatchObject({ reference: booking.reference, traveller: 'Mary Akinyi', status: 'pending' });
    expect(page.body.policy.reasonForException).toContain('Client meeting');

    const res = await ctx.http
      .post(`/api/v1/approvals/${approvalId}/by-token`)
      .send({ token, decision: 'reject', comment: 'Please fly economy' })
      .expect(200);
    expect(res.body.bookingStatus).toBe('rejected');
    const again = await ctx.http.post(`/api/v1/approvals/${approvalId}/by-token`).send({ token, decision: 'approve' }).expect(409);
    expect(again.body.code).toBe('ALREADY_DECIDED');
  });

  it('are held again when the hold lapsed while waiting for approval', async () => {
    const { booking, approvalId } = await pendingTrip();
    await ctx.pool.query(`UPDATE booking.booking SET hold_expires_at = now() - interval '1 minute' WHERE reference = $1`, [
      booking.reference,
    ]);
    // The expiry job must leave trips waiting for approval alone.
    expect((await ctx.app.get(JobsService).runAll()).holdsExpired).not.toContain(booking.reference);
    const res = await ctx.http.post(`/api/v1/approvals/${approvalId}/decision`).set(auth(approver)).send({ decision: 'approve' }).expect(200);
    expect(res.body.bookingStatus).toBe('confirmed');
    const detail = await ctx.http.get(`/api/v1/bookings/${booking.reference}`).set(auth(staff)).expect(200);
    expect(detail.body.pnr).not.toBe(booking.pnr);
  });

  it('expire instead of booking at a price the approver never saw', async () => {
    const s = await search(staff, { destination: 'MBA', cabin: 'BUSINESS' });
    const res = await book(staff, s.offers[0].offerId, { reasonForException: 'Urgent site visit' }).expect(201);
    const { rows } = await ctx.pool.query(`SELECT id FROM policy.approval_request WHERE booking_reference = $1`, [res.body.reference]);
    await ctx.pool.query(`UPDATE booking.booking SET hold_expires_at = now() - interval '1 minute' WHERE reference = $1`, [
      res.body.reference,
    ]);
    const decided = await ctx.http.post(`/api/v1/approvals/${rows[0].id}/decision`).set(auth(approver)).send({ decision: 'approve' }).expect(200);
    expect(decided.body).toMatchObject({ bookingStatus: 'expired', failureReason: 'PRICE_CHANGED_BEFORE_APPROVAL' });
  });
});

describe('travel manager', () => {
  it('maintains policies per grade', async () => {
    await ctx.http
      .put('/api/v1/corporate/policies')
      .set(auth(manager))
      .send({ grade: 'intern', approvalMode: 'always', rules: { flight: { maxCabin: 'ECONOMY', minAdvanceDays: 14 } } })
      .expect(200);
    const list = await ctx.http.get('/api/v1/corporate/policies').set(auth(manager)).expect(200);
    expect(list.body.map((p: { grade: string }) => p.grade)).toEqual(['executive', 'intern', 'staff']);
    await ctx.http.get('/api/v1/corporate/policies').set(auth(staff)).expect(403);
  });

  it('assigns grades and approvers, and refuses approvers without the role', async () => {
    const employees = (await ctx.http.get('/api/v1/corporate/employees').set(auth(manager)).expect(200)).body;
    const execUser = employees.find((e: { email: string }) => e.email === SEED_USERS.executive);
    const staffUser = employees.find((e: { email: string }) => e.email === SEED_USERS.staff);
    const approverUser = employees.find((e: { email: string }) => e.email === SEED_USERS.approver);
    const bad = await ctx.http
      .put(`/api/v1/corporate/employees/${execUser.id}`)
      .set(auth(manager))
      .send({ grade: 'executive', approverId: staffUser.id })
      .expect(400);
    expect(bad.body.detail).toContain('approver role');
    await ctx.http
      .put(`/api/v1/corporate/employees/${approverUser.id}`)
      .set(auth(manager))
      .send({ grade: 'staff', approverId: approverUser.id })
      .expect(400);
    const ok = await ctx.http
      .put(`/api/v1/corporate/employees/${execUser.id}`)
      .set(auth(manager))
      .send({ grade: 'executive', costCentre: 'BOARD', approverId: approverUser.id })
      .expect(200);
    expect(ok.body).toMatchObject({ grade: 'executive', costCentre: 'BOARD', approverName: 'David Ochieng' });
  });

  it('sees spend, out-of-policy trips and missed savings by traveller', async () => {
    const res = await ctx.http.get('/api/v1/corporate/reports/spend?from=2020-01-01&to=2099-12-31').set(auth(manager)).expect(200);
    const mary = res.body.travellers.find((t: { traveller: string }) => t.traveller === 'Mary Akinyi');
    expect(mary.trips).toBeGreaterThanOrEqual(4);
    expect(mary.outOfPolicyTrips).toBeGreaterThanOrEqual(2);
    expect(res.body.totals.missedSavings).toBeGreaterThan(0);
    await ctx.http.get('/api/v1/corporate/reports/spend?from=2020-01-01&to=2099-12-31').set(auth(staff)).expect(403);
  });
});
