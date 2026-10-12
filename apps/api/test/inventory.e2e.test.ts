import { randomUUID } from 'crypto';
import { SEED_USERS } from '../src/db/seed';
import { JobsService } from '../src/jobs/jobs.service';
import { OwnInventorySupplier } from '../src/inventory/own-inventory.supplier';
import { contact, login, passenger, startApp, stopApp } from './harness';

type Ctx = Awaited<ReturnType<typeof startApp>>;
let ctx: Ctx;
let operator: string;
let agent: string;
let otherAgent: string;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
// Each test flies its own flight number on its own date, so search caching never mixes tests.
let flight = 100;
let day = 20;

async function loadSeries(overrides: Record<string, unknown> = {}) {
  const res = await ctx.http
    .post('/api/v1/inventory/allotments')
    .set(auth(operator))
    .send({
      kind: 'blocked',
      carrier: 'KQ',
      flightNumber: String(flight++),
      origin: 'NBO',
      destination: 'KGL',
      dates: [inDays(day++)],
      departureTime: '08:15',
      arrivalTime: '09:30',
      durationMin: 75,
      cabin: 'ECONOMY',
      baseAmount: 10_000,
      taxAmount: 5_000,
      currency: 'USD',
      seats: 3,
      releaseDaysBefore: 5,
      ...overrides,
    })
    .expect(201);
  return res.body.created as { id: string; departureLocal: string; origin: string; destination: string; flightNumber: string }[];
}

const search = (token: string, a: { origin: string; destination: string; departureLocal: string }, pax = 1, extra = {}) =>
  ctx.http
    .post('/api/v1/flights/searches')
    .set(auth(token))
    .send({ origin: a.origin, destination: a.destination, departureDate: a.departureLocal.slice(0, 10), passengers: { ADT: pax }, ...extra })
    .expect(200)
    .then((r) => r.body);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ownOffers = (result: { offers: any[] }) => result.offers.filter((o) => o.offerId.startsWith('inv_'));

const hold = (token: string, offerId: string, pax = 1, expected?: number) =>
  ctx.http
    .post('/api/v1/bookings')
    .set(auth(token))
    .set('Idempotency-Key', randomUUID())
    .send({ offerId, passengers: Array.from({ length: pax }, (_, i) => passenger(`TRAVELLER${'ABCDEFGHI'[i]}`)), contact, expectedSellAmount: expected });

const allotment = async (id: string) => {
  const rows = (await ctx.http.get('/api/v1/inventory/allotments').set(auth(operator)).expect(200)).body as { id: string }[];
  return rows.find((r) => r.id === id) as unknown as { seatsHeld: number; seatsSold: number; seatsAvailable: number; status: string };
};

beforeAll(async () => {
  ctx = await startApp();
  operator = await login(ctx.http, SEED_USERS.operatorAdmin);
  agent = await login(ctx.http, SEED_USERS.agent);
  otherAgent = await login(ctx.http, SEED_USERS.otherAgent);
});

afterAll(() => stopApp(ctx));

describe('loading inventory', () => {
  it('creates one allotment per date and skips dates that already exist', async () => {
    const dates = [inDays(60), inDays(61)];
    const first = await ctx.http
      .post('/api/v1/inventory/allotments')
      .set(auth(operator))
      .send({ kind: 'charter', carrier: 'XK', flightNumber: '900', origin: 'NBO', destination: 'MRE', dates, departureTime: '23:30', arrivalTime: '00:15', arrivalDayOffset: 1, durationMin: 45, cabin: 'ECONOMY', baseAmount: 15_000, taxAmount: 1_000, currency: 'usd', seats: 12, releaseDaysBefore: 3 })
      .expect(201);
    expect(first.body.created).toHaveLength(2);
    expect(first.body.created[0]).toMatchObject({ arrivalLocal: `${inDays(61)}T00:15`, seatsAvailable: 12, currency: 'USD', status: 'active' });
    const again = await ctx.http
      .post('/api/v1/inventory/allotments')
      .set(auth(operator))
      .send({ kind: 'charter', carrier: 'XK', flightNumber: '900', origin: 'NBO', destination: 'MRE', dates: [dates[1], inDays(62)], departureTime: '23:30', arrivalTime: '00:15', arrivalDayOffset: 1, durationMin: 45, cabin: 'ECONOMY', baseAmount: 15_000, taxAmount: 1_000, currency: 'USD', seats: 12 })
      .expect(201);
    expect(again.body.created).toHaveLength(1);
    expect(again.body.skipped).toEqual([dates[1]]);
  });

  it('is operator-only', async () => {
    await ctx.http.get('/api/v1/inventory/allotments').set(auth(agent)).expect(403);
    await ctx.http.post('/api/v1/inventory/allotments').set(auth(agent)).send({}).expect(403);
  });
});

