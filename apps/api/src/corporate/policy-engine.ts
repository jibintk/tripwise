/**
 * Travel policy rules and their evaluation. Pure functions: the same inputs always give the same
 * verdict, so the result stored on a booking can be explained and audited later.
 */

export type Cabin = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';

export interface FlightRules {
  maxCabin?: Cabin;
  /** Highest sell price per traveller, in minor units of the corporate's currency. */
  maxFarePerTraveller?: number;
  /** Book at least this many days before departure. */
  minAdvanceDays?: number;
  refundableOnly?: boolean;
}

export interface HotelRules {
  maxStars?: number;
  /** Highest sell price per room per night, in minor units. */
  maxNightlyPerRoom?: number;
}

export interface PolicyRules {
  flight?: FlightRules;
  hotel?: HotelRules;
}

export interface PolicyVerdict {
  inPolicy: boolean;
  /** Human-readable reasons, one per broken rule. Empty when in policy. */
  violations: string[];
}

const CABIN_ORDER: Cabin[] = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'];
const CABIN_LABEL: Record<Cabin, string> = {
  ECONOMY: 'Economy',
  PREMIUM_ECONOMY: 'Premium economy',
  BUSINESS: 'Business',
  FIRST: 'First',
};

const fmt = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;

export function evaluateFlight(
  trip: { cabin: Cabin; sellAmount: number; currency: string; travellers: number; departureDate: string; refundable: boolean },
  rules: FlightRules | undefined,
  today: Date = new Date(),
): PolicyVerdict {
  const violations: string[] = [];
  if (!rules) return { inPolicy: true, violations };
  if (rules.maxCabin && CABIN_ORDER.indexOf(trip.cabin) > CABIN_ORDER.indexOf(rules.maxCabin)) {
    violations.push(`${CABIN_LABEL[trip.cabin]} is above the allowed ${CABIN_LABEL[rules.maxCabin]}`);
  }
  const perTraveller = Math.round(trip.sellAmount / Math.max(trip.travellers, 1));
  if (rules.maxFarePerTraveller !== undefined && perTraveller > rules.maxFarePerTraveller) {
    violations.push(
      `Fare ${fmt(perTraveller, trip.currency)} per traveller is above the ${fmt(rules.maxFarePerTraveller, trip.currency)} limit`,
    );
  }
  if (rules.minAdvanceDays !== undefined) {
    const days = Math.floor((Date.parse(`${trip.departureDate}T00:00:00Z`) - startOfDayUtc(today)) / 86_400_000);
    if (days < rules.minAdvanceDays) {
      violations.push(`Booked ${days} day(s) before departure; policy asks for ${rules.minAdvanceDays}`);
    }
  }
  if (rules.refundableOnly && !trip.refundable) violations.push('Policy requires a refundable fare');
  return { inPolicy: violations.length === 0, violations };
}

export function evaluateHotel(
  stay: { stars: number; sellAmount: number; currency: string; nights: number; rooms: number },
  rules: HotelRules | undefined,
): PolicyVerdict {
  const violations: string[] = [];
  if (!rules) return { inPolicy: true, violations };
  if (rules.maxStars !== undefined && stay.stars > rules.maxStars) {
    violations.push(`${stay.stars}-star hotel is above the ${rules.maxStars}-star limit`);
  }
  const nightly = Math.round(stay.sellAmount / Math.max(stay.nights * stay.rooms, 1));
  if (rules.maxNightlyPerRoom !== undefined && nightly > rules.maxNightlyPerRoom) {
    violations.push(`${fmt(nightly, stay.currency)} per room per night is above the ${fmt(rules.maxNightlyPerRoom, stay.currency)} limit`);
  }
  return { inPolicy: violations.length === 0, violations };
}

export function needsApproval(mode: 'always' | 'out_of_policy' | 'never', verdict: PolicyVerdict): boolean {
  return mode === 'always' || (mode === 'out_of_policy' && !verdict.inPolicy);
}

function startOfDayUtc(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
