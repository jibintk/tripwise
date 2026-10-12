'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, ApiError, Booking, InsuranceQuote, InsuranceRegion, newIdempotencyKey, QuoteResult, REGION_LABEL } from '@/lib/api';
import { formatMoney, Money } from '@/lib/format';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);

const EAST_AFRICA = new Set(['NBO', 'MBA', 'ZNZ', 'DAR', 'JRO', 'EBB', 'KGL', 'BJM', 'ADD', 'MRE', 'KIS', 'EDL', 'MYD', 'LAU', 'UKA', 'MGQ', 'JUB']);
const AFRICA = new Set(['JNB', 'CPT', 'DUR', 'LOS', 'ABV', 'ACC', 'CAI', 'CMN', 'RAK', 'TUN', 'ALG', 'DKR', 'LUN', 'HRE', 'VFA', 'WDH', 'GBE', 'MRU', 'SEZ', 'TNR', 'LAD', 'FIH', 'KRT', 'MPM']);

/** Best guess at the area of cover from the airports on a trip; the agent can change it. */
function regionFor(airports: string[]): InsuranceRegion {
  if (airports.every((a) => EAST_AFRICA.has(a))) return 'east_africa';
  if (airports.every((a) => EAST_AFRICA.has(a) || AFRICA.has(a))) return 'africa';
  return 'worldwide';
}

type Traveller = { title: string; firstName: string; lastName: string; dateOfBirth: string; documentNumber: string };
const blank = (dateOfBirth = ''): Traveller => ({ title: 'MR', firstName: '', lastName: '', dateOfBirth, documentNumber: '' });

