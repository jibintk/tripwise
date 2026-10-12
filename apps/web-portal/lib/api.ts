import { Money } from './format';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const TOKEN_KEY = 'tripwise.token';
const USER_KEY = 'tripwise.user';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  tenant: { id: string; name: string; type: string; currency: string };
}

/** An API error in problem+json form; `code` is stable and safe to branch on. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const session = {
  token: () => storage()?.getItem(TOKEN_KEY) ?? null,
  user: (): SessionUser | null => {
    const raw = storage()?.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  },
  save(token: string, user: SessionUser) {
    storage()?.setItem(TOKEN_KEY, token);
    storage()?.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    storage()?.removeItem(TOKEN_KEY);
    storage()?.removeItem(USER_KEY);
  },
};

export async function api<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = session.token();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } });
  if (res.status === 401 && token) {
    session.clear();
    if (typeof window !== 'undefined') window.location.href = '/login';
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, body.code ?? 'HTTP_ERROR', body.detail ?? res.statusText, body);
  }
  return body as T;
}

// ---- response shapes (mirror the API) ----

export interface Segment {
  marketingCarrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureLocal: string;
  arrivalLocal: string;
  durationMin: number;
}

export interface Slice {
  segments: Segment[];
  durationMin: number;
}

export interface Pricing {
  agentCost: Money;
  sell: Money;
  yourMarkup: Money;
  net?: Money;
}

export interface PolicyVerdict {
  inPolicy: boolean;
  violations: string[];
}

export interface Offer {
  offerId: string;
  cabin?: string;
  lowestFare?: boolean;
  policy?: PolicyVerdict;
  supplier: string;
  slices: Slice[];
  fareBrand?: string;
  refundable: boolean;
  baggage: { passengerType: string; checkedPieces: number; cabinKg: number }[];
  validUntil: string;
  pricing: Pricing;
}

export interface SearchResult {
  searchId: string;
  policy?: { grade: string; approvalMode: string };
  fromCache: boolean;
  suppliers: { supplier: string; status: string; offers: number; error?: string }[];
  offers: Offer[];
}

export interface Passenger {
  type: 'ADT' | 'CHD' | 'INF';
  title: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
}

export interface Booking {
  reference: string;
  product: 'flight' | 'hotel' | 'insurance';
  status: string;
  supplier?: string;
  pnr: string | null;
  holdExpiresAt: string | null;
  ticketNumbers: string[];
  failureReason: string | null;
  /** flights */
  itinerary?: Slice[];
  fareBrand?: string;
  refundable?: boolean;
  /** hotels */
  hotel?: { id: string; name: string; city: string; address: string; stars: number };
  stay?: { checkIn: string; checkOut: string; nights: number; rooms: { adults: number; childAges?: number[] }[] };
  room?: { name: string; board: string; refundable: boolean; freeCancellationUntil?: string };
  hotelConfirmation?: string | null;
  /** insurance */
  plan?: { code: string; name: string; summary: string; coverage: { label: string; limit: string }[] };
  cover?: { region: InsuranceRegion; regionLabel: string; startDate: string; endDate: string; days: number };
  policyNumber?: string | null;
  linkedReference?: string | null;
  cancellation?: { penalty: Money; refunded: Money } | null;
  specialRequests?: string;
  channel?: string;
  policy?: {
    grade: string;
    inPolicy: boolean;
    violations: string[];
    reasonForException?: string;
    missedSaving: number;
    lowestSell?: number;
  } | null;
  passengers: Passenger[];
  contact: { email: string; phone: string };
  pricing: Pricing;
  createdAt: string;
  events?: { type: string; at: string; data: Record<string, unknown> }[];
}

export interface Wallet {
  balance: number;
  creditLimit: number;
  available: number;
  currency: string;
}

/** Downloads an authenticated file (for example an e-ticket PDF) and hands it to the browser. */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${session.token()}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.code ?? 'HTTP_ERROR', body.detail ?? res.statusText, body);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface Tenant {
  id: string;
  type: string;
  parentId: string | null;
  code: string;
  path: string;
  name: string;
  country: string;
  currency: string;
  status: string;
}

export interface WalletRow {
  tenantId: string;
  name: string;
  type: string;
  path: string;
  status: string;
  currency: string;
  balance: number;
  creditLimit: number;
  available: number;
}

export interface PricingRule {
  id: string;
  name: string;
  product: string | null;
  channel: string | null;
  supplier: string | null;
  origin: string | null;
  destination: string | null;
  cabin: string | null;
  valueType: 'percent' | 'fixed';
  value: number;
  currency: string | null;
  priority: number;
}

