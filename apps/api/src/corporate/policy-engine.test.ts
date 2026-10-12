import { evaluateFlight, evaluateHotel, needsApproval } from './policy-engine';

const today = new Date('2027-01-01T10:00:00Z');
const trip = {
  cabin: 'ECONOMY' as const,
  sellAmount: 60_000,
  currency: 'USD',
  travellers: 1,
  departureDate: '2027-01-20',
  refundable: false,
};

describe('flight policy', () => {
  const rules = { maxCabin: 'ECONOMY' as const, maxFarePerTraveller: 80_000, minAdvanceDays: 7 };

  it('passes a trip inside every rule', () => {
    expect(evaluateFlight(trip, rules, today)).toEqual({ inPolicy: true, violations: [] });
  });

  it('explains each broken rule', () => {
    const v = evaluateFlight({ ...trip, cabin: 'BUSINESS', sellAmount: 200_000, departureDate: '2027-01-03' }, rules, today);
    expect(v.inPolicy).toBe(false);
    expect(v.violations).toEqual([
      'Business is above the allowed Economy',
      'Fare USD 2000.00 per traveller is above the USD 800.00 limit',
      'Booked 2 day(s) before departure; policy asks for 7',
    ]);
  });

  it('applies the fare cap per traveller', () => {
    expect(evaluateFlight({ ...trip, sellAmount: 150_000, travellers: 2 }, rules, today).inPolicy).toBe(true);
  });

  it('can require refundable fares', () => {
    expect(evaluateFlight(trip, { refundableOnly: true }, today).violations).toEqual(['Policy requires a refundable fare']);
  });

  it('treats missing rules as in policy', () => {
    expect(evaluateFlight({ ...trip, cabin: 'FIRST' }, undefined, today).inPolicy).toBe(true);
  });
});

describe('hotel policy', () => {
  it('checks stars and the nightly rate per room', () => {
    const v = evaluateHotel({ stars: 5, sellAmount: 150_000, currency: 'USD', nights: 3, rooms: 1 }, { maxStars: 4, maxNightlyPerRoom: 20_000 });
    expect(v.violations).toEqual(['5-star hotel is above the 4-star limit', 'USD 500.00 per room per night is above the USD 200.00 limit']);
  });
});

describe('approval modes', () => {
  const inPolicy = { inPolicy: true, violations: [] };
  const outOfPolicy = { inPolicy: false, violations: ['x'] };
  it('follows the mode', () => {
    expect(needsApproval('always', inPolicy)).toBe(true);
    expect(needsApproval('out_of_policy', inPolicy)).toBe(false);
    expect(needsApproval('out_of_policy', outOfPolicy)).toBe(true);
    expect(needsApproval('never', outOfPolicy)).toBe(false);
  });
});