function InsuranceShop() {
  const router = useRouter();
  const from = useSearchParams().get('from');
  const [form, setForm] = useState({ region: 'east_africa' as InsuranceRegion, startDate: inDays(14), endDate: inDays(20) });
  const [travellers, setTravellers] = useState<Traveller[]>([blank()]);
  const [linked, setLinked] = useState<string | null>(null);
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [chosen, setChosen] = useState<InsuranceQuote | null>(null);
  const [contact, setContact] = useState({ email: '', phone: '' });
  const [expected, setExpected] = useState<Money | null>(null);
  const [priceChanged, setPriceChanged] = useState<Money | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());

  // Coming from a flight booking: cover its dates, its travellers and the area it flies to.
  useEffect(() => {
    if (!from) return;
    api<Booking>(`/bookings/${from}`)
      .then((b) => {
        const slices = b.itinerary ?? [];
        if (!slices.length) return;
        const start = slices[0].segments[0].departureLocal.slice(0, 10);
        const lastSlice = slices[slices.length - 1];
        const end = slices.length > 1 ? lastSlice.segments[lastSlice.segments.length - 1].arrivalLocal.slice(0, 10) : addDays(start, 6);
        const airports = slices.flatMap((s) => s.segments.flatMap((g) => [g.origin, g.destination]));
        setForm({ region: regionFor(airports), startDate: start < inDays(0) ? inDays(0) : start, endDate: end });
        setTravellers(
          b.passengers.map((p) => ({ title: p.title, firstName: p.firstName, lastName: p.lastName, dateOfBirth: p.dateOfBirth ?? '', documentNumber: '' })),
        );
        setContact(b.contact);
        setLinked(b.reference);
      })
      .catch(() => setLinked(null));
  }, [from]);

  const setT = (i: number, k: keyof Traveller, v: string) => setTravellers(travellers.map((t, j) => (j === i ? { ...t, [k]: v } : t)));

  async function getQuotes(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setChosen(null);
    try {
      setResult(
        await api<QuoteResult>('/insurance/quotes', {
          method: 'POST',
          body: JSON.stringify({ ...form, travellers: travellers.map((t) => ({ dateOfBirth: t.dateOfBirth })) }),
        }),
      );
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

  function choose(q: InsuranceQuote) {
    setChosen(q);
    setExpected(q.pricing!.sell);
    setPriceChanged(null);
    key.current = newIdempotencyKey();
    setTimeout(() => document.getElementById('travellers')?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  async function buy(e: FormEvent) {
    e.preventDefault();
    if (!chosen?.quoteId || !expected) return;
    setBusy(true);
    setError(null);
    try {
      const b = await api<Booking>('/insurance/bookings', {
        method: 'POST',
        idempotencyKey: key.current,
        body: JSON.stringify({
          quoteId: chosen.quoteId,
          travellers: travellers.map((t) => ({ ...t, documentNumber: t.documentNumber || undefined })),
          contact,
          expectedSellAmount: expected.amount,
          linkedReference: linked ?? undefined,
        }),
      });
      router.push(`/bookings/${b.reference}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PRICE_CHANGED') {
        setPriceChanged({ amount: err.body.newSellAmount as number, currency: err.body.currency as string });
        key.current = newIdempotencyKey();
      } else if (err instanceof ApiError && err.code === 'OFFER_EXPIRED') {
        setError('This quote has expired. Get new quotes.');
      } else if (err instanceof ApiError && Array.isArray(err.body.errors)) {
        setError((err.body.errors as { field: string; message: string }[]).map((x) => `${x.field}: ${x.message}`).join('. '));
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const available = result?.quotes.filter((q) => q.quoteId) ?? [];
  const unavailable = result?.quotes.filter((q) => !q.quoteId) ?? [];

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Travel insurance</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {linked ? `Cover for booking ${linked}. ` : ''}Compare plans, then name the travellers. The policy is issued when you pay.
          </p>
        </div>
      </div>

      <form className="card stack" onSubmit={getQuotes}>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          <div className="field">
            <label htmlFor="region">Area of cover</label>
            <select id="region" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value as InsuranceRegion })}>
              {(Object.keys(REGION_LABEL) as InsuranceRegion[]).map((r) => (
                <option key={r} value={r}>
                  {REGION_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="start">First day of cover</label>
            <input id="start" type="date" min={inDays(0)} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="end">Last day of cover</label>
            <input id="end" type="date" min={form.startDate} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
          </div>
        </div>
        <div>
          <div className="muted small" style={{ marginBottom: 6, fontWeight: 600, letterSpacing: 0.3 }}>
            TRAVELLERS&apos; DATES OF BIRTH
          </div>
          <div className="dob-list" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {travellers.map((t, i) => (
              <span key={i} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <input
                  aria-label={`Traveller ${i + 1} date of birth`}
                  type="date"
                  max={inDays(0)}
                  value={t.dateOfBirth}
                  onChange={(e) => setT(i, 'dateOfBirth', e.target.value)}
                  required
                  style={{ width: 170 }}
                />
                {travellers.length > 1 && (
                  <button type="button" className="btn secondary" style={{ height: 38, padding: '0 10px' }} aria-label="Remove traveller" onClick={() => setTravellers(travellers.filter((_, j) => j !== i))}>
                    ×
                  </button>
                )}
              </span>
            ))}
            {travellers.length < 9 && (
              <button type="button" className="btn secondary" style={{ height: 38 }} onClick={() => setTravellers([...travellers, blank()])}>
                Add traveller
              </button>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" disabled={busy}>
            {busy && !chosen ? 'Getting quotes…' : 'Get quotes'}
          </button>
        </div>
      </form>

      <div style={{ marginTop: 20 }} className="stack">
        {error && <div className="alert bad">{error}</div>}
        {result && (
          <p className="muted small" style={{ margin: 0 }}>
            {REGION_LABEL[result.region]} · {result.days} days · {result.travellers} traveller{result.travellers > 1 ? 's' : ''} · prices for the whole
            group
          </p>
        )}
        {available.length > 0 && (
          <div className="plans">
            {available.map((q) => (
              <div key={q.plan.code} className={`card plan ${chosen?.plan.code === q.plan.code ? 'chosen' : ''}`}>
                <h2 style={{ marginBottom: 4 }}>{q.plan.name}</h2>
                <p className="muted small" style={{ marginTop: 0 }}>
                  {q.plan.summary}
                </p>
                <dl className="kv small" style={{ flex: 1, alignContent: 'start' }}>
                  {q.plan.coverage.map((c) => (
                    <PlanLine key={c.label} label={c.label} limit={c.limit} />
                  ))}
                </dl>
                <div className="price" style={{ marginTop: 12 }}>
                  {formatMoney(q.pricing!.sell)}
                </div>
                {q.pricing!.yourMarkup.amount > 0 && <div className="muted small">Your cost {formatMoney(q.pricing!.agentCost)}</div>}
                <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => choose(q)}>
                  {chosen?.plan.code === q.plan.code ? 'Selected' : 'Choose'}
                </button>
              </div>
            ))}
          </div>
        )}
        {unavailable.length > 0 && (
          <p className="muted small" style={{ margin: 0 }}>
            Not available for this trip: {unavailable.map((q) => `${q.plan.name} (${q.unavailable})`).join('; ')}.
          </p>
        )}
      </div>

      {chosen && expected && (
        <form id="travellers" className="two-col" style={{ marginTop: 20 }} onSubmit={buy}>
          <div className="stack">
            {travellers.map((t, i) => (
              <div className="card" key={i}>
                <h2>
                  Traveller {i + 1} <span className="muted small">born {t.dateOfBirth}</span>
                </h2>
                <div className="form-grid" style={{ gridTemplateColumns: '90px 1fr 1fr 1fr' }}>
                  <div className="field">
                    <label>Title</label>
                    <select value={t.title} onChange={(e) => setT(i, 'title', e.target.value)}>
                      {['MR', 'MRS', 'MS', 'MSTR', 'MISS'].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>First name</label>
                    <input value={t.firstName} onChange={(e) => setT(i, 'firstName', e.target.value)} required />
                  </div>
                  <div className="field">
                    <label>Last name</label>
                    <input value={t.lastName} onChange={(e) => setT(i, 'lastName', e.target.value)} required />
                  </div>
                  <div className="field">
                    <label>Passport (optional)</label>
                    <input value={t.documentNumber} maxLength={20} onChange={(e) => setT(i, 'documentNumber', e.target.value)} />
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
            <h2>{chosen.plan.name}</h2>
            <dl className="kv">
              <dt>Area</dt>
              <dd>{result && REGION_LABEL[result.region]}</dd>
              <dt>Cover</dt>
              <dd>
                {result?.startDate} to {result?.endDate}
              </dd>
              {linked && (
                <>
                  <dt>For trip</dt>
                  <dd>{linked}</dd>
                </>
              )}
              <dt className="total">Customer pays</dt>
              <dd className="total">{formatMoney(expected)}</dd>
            </dl>
            {priceChanged && (
              <div className="alert warn">
                The premium changed to <strong>{formatMoney(priceChanged)}</strong>.{' '}
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
            <button className="btn" disabled={busy || !!priceChanged}>
              {busy ? 'Holding…' : 'Continue to payment'}
            </button>
          </div>
        </form>
      )}
    </Shell>
  );
}

function PlanLine({ label, limit }: { label: string; limit: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{limit}</dd>
    </>
  );
}

export default function InsurancePage() {
  return (
    <Suspense fallback={null}>
      <InsuranceShop />
    </Suspense>
  );
}
