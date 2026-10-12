'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, ApiError, HotelResult, HotelSearchRequest } from '@/lib/api';
import { formatMoney } from '@/lib/format';

const CITIES: [string, string][] = [
  ['NBO', 'Nairobi'],
  ['MBA', 'Mombasa / Diani'],
  ['ZNZ', 'Zanzibar'],
  ['DXB', 'Dubai'],
  ['CPT', 'Cape Town'],
  ['JNB', 'Johannesburg'],
];

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export default function HotelSearchPage() {
  const [form, setForm] = useState({ city: 'ZNZ', checkIn: inDays(30), checkOut: inDays(33), rooms: 1, adults: 2 });
  const [result, setResult] = useState<{ searchId: string; nights: number; hotels: HotelResult[]; suppliers: { supplier: string; status: string }[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const request: HotelSearchRequest = {
      city: form.city,
      checkIn: form.checkIn,
      checkOut: form.checkOut,
      rooms: Array.from({ length: form.rooms }, () => ({ adults: form.adults })),
    };
    try {
      setResult(await api('/hotels/searches', { method: 'POST', body: JSON.stringify(request) }));
      sessionStorage.setItem('tripwise.hotelSearch', JSON.stringify(request));
    } catch (err) {
      setResult(null);
      setError(
        err instanceof ApiError && Array.isArray(err.body.errors)
          ? (err.body.errors as { message: string }[]).map((x) => x.message).join('. ')
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  const failed = result?.suppliers.filter((s) => s.status === 'error') ?? [];

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Search hotels</h1>
          <p className="muted small" style={{ margin: 0 }}>
            One result per hotel, with the best rate from all suppliers. Prices are for the whole stay.
          </p>
        </div>
      </div>
      <form className="card" onSubmit={submit}>
        <div className="form-grid" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr' }}>
          <div className="field">
            <label htmlFor="city">Destination</label>
            <select id="city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}>
              {CITIES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="in">Check-in</label>
            <input id="in" type="date" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="out">Check-out</label>
            <input
              id="out"
              type="date"
              value={form.checkOut}
              min={form.checkIn}
              onChange={(e) => setForm({ ...form, checkOut: e.target.value })}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="rooms">Rooms</label>
            <select id="rooms" value={form.rooms} onChange={(e) => setForm({ ...form, rooms: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="adults">Adults per room</label>
            <select id="adults" value={form.adults} onChange={(e) => setForm({ ...form, adults: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n}>{n}</option>
              ))}
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
        {failed.length > 0 && <div className="alert warn">Some suppliers did not answer; results from the others are shown.</div>}
        {result && (
          <p className="muted small" style={{ margin: 0 }}>
            {result.hotels.length} hotels · {result.nights} night{result.nights === 1 ? '' : 's'} · cheapest first
          </p>
        )}
        {result?.hotels.map((h) => (
          <div className="card offer" key={h.id}>
            <div>
              <h2 style={{ marginBottom: 2 }}>{h.name}</h2>
              <div className="muted small">
                {'★'.repeat(h.stars)} · {h.address}
              </div>
              <div className="tags">
                {h.amenities.slice(0, 4).map((a) => (
                  <span className="tag" key={a}>
                    {a}
                  </span>
                ))}
                {h.freeCancellation && <span className="tag good">Free cancellation available</span>}
              </div>
            </div>
            <div className="price-col">
              <div className="muted small">from</div>
              <div className="price">{formatMoney(h.from.sell)}</div>
              <div className="muted small">Your cost {formatMoney(h.from.agentCost)}</div>
              <Link className="btn" style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center' }} href={`/hotels/${result.searchId}/${h.id}`}>
                View rooms
              </Link>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