export interface HotelResult {
  id: string;
  name: string;
  city: string;
  stars: number;
  address: string;
  amenities: string[];
  suppliers: number;
  rooms: number;
  from: { agentCost: Money; sell: Money };
  cheapestBoard: string;
  freeCancellation: boolean;
  policy?: PolicyVerdict;
}

export interface HotelSearchRequest {
  city: string;
  checkIn: string;
  checkOut: string;
  rooms: { adults: number; childAges?: number[] }[];
}

export interface RoomOffer {
  rateId: string;
  policy?: PolicyVerdict;
  roomName: string;
  board: string;
  refundable: boolean;
  freeCancellationUntil?: string;
  pricing: Pricing;
}

export const BOARD_LABEL: Record<string, string> = {
  RO: 'Room only',
  BB: 'Breakfast included',
  HB: 'Half board',
  FB: 'Full board',
  AI: 'All inclusive',
};

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---- corporate travel ----

export interface PolicyRecord {
  grade: string;
  approvalMode: string;
  inPolicy: boolean;
  violations: string[];
  reasonForException?: string;
  lowestSell?: number;
  missedSaving: number;
}

export interface ApprovalItem {
  id: string;
  reference: string;
  requestedAt?: string;
  traveller: string;
  product: 'flight' | 'hotel';
  policy: PolicyRecord | null;
  amount: number;
  currency: string;
  trip: string;
  status?: string;
  bookingStatus?: string;
}

export interface DecisionResult {
  id: string;
  decision: 'approve' | 'reject';
  reference: string;
  bookingStatus: string;
  failureReason: string | null;
}

export type ApprovalMode = 'always' | 'out_of_policy' | 'never';

export interface PolicyRules {
  flight?: { maxCabin?: string; maxFarePerTraveller?: number; minAdvanceDays?: number; refundableOnly?: boolean };
  hotel?: { maxStars?: number; maxNightlyPerRoom?: number };
}

export interface TravelPolicy {
  id: string;
  grade: string;
  rules: PolicyRules;
  approvalMode: ApprovalMode;
}

export interface Employee {
  id: string;
  name: string;
  email: string;
  roles: string[];
  grade: string | null;
  costCentre: string | null;
  approverId: string | null;
  approverName: string | null;
}

export interface SpendReport {
  from: string;
  to: string;
  currency: string;
  totals: { trips: number; spend: number; outOfPolicyTrips: number; missedSavings: number };
  travellers: {
    travellerId: string;
    traveller: string;
    costCentre: string | null;
    trips: number;
    spend: string | number;
    outOfPolicyTrips: number;
    missedSavings: string | number;
  }[];
}

export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  always: 'Every trip needs approval',
  out_of_policy: 'Only out-of-policy trips need approval',
  never: 'No approval (out-of-policy trips are reported)',
};

// ---- travel insurance ----

export type InsuranceRegion = 'east_africa' | 'africa' | 'worldwide';

export const REGION_LABEL: Record<InsuranceRegion, string> = {
  east_africa: 'East Africa',
  africa: 'Africa',
  worldwide: 'Worldwide',
};

export interface InsuranceQuote {
  quoteId: string | null;
  plan: { code: string; name: string; summary: string; coverage: { label: string; limit: string }[] };
  unavailable?: string;
  pricing?: { agentCost: Money; sell: Money; yourMarkup: Money };
}

export interface QuoteResult {
  region: InsuranceRegion;
  startDate: string;
  endDate: string;
  days: number;
  travellers: number;
  quotes: InsuranceQuote[];
}

// ---- own flight inventory ----

export interface Allotment {
  id: string;
  kind: 'blocked' | 'charter' | 'a2a';
  carrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureLocal: string;
  arrivalLocal: string;
  durationMin: number;
  cabin: string;
  fareBrand: string | null;
  checkedPieces: number;
  refundable: boolean;
  baseAmount: number;
  taxAmount: number;
  currency: string;
  seatsTotal: number;
  seatsHeld: number;
  seatsSold: number;
  seatsAvailable: number;
  releaseAt: string;
  status: 'active' | 'closed' | 'released';
  notes: string | null;
}

export interface ManifestPassenger {
  pnr: string;
  status: 'held' | 'ticketed';
  type: string;
  title: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  documentNumber: string | null;
  ticketNumber: string | null;
}
