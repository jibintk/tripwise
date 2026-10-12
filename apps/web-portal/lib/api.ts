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

export interface Offer {
  offerId: string;
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
  product: 'flight' | 'hotel';
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
  cancellation?: { penalty: Money; refunded: Money } | null;
  specialRequests?: string;
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
}

export interface HotelSearchRequest {
  city: string;
  checkIn: string;
  checkOut: string;
  rooms: { adults: number; childAges?: number[] }[];
}

export interface RoomOffer {
  rateId: string;
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
