'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Itinerary } from '@/components/Itinerary';
import { Shell } from '@/components/Shell';
import { api, ApiError, Booking, newIdempotencyKey, Offer, Passenger } from '@/lib/api';
import { formatMoney, Money } from '@/lib/format';

const emptyPassenger = (): Passenger => ({ type: 'ADT', title: 'MR', firstName: '', lastName: '', dateOfBirth: '' });

export default function BookPage() {
  const router = useRouter();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [contact, setContact] = useState({ email: '', phone: '' });
  const [expected, setExpected] = useState<Money | null>(null);
  const [priceChanged, setPriceChanged] = useState<Money | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per booking attempt, so a double-click or a retry never creates two holds.
  const idempotencyKey = useRef(newIdempotencyKey());

  useEffect(() => {
    const raw = sessionStorage.getItem('tripwise.offer');
    if (!raw) {
      router.replace('/search');
      return;
    }
    const { offer: o, adults } = JSON.parse(raw) as { offer: Offer; adults: number };
    setOffer(o);
    setExpected(o.pricing.sell);
    setPassengers(Array.from({ length: adults }, emptyPassenger));
  }, [router]);

  const update = (i: number, k: keyof Passenger, v: string) =>
    setPassengers(passengers.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!offer || !expected) return;
    setBusy(true);
    setError(null);
    try {
      const booking = await api<Booking>('/bookings', {
        method: 'POST',
        idempotencyKey: idempotencyKey.current,
        body: JSON.stringify({ offerId: offer.offerId, passengers, contact, expectedSellAmount: expected.amount }),
      });
      sessionStorage.removeItem('tripwise.offer');
      router.push(`/bookings/${booking.reference}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PRICE_CHANGED') {
        const newPrice = { amount: err.body.newSellAmount as number, currency: err.body.currency as string };
        setPriceChanged(newPrice);
        idempotencyKey.current = newIdempotencyKey();
      } else if (err instanceof ApiError && err.code === 'OFFER_EXPIRED') {
        setError('This fare has expired. Please search again.');
      } else if (err instanceof ApiError && Array.isArray(err.body.errors)) {
        setError((err.body.errors as { field: string; message: string }[]).map((x) => `${x.field}: ${x.message}`).join('. '));
      } else {
        setError(err instanceof Error ? err.message : 'Booking failed');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!offer || !expected) return <Shell>{null}</Shell>;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Traveller details</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Enter names exactly as on the passport. The fare is held until you pay.
          </p>
        </div>
      </div>
      <form className="two-col" onSubmit={submit}>
        <div className="stack">
          {passengers.map((p, i) => (
            <div className="card" key={i}>
              <h2>Adult {i + 1}</h2>
              <div className="form-grid" style={{ gridTemplateColumns: '90px 1fr 1fr 160px' }}>
                <div className="field">
                  <label>Title</label>
                  <select value={p.title} onChange={(e) => update(i, 'title', e.target.value)}>
                    {['MR', 'MRS', 'MS'].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>First name</label>
                  <input value={p.firstName} onChange={(e) => update(i, 'firstName', e.target.value)} required />
                </div>
                <div className="field">
                  <label>Last name</label>
                  <input value={p.lastName} onChange={(e) => update(i, 'lastName', e.target.value)} required />
                </div>
                <div className="field">
                  <label>Date of birth</label>
                  <input type="date" value={p.dateOfBirth} onChange={(e) => update(i, 'dateOfBirth', e.target.value)} required />
                </div>
              </div>
            </div>
          ))}
          <div className="card">
            <h2>Contact</h2>
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
          </div>
        </div>

        <div className="card stack">
          <h2>Your trip</h2>
          <Itinerary slices={offer.slices} />
          <dl className="kv">
            <dt>Fare</dt>
            <dd>{offer.fareBrand ?? 'Standard'}</dd>
            <dt>Your cost</dt>
            <dd>{formatMoney(offer.pricing.agentCost)}</dd>
            <dt>Your markup</dt>
            <dd>{formatMoney(offer.pricing.yourMarkup)}</dd>
            <dt className="total">Customer pays</dt>
            <dd className="total">{formatMoney(expected)}</dd>
          </dl>
          {priceChanged && (
            <div className="alert warn">
              The airline changed the price to <strong>{formatMoney(priceChanged)}</strong>.{' '}
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
            {busy ? 'Holding seats…' : 'Hold booking'}
          </button>
        </div>
      </form>
    </Shell>
  );
}
