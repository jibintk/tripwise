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
  status: string;
  supplier: string;
  pnr: string | null;
  holdExpiresAt: string | null;
  ticketNumbers: string[];
  failureReason: string | null;
  itinerary: Slice[];
  fareBrand?: string;
  refundable: boolean;
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

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
