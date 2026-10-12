import { randomUUID } from 'crypto';
import { SEED_USERS } from '../src/db/seed';
import { JobsService } from '../src/jobs/jobs.service';
import { login, startApp, stopApp } from './harness';

type Ctx = Awaited<ReturnType<typeof startApp>>;
let ctx: Ctx;
let agent: string;
let operator: string;
let month = 1;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const contact = { email: 'wanjiru@example.com', phone: '+254711000000' };
const guest = (lastName = 'Wanjiru') => ({ title: 'MS', firstName: 'Grace', lastName });

interface Offer {
  rateId: string;
  roomName: string;
  board: string;
  refundable: boolean;
  net?: { amount: number };
  pricing: { agentCost: { amount: number }; sell: { amount: number } };
}

/** A fresh stay each call, so searches never share cached rates between tests. */
function stay(city = 'ZNZ', rooms = [{ adults: 2 }]) {
  const m = String(month++).padStart(2, '0');
  return { city, checkIn: `2028-${m}-10`, checkOut: `2028-${m}-13`, rooms };
}

async function searchHotels(token: string, body = stay()) {
  return (await ctx.http.post('/api/v1/hotels/searches').set(auth(token)).send(body).expect(200)).body;
}

async function roomsFor(token: string, body = stay()) {
  const s = await searchHotels(token, body);
  const hotel = s.hotels[0];
  const r = await ctx.http.get(`/api/v1/hotels/searches/${s.searchId}/hotels/${hotel.id}`).set(auth(token)).expect(200);
  return { search: s, hotel, offers: r.body.offers as Offer[] };
}

const book = (token: string, rateId: string, opts: { guests?: object[]; expected?: number } = {}) =>
  ctx.http
    .post('/api/v1/hotels/bookings')
    .set(auth(token))
    .set('Idempotency-Key', randomUUID())
    .send({ rateId, guests: opts.guests ?? [guest()], contact, expectedSellAmount: opts.expected });

const pay = (token: string, ref: string) => ctx.http.post(`/api/v1/bookings/${ref}/payments`).set(auth(token));
const wallet = async () => (await ctx.http.get('/api/v1/accounts/me').set(auth(agent)).expect(200)).body;

beforeAll(async () => {
  ctx = await startApp();
  agent = await login(ctx.http, SEED_USERS.agent);
  operator = await login(ctx.http, SEED_USERS.operatorAdmin);
});

afterAll(() => stopApp(ctx));

describe('hotel search and content mapping', () => {
  it('shows each physical hotel once even when two suppliers sell it', async () => {
    const s = await searchHotels(agent);
    expect(s.nights).toBe(3);
    expect(s.hotels).toHaveLength(3); // supplier A: 3 hotels, supplier B: 2 of the same 3
    expect(s.hotels.filter((h: { suppliers: number }) => h.suppliers === 2)).toHaveLength(2);
    const { rows } = await ctx.pool.query(
      `SELECT count(DISTINCT hotel_id)::int AS hotels, count(*)::int AS listings FROM hotels.supplier_map m
         JOIN hotels.hotel h ON h.id = m.hotel_id WHERE h.city = 'ZNZ'`,
    );
    expect(rows[0]).toEqual({ hotels: 3, listings: 5 });
  });

  it('collapses identical rooms from several suppliers to the cheapest and applies hotel markups', async () => {
    const asAgent = await roomsFor(agent, stay('ZNZ'));
    const asOperator = await ctx.http
      .get(`/api/v1/hotels/searches/${asAgent.search.searchId}/hotels/${asAgent.hotel.id}`)
      .set(auth(operator))
      .expect(200);
    expect(asAgent.offers).toHaveLength(4); // four room types, each offered by up to two suppliers
    expect(asAgent.offers[0].net).toBeUndefined();
    const op = asOperator.body.offers as Offer[];
    const first = asAgent.offers[0];
    const net = op.find((o) => o.roomName === first.roomName && o.board === first.board && o.refundable === first.refundable)!.net!
      .amount;
    const afterOperator = net + Math.round((net * 800) / 10_000);
    const afterGsa = afterOperator + Math.round((afterOperator * 200) / 10_000);
    expect(first.pricing.agentCost.amount).toBe(afterGsa);
    expect(first.pricing.sell.amount).toBe(afterGsa); // the agency has no hotel markup of its own
  });

  it('validates the stay', async () => {
    const res = await ctx.http
      .post('/api/v1/hotels/searches')
      .set(auth(agent))
      .send({ city: 'ZNZ', checkIn: '2028-05-10', checkOut: '2028-05-10', rooms: [{ adults: 2 }] })
      .expect(400);
    expect(res.body.errors[0].field).toBe('checkOut');
  });
});

