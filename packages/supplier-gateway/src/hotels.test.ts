import { CallContext } from '@tripwise/contracts';
import { distanceMetres, findMaster, isSameHotel, MockHotelSupplier, nightsBetween, normalisedName } from './index';

const ctx: CallContext = { traceId: 't', tenantId: 'x', timeoutMs: 1000 };
const req = { city: 'ZNZ', checkIn: '2027-03-10', checkOut: '2027-03-13', rooms: [{ adults: 2 }] };

describe('hotel mapping', () => {
  const stoneTown = { name: 'Stone Town Heritage Hotel', city: 'ZNZ', latitude: -6.1622, longitude: 39.1871 };

  it('normalises names', () => {
    expect(normalisedName('The STONE TOWN Heritage Hotel!')).toBe('stone town heritage');
    expect(normalisedName('Café & Hôtel du Lac')).toBe('cafe du lac');
  });

  it('matches the same property described differently', () => {
    expect(isSameHotel(stoneTown, { ...stoneTown, name: 'STONE TOWN HERITAGE HOTEL', latitude: -6.162, longitude: 39.1869 })).toBe(true);
    expect(isSameHotel(stoneTown, { ...stoneTown, name: 'Stone Town Heritage Boutique', latitude: -6.1623 })).toBe(true);
  });

  it('keeps different properties apart', () => {
    expect(isSameHotel(stoneTown, { ...stoneTown, city: 'DAR' })).toBe(false);
    expect(isSameHotel(stoneTown, { ...stoneTown, name: 'Zanzibar Coral Lodge', latitude: -6.1623 })).toBe(false);
    // similar name but 2 km away
    expect(isSameHotel(stoneTown, { ...stoneTown, name: 'Stone Town Heritage Boutique', latitude: -6.18 })).toBe(false);
  });

  it('refuses ambiguous matches', () => {
    const masters = [
      { id: '1', ...stoneTown },
      { id: '2', ...stoneTown, name: 'Stone Town Heritage Hotel', latitude: -6.1625 },
    ];
    expect(findMaster(stoneTown, masters)).toBeUndefined();
  });

  it('measures distance', () => {
    expect(Math.round(distanceMetres(stoneTown, { latitude: -6.1622, longitude: 39.1971 }) / 100)).toBe(11); // ~1.1 km
  });
});

describe('MockHotelSupplier', () => {
  it('prices the whole stay for every room', async () => {
    const one = await new MockHotelSupplier().search(req, ctx);
    const two = await new MockHotelSupplier().search({ ...req, rooms: [{ adults: 2 }, { adults: 2 }] }, ctx);
    expect(nightsBetween(req.checkIn, req.checkOut)).toBe(3);
    expect(two[0].rates[0].price.total.amount).toBe(one[0].rates[0].price.total.amount * 2);
  });

  it('describes overlapping hotels differently in variant b', async () => {
    const a = await new MockHotelSupplier({ variant: 'a' }).search(req, ctx);
    const b = await new MockHotelSupplier({ variant: 'b' }).search(req, ctx);
    expect(b.length).toBeLessThan(a.length);
    const match = a.find((x) => isSameHotel(
      { ...x.content, latitude: x.content.latitude, longitude: x.content.longitude },
      { ...b[0].content },
    ));
    expect(match).toBeDefined();
    expect(match!.content.supplierHotelId).not.toBe(b[0].content.supplierHotelId);
  });

  it('charges a penalty only after the free-cancellation deadline', async () => {
    const s = new MockHotelSupplier();
    const [hotel] = await s.search(req, ctx);
    const refundable = hotel.rates.find((r) => r.refundable)!;
    const booked = await s.book(refundable, req, [{ title: 'MR', firstName: 'A', lastName: 'B' }], ctx);
    expect((await s.cancel(booked.supplierReference, ctx)).penalty.amount).toBe(0);
    const nonRef = hotel.rates.find((r) => !r.refundable)!;
    const b2 = await s.book(nonRef, req, [{ title: 'MR', firstName: 'A', lastName: 'B' }], ctx);
    expect((await s.cancel(b2.supplierReference, ctx)).penalty.amount).toBe(nonRef.price.net.amount);
  });
});
