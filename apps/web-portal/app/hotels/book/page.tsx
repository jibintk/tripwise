'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, ApiError, Booking, BOARD_LABEL, HotelResult, HotelSearchRequest, newIdempotencyKey, RoomOffer } from '@/lib/api';
import { formatMoney, Money } from '@/lib/format';

interface Selected {
  offer: RoomOffer;
  hotel: HotelResult;
  request: HotelSearchRequest;
  nights: number;
}

type Guest = { title: string; firstName: string; lastName: string };

export default function HotelBookPage() {
  const router = useRouter();
  const [sel, setSel] = useState<Selected | null>(null);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [contact, setContact] = useState({ email: '', phone: '' });
  const [requests, setRequests] = useState('');
  const [expected, setExpected] = useState<Money | null>(null);
  const [priceChanged, setPriceChanged] = useState<Money | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());

  useEffect(() => {
    const raw = sessionStorage.getItem('tripwise.hotelOffer');
    if (!raw) {
      router.replace('/hotels');
      return;
    }
    const s = JSON.parse(raw) as Selected;
    setSel(s);
    setExpected(s.offer.pricing.sell);
    setGuests(s.request.rooms.map(() => ({ title: 'MR', firstName: '', lastName: '' })));
  }, [router]);

  const update = (i: number, k: keyof Guest, v: string) => setGuests(guests.map((g, j) => (j === i ? { ...g, [k]: v } : g)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!sel || !expected) return;
    setBusy(true);
    setError(null);
    try {
      const b = await api<Booking>('/hotels/bookings', {
        method: 'POST',
        idempotencyKey: key.current,
        body: JSON.stringify({
          rateId: sel.offer.rateId,
          guests,
          contact,
          specialRequests: requests || undefined,
          expectedSellAmount: expected.amount,
        }),
      });
      sessionStorage.removeItem('tripwise.hotelOffer');
      router.push(`/bookings/${b.reference}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PRICE_CHANGED') {
        setPriceChanged({ amount: err.body.newSellAmount as number, currency: err.body.currency as string });
        key.current = newIdempotencyKey();
      } else if (err instanceof ApiError && err.code === 'OFFER_EXPIRED') {
        setError('This room price has expired. Please search again.');
      } else if (err instanceof ApiError && Array.isArray(err.body.errors)) {
        setError((err.body.errors as { field: string; message: string }[]).map((x) => `${x.field}: ${x.message}`).join('. '));
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!sel || !expected) return <Shell>{null}</Shell>;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Guest details</h1>
          <p className="muted small" style={{ margin: 0 }}>
            One lead guest per room, as on their ID. The price is held for 20 minutes; the room is reserved when you pay.
          </p>
        </div>
      </div>
      <form className="two-col" onSubmit={submit}>
        <div className="stack">
          {guests.map((g, i) => (
            <div className="card" key={i}>
              <h2>
                Room {i + 1} · {sel.request.rooms[i].adults} adult{sel.request.rooms[i].adults > 1 ? 's' : ''}
              </h2>
              <div className="form-grid" style={{ gridTemplateColumns: '90px 1fr 1fr' }}>
                <div className="field">
                  <label>Title</label>
                  <select value={g.title} onChange={(e) => update(i, 'title', e.target.value)}>
                    {['MR', 'MRS', 'MS'].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>First name</label>
                  <input value={g.firstName} onChange={(e) => update(i, 'firstName', e.target.value)} required />
                </div>
                <div className="field">
                  <label>Last name</label>
                  <input value={g.lastName} onChange={(e) => update(i, 'lastName', e.target.value)} required />
                </div>
              </div>
            </div>
          ))}
          <div className="card stack">
            <h2>Contact and requests</h2>
            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div className="field">
                <label>Email</label>
                <input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} required />
              </div>
              <div className="field">
                <label>Phone</label>
                <input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} required />
              </div>
            </div>
            <div className="field">
              <label>Special requests (optional, not guaranteed)</label>
              <input value={requests} maxLength={500} onChange={(e) => setRequests(e.target.value)} placeholder="e.g. late arrival, twin beds" />
            </div>
          </div>
        </div>

        <div className="card stack">
          <h2>{sel.hotel.name}</h2>
          <dl className="kv">
            <dt>Dates</dt>
            <dd>
              {sel.request.checkIn} to {sel.request.checkOut}
            </dd>
            <dt>Nights</dt>
            <dd>{sel.nights}</dd>
            <dt>Room</dt>
            <dd>
              {sel.request.rooms.length} × {sel.offer.roomName}
            </dd>
            <dt>Board</dt>
            <dd>{BOARD_LABEL[sel.offer.board] ?? sel.offer.board}</dd>
            <dt>Cancellation</dt>
            <dd>{sel.offer.refundable ? `Free until ${sel.offer.freeCancellationUntil?.slice(0, 10)}` : 'Non-refundable'}</dd>
            <dt>Your cost</dt>
            <dd>{formatMoney(sel.offer.pricing.agentCost)}</dd>
            <dt className="total">Customer pays</dt>
            <dd className="total">{formatMoney(expected)}</dd>
          </dl>
          {priceChanged && (
            <div className="alert warn">
              The hotel changed the price to <strong>{formatMoney(priceChanged)}</strong>.{' '}
              <button
                type="button"
                className="btn secondary"
                style={{ height: 30, marginTop: 8 }}
                onClick={() => {
                  setExpected(priceChanged);
                  setPriceChanged(null);
                }}
              >
                Accept new price
              </button>
            </div>
          )}
          {error && <div className="alert bad">{error}</div>}
          <button className="btn" disabled={busy || !!priceChanged}>
            {busy ? 'Checking price…' : 'Hold price'}
          </button>
        </div>
      </form>
    </Shell>
  );
}