describe('hotel booking', () => {
  it('holds the price, books the room on payment and issues a voucher', async () => {
    const before = await wallet();
    const { offers } = await roomsFor(agent);
    const offer = offers.find((o) => o.refundable)!;
    const held = (await book(agent, offer.rateId, { expected: offer.pricing.sell.amount }).expect(201)).body;
    expect(held.product).toBe('hotel');
    expect(held.status).toBe('held');
    expect(held.pnr).toBeNull();
    expect(new Date(held.holdExpiresAt).getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);

    const paid = (await pay(agent, held.reference).expect(200)).body;
    expect(paid.status).toBe('confirmed');
    expect(paid.pnr).toBeTruthy();
    expect(paid.hotelConfirmation).toMatch(/^\d{6}$/);
    expect(paid.stay).toMatchObject({ nights: 3 });
    expect(before.balance - (await wallet()).balance).toBe(offer.pricing.agentCost.amount);

    const pdf = await ctx.http
      .get(`/api/v1/bookings/${held.reference}/voucher.pdf`)
      .set(auth(agent))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('needs one lead guest per room', async () => {
    const { offers } = await roomsFor(agent, stay('NBO', [{ adults: 2 }, { adults: 1 }]));
    const res = await book(agent, offers[0].rateId, { guests: [guest()] }).expect(400);
    expect(res.body.detail).toContain('one lead guest per room (2)');
    await book(agent, offers[0].rateId, { guests: [guest(), guest('Otieno')] }).expect(201);
  });

  it('stops with PRICE_CHANGED when the hotel reprices', async () => {
    const { offers } = await roomsFor(agent, stay('MBA'));
    const res = await book(agent, offers[0].rateId, { expected: offers[0].pricing.sell.amount }).expect(409);
    expect(res.body.code).toBe('PRICE_CHANGED');
    expect(res.body.newSellAmount).toBeGreaterThan(offers[0].pricing.sell.amount);
  });

  it('refunds in full when the property rejects the booking, and never retries it', async () => {
    const before = await wallet();
    const { offers } = await roomsFor(agent);
    const held = (await book(agent, offers[0].rateId, { guests: [guest('Bookfail')] }).expect(201)).body;
    const result = (await pay(agent, held.reference).expect(200)).body;
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('BOOKING_FAILED');
    expect((await wallet()).balance).toBe(before.balance);
    const queue = await ctx.http.get('/api/v1/ops/queue').set(auth(operator)).expect(200);
    expect(queue.body.map((b: { reference: string }) => b.reference)).toContain(held.reference);
  });

  it('refunds everything when a refundable stay is cancelled in time', async () => {
    const { offers } = await roomsFor(agent);
    const offer = offers.find((o) => o.refundable)!;
    const held = (await book(agent, offer.rateId).expect(201)).body;
    await pay(agent, held.reference).expect(200);
    const before = await wallet();
    const res = await ctx.http.post(`/api/v1/bookings/${held.reference}/cancel`).set(auth(agent)).expect(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancellation.penalty.amount).toBe(0);
    expect((await wallet()).balance - before.balance).toBe(offer.pricing.agentCost.amount);
  });

  it('refunds nothing when a non-refundable stay is cancelled', async () => {
    const { offers } = await roomsFor(agent);
    const offer = offers.find((o) => !o.refundable)!;
    const held = (await book(agent, offer.rateId).expect(201)).body;
    await pay(agent, held.reference).expect(200);
    const before = await wallet();
    const res = await ctx.http.post(`/api/v1/bookings/${held.reference}/cancel`).set(auth(agent)).expect(200);
    expect(res.body.cancellation.refunded.amount).toBe(0);
    expect((await wallet()).balance).toBe(before.balance);
  });

  it('never auto-retries a hotel booking stuck after payment', async () => {
    const { offers } = await roomsFor(agent);
    const held = (await book(agent, offers[0].rateId).expect(201)).body;
    await ctx.pool.query(
      `UPDATE booking.booking SET status = 'ticketing', updated_at = now() - interval '1 hour' WHERE reference = $1`,
      [held.reference],
    );
    const result = await ctx.app.get(JobsService).runAll();
    expect(result.ticketingRecovered).toEqual([]);
    const queue = await ctx.http.get('/api/v1/ops/queue').set(auth(operator)).expect(200);
    expect(queue.body.map((b: { reference: string }) => b.reference)).toContain(held.reference);
  });

  it('emails the guest a hotel confirmation, not a flight ticket', async () => {
    await ctx.app.get(JobsService).runAll();
    const { rows } = await ctx.pool.query(
      `SELECT subject, body_text FROM notify.notification WHERE template = 'booking.confirmed' ORDER BY id LIMIT 1`,
    );
    expect(rows[0].subject).toMatch(/^Your hotel voucher TW-/);
    expect(rows[0].body_text).toContain('check-in');
  });

  it('filters the bookings list by product', async () => {
    const hotels = await ctx.http.get('/api/v1/bookings?product=hotel').set(auth(agent)).expect(200);
    expect(hotels.body.length).toBeGreaterThan(0);
    expect(hotels.body.every((b: { product: string }) => b.product === 'hotel')).toBe(true);
  });
});
