'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { Itinerary } from '@/components/Itinerary';
import { PolicyBadge } from '@/components/PolicyBadge';
import { Shell } from '@/components/Shell';
import { api, ApiError, Offer, SearchResult, session } from '@/lib/api';
import { formatMoney } from '@/lib/format';

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

export default function SearchPage() {
  const router = useRouter();
  const [corporate, setCorporate] = useState(false);
  useEffect(() => setCorporate(session.user()?.tenant.type === 'corporate'), []);
  const [form, setForm] = useState({
    origin: 'NBO',
    destination: 'DXB',
    departureDate: inDays(30),
    returnDate: '',
    adults: 1,
    cabin: 'ECONOMY',
  });
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: k === 'adults' ? Number(e.target.value) : e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<SearchResult>('/flights/searches', {
        method: 'POST',
        body: JSON.stringify({
          origin: form.origin,
          destination: form.destination,
          departureDate: form.departureDate,
          returnDate: form.returnDate || undefined,
          passengers: { ADT: form.adults },
          cabin: form.cabin,
        }),
      });
      setResult(res);
    } catch (err) {
      setResult(null);
      if (err instanceof ApiError && Array.isArray(err.body.errors)) {
        setError((err.body.errors as { field: string; message: string }[]).map((x) => `${x.field}: ${x.message}`).join('. '));
      } else {
        setError(err instanceof Error ? err.message : 'Search failed');
      }
    } finally {
      setBusy(false);
    }
  }

  function choose(offer: Offer) {
    sessionStorage.setItem('tripwise.offer', JSON.stringify({ offer, adults: form.adults, searchId: result?.searchId }));
    router.push('/book');
  }

  const failed = result?.suppliers.filter((s) => s.status === 'error') ?? [];

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Search flights</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {corporate
              ? 'Fares are checked against your travel policy. Out-of-policy fares can still be booked with a reason.'
              : 'Prices include your agency markup. Your cost is shown under each fare.'}
          </p>
        </div>
      </div>

      <form className="card" onSubmit={submit}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="origin">From</label>
            <input id="origin" value={form.origin} onChange={set('origin')} maxLength={3} required />
          </div>
          <div className="field">
            <label htmlFor="destination">To</label>
            <input id="destination" value={form.destination} onChange={set('destination')} maxLength={3} required />
          </div>
          <div className="field">
            <label htmlFor="dep">Depart</label>
            <input id="dep" type="date" value={form.departureDate} onChange={set('departureDate')} required />
          </div>
          <div className="field">
            <label htmlFor="ret">Return (optional)</label>
            <input id="ret" type="date" value={form.returnDate} onChange={set('returnDate')} min={form.departureDate} />
          </div>
          <div className="field">
            <label htmlFor="adults">Adults</label>
            <select id="adults" value={form.adults} onChange={set('adults')}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cabin">Cabin</label>
            <select id="cabin" value={form.cabin} onChange={set('cabin')}>
              <option value="ECONOMY">Economy</option>
              <option value="PREMIUM_ECONOMY">Premium economy</option>
              <option value="BUSINESS">Business</option>
              <option value="FIRST">First</option>
            </select>
          </div>
        </div>
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" disabled={busy}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      <div style={{ marginTop: 20 }} className="stack">
        {error && <div className="alert bad">{error}</div>}
        {failed.length > 0 && (
          <div className="alert warn">
            {failed.map((f) => f.supplier).join(', ')} did not answer in time; results from other suppliers are shown.
          </div>
        )}
        {result && result.offers.length === 0 && <div className="alert warn">No flights found for this search.</div>}
        {result && result.offers.length > 0 && (
          <p className="muted small" style={{ margin: 0 }}>
            {result.offers.length} fares, cheapest first{result.fromCache ? ' · from recent search' : ''}
            {result.policy ? ` · checked against the ${result.policy.grade} travel policy` : ''}
          </p>
        )}
        {result?.offers.map((o) => (
          <div className="card offer" key={o.offerId}>
            <div>
              <Itinerary slices={o.slices} />
              <div className="tags">
                {o.fareBrand && <span className="tag">{o.fareBrand}</span>}
                <span className="tag">
                  {o.baggage[0]?.checkedPieces ? `${o.baggage[0].checkedPieces} checked bag` : 'Cabin bag only'}
                </span>
                {o.refundable && <span className="tag good">Refundable</span>}
                {o.lowestFare && <span className="tag brand">Lowest fare</span>}
                <PolicyBadge policy={o.policy} />
              </div>
            </div>
            <div className="price-col">
              <div className="price">{formatMoney(o.pricing.sell)}</div>
              {!o.policy && <div className="muted small">Your cost {formatMoney(o.pricing.agentCost)}</div>}
              <button className="btn" style={{ marginTop: 10 }} onClick={() => choose(o)}>
                Select
              </button>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