describe('selling own seats', () => {
  it('appears in flight search next to other suppliers, priced through the agency chain', async () => {
    const [a] = await loadSeries();
    const asAgent = await search(agent, a);
    const own = ownOffers(asAgent);
    expect(own).toHaveLength(1);
    expect(asAgent.offers.length).toBeGreaterThan(1);
    expect(own[0].supplier).toBe('owninventory');
    expect(own[0].fare).toBeUndefined();
    expect(own[0].slices[0].segments[0]).toMatchObject({ marketingCarrier: 'KQ', flightNumber: `KQ${a.flightNumber}`, departureLocal: `${a.departureLocal}:00` });
    // 3% operator + 1.5% GSA on USD 150 net, plus the agency's USD 15 fee
    expect(own[0].pricing.agentCost.amount).toBe(Math.round(Math.round(15_000 * 1.03) * 1.015));
    expect(own[0].pricing.sell.amount).toBe(own[0].pricing.agentCost.amount + 1_500);
    const asOperator = await search(operator, a);
    expect(ownOffers(asOperator)[0].fare.total.amount).toBe(15_000);
  });

  it('holds, tickets and releases seats against the allotment', async () => {
    const [a] = await loadSeries();
    const offer = ownOffers(await search(agent, a, 2))[0];
    const booking = (await hold(agent, offer.offerId, 2).expect(201)).body;
    expect(booking.pnr).toMatch(/^[A-Z2-9]{6}$/);
    expect(await allotment(a.id)).toMatchObject({ seatsHeld: 2, seatsSold: 0, seatsAvailable: 1 });

    // Only one seat left, so a two-person search no longer offers this flight.
    expect(ownOffers(await search(otherAgent, a, 2, { cabin: 'ECONOMY', returnDate: undefined, passengers: { ADT: 1, CHD: 1 } }))).toHaveLength(0);

    const paid = (await ctx.http.post(`/api/v1/bookings/${booking.reference}/payments`).set(auth(agent)).expect(200)).body;
    expect(paid.status).toBe('confirmed');
    expect(paid.ticketNumbers).toHaveLength(2);
    expect(paid.ticketNumbers[0]).toMatch(/^990\d{10}$/);
    expect(await allotment(a.id)).toMatchObject({ seatsHeld: 0, seatsSold: 2, seatsAvailable: 1 });

    const manifest = (await ctx.http.get(`/api/v1/inventory/allotments/${a.id}/manifest`).set(auth(operator)).expect(200)).body;
    expect(manifest.passengers).toHaveLength(2);
    expect(manifest.passengers[0]).toMatchObject({ pnr: booking.pnr, status: 'ticketed', lastName: 'TRAVELLERA', ticketNumber: paid.ticketNumbers[0] });
    const csv = await ctx.http.get(`/api/v1/inventory/allotments/${a.id}/manifest.csv`).set(auth(operator)).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toBe('pnr,status,type,title,lastName,firstName,dateOfBirth,documentNumber,ticketNumber');
    expect(csv.text).toContain('"TRAVELLERB"');
  });

  it('gives seats back when a held booking is cancelled or expires', async () => {
    const [a] = await loadSeries();
    const offer = ownOffers(await search(agent, a))[0];
    const first = (await hold(agent, offer.offerId).expect(201)).body;
    const second = (await hold(agent, offer.offerId).expect(201)).body;
    expect((await allotment(a.id)).seatsHeld).toBe(2);

    await ctx.http.post(`/api/v1/bookings/${first.reference}/cancel`).set(auth(agent)).expect(200);
    expect((await allotment(a.id)).seatsHeld).toBe(1);

    await ctx.pool.query(`UPDATE booking.booking SET hold_expires_at = now() - interval '1 minute' WHERE reference = $1`, [second.reference]);
    const run = await ctx.app.get(JobsService).runAll();
    expect(run.holdsExpired).toContain(second.reference);
    expect(await allotment(a.id)).toMatchObject({ seatsHeld: 0, seatsAvailable: 3 });
  });

  it('never sells the last seat twice', async () => {
    const [a] = await loadSeries({ seats: 1 });
    const offer = ownOffers(await search(agent, a))[0];
    const results = await Promise.all([hold(agent, offer.offerId), hold(otherAgent, offer.offerId), hold(agent, offer.offerId)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('SOLD_OUT');
    expect(await allotment(a.id)).toMatchObject({ seatsHeld: 1, seatsAvailable: 0 });
  });

  it('sells return trips from two allotments under one PNR', async () => {
    const [out] = await loadSeries({ flightNumber: '700', dates: [inDays(40)] });
    const [back] = await loadSeries({ flightNumber: '701', origin: 'KGL', destination: 'NBO', dates: [inDays(44)], departureTime: '18:00', arrivalTime: '19:15' });
    const result = await search(agent, out, 1, { returnDate: inDays(44) });
    const offer = ownOffers(result)[0];
    expect(offer.slices).toHaveLength(2);
    expect(offer.slices[1].segments[0].flightNumber).toBe('KQ701');
    const booking = (await hold(agent, offer.offerId).expect(201)).body;
    expect((await allotment(out.id)).seatsHeld).toBe(1);
    expect((await allotment(back.id)).seatsHeld).toBe(1);
    const paid = (await ctx.http.post(`/api/v1/bookings/${booking.reference}/payments`).set(auth(agent)).expect(200)).body;
    expect(paid.status).toBe('confirmed');
    expect((await allotment(back.id)).seatsSold).toBe(1);
  });
});

describe('managing allotments', () => {
  it('picks up fare changes at booking time', async () => {
    const [a] = await loadSeries();
    const offer = ownOffers(await search(agent, a))[0];
    await ctx.http.patch(`/api/v1/inventory/allotments/${a.id}`).set(auth(operator)).send({ baseAmount: 12_000 }).expect(200);
    const res = await hold(agent, offer.offerId, 1, offer.pricing.sell.amount).expect(409);
    expect(res.body.code).toBe('PRICE_CHANGED');
    expect(res.body.newSellAmount).toBeGreaterThan(offer.pricing.sell.amount);
  });

  it('refuses capacity below what is already held or sold', async () => {
    const [a] = await loadSeries();
    const offer = ownOffers(await search(agent, a, 2))[0];
    await hold(agent, offer.offerId, 2).expect(201);
    const res = await ctx.http.patch(`/api/v1/inventory/allotments/${a.id}`).set(auth(operator)).send({ seatsTotal: 1 }).expect(409);
    expect(res.body.code).toBe('CAPACITY_BELOW_SOLD');
    await ctx.http.patch(`/api/v1/inventory/allotments/${a.id}`).set(auth(operator)).send({ seatsTotal: 10 }).expect(200);
    expect((await allotment(a.id)).seatsAvailable).toBe(8);
  });

  it('stops selling closed or released allotments', async () => {
    const [a] = await loadSeries();
    const offer = ownOffers(await search(agent, a))[0];
    await ctx.http.patch(`/api/v1/inventory/allotments/${a.id}`).set(auth(operator)).send({ status: 'closed' }).expect(200);
    expect((await hold(agent, offer.offerId).expect(409)).body.code).toBe('SOLD_OUT');

    const [b] = await loadSeries();
    await ctx.http
      .patch(`/api/v1/inventory/allotments/${b.id}`)
      .set(auth(operator))
      .send({ releaseAt: new Date(Date.now() - 60_000).toISOString() })
      .expect(200);
    expect(ownOffers(await search(agent, b))).toHaveLength(0);
    expect((await allotment(b.id)).status).toBe('released');
  });

  it('releases seat holds left behind by bookings that never saved', async () => {
    const [a] = await loadSeries();
    const offer = ownOffers(await search(agent, a))[0];
    const own = ctx.app.get(OwnInventorySupplier);
    const ref = await own.hold(
      { ...offer, supplier: 'owninventory' } as never,
      [passenger('ORPHAN') as never],
      { traceId: 't', tenantId: 'x', timeoutMs: 1000 },
    );
    await ctx.pool.query(`UPDATE inventory.seat_hold SET expires_at = now() - interval '1 hour' WHERE pnr = $1`, [ref.pnr]);
    expect(await own.releaseStaleHolds()).toEqual([ref.pnr]);
    expect((await allotment(a.id)).seatsHeld).toBe(0);
  });
});
