'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { Allotment, api, ApiError, download, ManifestPassenger, session } from '@/lib/api';
import { formatMoney } from '@/lib/format';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KIND_LABEL: Record<Allotment['kind'], string> = { blocked: 'Blocked seats', charter: 'Charter', a2a: 'A2A contract' };
const toMinor = (v: string) => Math.round(Number(v) * 100);

/** Every date from `from` to `to` (inclusive) that falls on one of the chosen weekdays. */
function datesBetween(from: string, to: string, weekdays: number[]): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to) && out.length < 370; t += 86_400_000) {
    if (weekdays.includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const NEW_SERIES = {
  kind: 'blocked' as Allotment['kind'],
  carrier: '',
  flightNumber: '',
  origin: 'NBO',
  destination: '',
  from: inDays(7),
  to: inDays(60),
  weekdays: [1, 3, 5],
  departureTime: '08:00',
  arrivalTime: '09:30',
  arrivalDayOffset: 0,
  durationMin: '90',
  cabin: 'ECONOMY',
  fareBrand: '',
  checkedPieces: '1',
  baseAmount: '',
  taxAmount: '',
  seats: '20',
  releaseDaysBefore: '7',
  refundable: false,
};

export default function InventoryPage() {
  const currency = session.user()?.tenant.currency ?? 'USD';
  const [filter, setFilter] = useState({ from: inDays(0), to: inDays(30), origin: '', destination: '' });
  const [rows, setRows] = useState<Allotment[] | null>(null);
  const [series, setSeries] = useState<typeof NEW_SERIES | null>(null);
  const [edit, setEdit] = useState<{ a: Allotment; base: string; tax: string; seats: string } | null>(null);
  const [manifest, setManifest] = useState<{ a: Allotment; passengers: ManifestPassenger[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // Airport filters apply once a full 3-letter code is typed.
    const q = new URLSearchParams(
      Object.entries(filter).filter(([k, v]) => v && (!['origin', 'destination'].includes(k) || v.length === 3)) as [string, string][],
    );
    api<Allotment[]>(`/inventory/allotments?${q}`).then(setRows).catch((e) => setError(e.message));
  }, [filter]);
  useEffect(load, [load]);

  const fail = (err: unknown) =>
    setError(
      err instanceof ApiError && Array.isArray(err.body.errors)
        ? (err.body.errors as { field: string; message: string }[]).map((x) => `${x.field}: ${x.message}`).join('. ')
        : (err as Error).message,
    );

  async function createSeries(e: FormEvent) {
    e.preventDefault();
    if (!series) return;
    setError(null);
    const dates = datesBetween(series.from, series.to, series.weekdays);
    if (!dates.length) return setError('No dates match the chosen days of the week.');
    try {
      const r = await api<{ created: Allotment[]; skipped: string[] }>('/inventory/allotments', {
        method: 'POST',
        body: JSON.stringify({
          kind: series.kind,
          carrier: series.carrier,
          flightNumber: series.flightNumber,
          origin: series.origin,
          destination: series.destination,
          dates,
          departureTime: series.departureTime,
          arrivalTime: series.arrivalTime,
          arrivalDayOffset: series.arrivalDayOffset,
          durationMin: Number(series.durationMin),
          cabin: series.cabin,
          fareBrand: series.fareBrand || undefined,
          checkedPieces: Number(series.checkedPieces),
          refundable: series.refundable,
          baseAmount: toMinor(series.baseAmount),
          taxAmount: toMinor(series.taxAmount || '0'),
          currency,
          seats: Number(series.seats),
          releaseDaysBefore: Number(series.releaseDaysBefore),
        }),
      });
      setNotice(`Loaded ${r.created.length} flight${r.created.length === 1 ? '' : 's'}${r.skipped.length ? `; ${r.skipped.length} date(s) already existed and were skipped` : ''}.`);
      setSeries(null);
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function patch(a: Allotment, body: Record<string, unknown>, message: string) {
    setError(null);
    try {
      await api(`/inventory/allotments/${a.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setNotice(message);
      setEdit(null);
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function openManifest(a: Allotment) {
    setError(null);
    try {
      const m = await api<{ passengers: ManifestPassenger[] }>(`/inventory/allotments/${a.id}/manifest`);
      setManifest({ a, passengers: m.passengers });
      setEdit(null);
    } catch (err) {
      fail(err);
    }
  }

  const s = series;
  const setS = <K extends keyof typeof NEW_SERIES>(k: K, v: (typeof NEW_SERIES)[K]) => s && setSeries({ ...s, [k]: v });
  const m = (amount: number, cur: string) => formatMoney({ amount, currency: cur });
  const flight = (a: Allotment) => `${a.carrier}${a.flightNumber}`;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Own inventory</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Seats we have bought or contracted. They appear in flight search for every agency, with the normal markups.
          </p>
        </div>
        <button className="btn" onClick={() => setSeries({ ...NEW_SERIES })}>
          Load flights
        </button>
      </div>
      {error && <div className="alert bad" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="alert good" style={{ marginBottom: 12 }}>{notice}</div>}

      {s && (
        <form className="card stack" style={{ marginBottom: 16 }} onSubmit={createSeries}>
          <h2>Load a series</h2>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            <div className="field">
              <label>Type</label>
              <select value={s.kind} onChange={(e) => setS('kind', e.target.value as Allotment['kind'])}>
                {Object.entries(KIND_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Airline</label>
              <input value={s.carrier} maxLength={2} placeholder="KQ" onChange={(e) => setS('carrier', e.target.value.toUpperCase())} required />
            </div>
            <div className="field">
              <label>Flight number</label>
              <input value={s.flightNumber} maxLength={4} placeholder="480" onChange={(e) => setS('flightNumber', e.target.value)} required />
            </div>
            <div className="field">
              <label>From</label>
              <input value={s.origin} maxLength={3} onChange={(e) => setS('origin', e.target.value.toUpperCase())} required />
            </div>
            <div className="field">
              <label>To</label>
              <input value={s.destination} maxLength={3} onChange={(e) => setS('destination', e.target.value.toUpperCase())} required />
            </div>
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 2fr' }}>
            <div className="field">
              <label>First date</label>
              <input type="date" value={s.from} onChange={(e) => setS('from', e.target.value)} required />
            </div>
            <div className="field">
              <label>Last date</label>
              <input type="date" value={s.to} min={s.from} onChange={(e) => setS('to', e.target.value)} required />
            </div>
            <div className="field">
              <label>Operates on</label>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {WEEKDAYS.map((d, i) => {
                  const on = s.weekdays.includes(i);
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`btn ${on ? '' : 'secondary'}`}
                      style={{ height: 38, padding: '0 10px' }}
                      aria-pressed={on}
                      onClick={() => setS('weekdays', on ? s.weekdays.filter((x) => x !== i) : [...s.weekdays, i])}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            <div className="field">
              <label>Departs (local)</label>
              <input type="time" value={s.departureTime} onChange={(e) => setS('departureTime', e.target.value)} required />
            </div>
            <div className="field">
              <label>Arrives (local)</label>
              <input type="time" value={s.arrivalTime} onChange={(e) => setS('arrivalTime', e.target.value)} required />
            </div>
            <div className="field">
              <label>Arrival day</label>
              <select value={s.arrivalDayOffset} onChange={(e) => setS('arrivalDayOffset', Number(e.target.value))}>
                <option value={0}>Same day</option>
                <option value={1}>Next day</option>
              </select>
            </div>
            <div className="field">
              <label>Flying time (min)</label>
              <input type="number" min={10} value={s.durationMin} onChange={(e) => setS('durationMin', e.target.value)} required />
            </div>
            <div className="field">
              <label>Cabin</label>
              <select value={s.cabin} onChange={(e) => setS('cabin', e.target.value)}>
                <option value="ECONOMY">Economy</option>
                <option value="PREMIUM_ECONOMY">Premium economy</option>
                <option value="BUSINESS">Business</option>
              </select>
            </div>
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}>
            <div className="field">
              <label>Net fare ({currency})</label>
              <input type="number" min={0} step="0.01" value={s.baseAmount} onChange={(e) => setS('baseAmount', e.target.value)} required />
            </div>
            <div className="field">
              <label>Taxes ({currency})</label>
              <input type="number" min={0} step="0.01" value={s.taxAmount} onChange={(e) => setS('taxAmount', e.target.value)} />
            </div>
            <div className="field">
              <label>Seats per flight</label>
              <input type="number" min={1} max={500} value={s.seats} onChange={(e) => setS('seats', e.target.value)} required />
            </div>
            <div className="field">
              <label>Release (days before)</label>
              <input type="number" min={0} max={90} value={s.releaseDaysBefore} onChange={(e) => setS('releaseDaysBefore', e.target.value)} required />
            </div>
            <div className="field">
              <label>Checked bags</label>
              <select value={s.checkedPieces} onChange={(e) => setS('checkedPieces', e.target.value)}>
                {[0, 1, 2].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Fare rules</label>
              <select value={s.refundable ? 'r' : 'n'} onChange={(e) => setS('refundable', e.target.value === 'r')}>
                <option value="n">Non-refundable</option>
                <option value="r">Refundable</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
            <span className="muted small" style={{ marginRight: 'auto' }}>
              {datesBetween(s.from, s.to, s.weekdays).length} flights will be loaded
            </span>
            <button type="button" className="btn secondary" onClick={() => setSeries(null)}>
              Cancel
            </button>
            <button className="btn">Load flights</button>
          </div>
        </form>
      )}

      <form
        className="card"
        style={{ marginBottom: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr', alignItems: 'end' }}>
          <div className="field">
            <label htmlFor="ffrom">Departing from</label>
            <input id="ffrom" type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="fto">to</label>
            <input id="fto" type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="fo">Origin</label>
            <input id="fo" value={filter.origin} maxLength={3} placeholder="Any" onChange={(e) => setFilter({ ...filter, origin: e.target.value.toUpperCase() })} />
          </div>
          <div className="field">
            <label htmlFor="fd">Destination</label>
            <input id="fd" value={filter.destination} maxLength={3} placeholder="Any" onChange={(e) => setFilter({ ...filter, destination: e.target.value.toUpperCase() })} />
          </div>
        </div>
      </form>

      {edit && (
        <div className="card stack" style={{ marginBottom: 16 }}>
          <h2>
            {flight(edit.a)} · {edit.a.departureLocal.replace('T', ' ')}
          </h2>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr auto auto', alignItems: 'end' }}>
            <div className="field">
              <label>Net fare ({edit.a.currency})</label>
              <input type="number" min={0} step="0.01" value={edit.base} onChange={(e) => setEdit({ ...edit, base: e.target.value })} />
            </div>
            <div className="field">
              <label>Taxes ({edit.a.currency})</label>
              <input type="number" min={0} step="0.01" value={edit.tax} onChange={(e) => setEdit({ ...edit, tax: e.target.value })} />
            </div>
            <div className="field">
              <label>Seats (held + sold: {edit.a.seatsHeld + edit.a.seatsSold})</label>
              <input type="number" min={1} value={edit.seats} onChange={(e) => setEdit({ ...edit, seats: e.target.value })} />
            </div>
            <button className="btn secondary" onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button
              className="btn"
              onClick={() =>
                patch(
                  edit.a,
                  { baseAmount: toMinor(edit.base), taxAmount: toMinor(edit.tax), seatsTotal: Number(edit.seats) },
                  `Updated ${flight(edit.a)} on ${edit.a.departureLocal.slice(0, 10)}. New searches use the new fare.`,
                )
              }
            >
              Save
            </button>
          </div>
        </div>
      )}

      {manifest && (
        <div className="card stack" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h2 style={{ margin: 0 }}>
              Manifest {flight(manifest.a)} · {manifest.a.origin}–{manifest.a.destination} · {manifest.a.departureLocal.replace('T', ' ')}
            </h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn secondary"
                onClick={() =>
                  download(`/inventory/allotments/${manifest.a.id}/manifest.csv`, `manifest-${flight(manifest.a)}-${manifest.a.departureLocal.slice(0, 10)}.csv`).catch(
                    (e) => setError(e.message),
                  )
                }
              >
                Download CSV
              </button>
              <button className="btn secondary" onClick={() => setManifest(null)}>
                Close
              </button>
            </div>
          </div>
          {manifest.passengers.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No passengers yet.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Date of birth</th>
                  <th>PNR</th>
                  <th>Ticket</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {manifest.passengers.map((p, i) => (
                  <tr key={i}>
                    <td>
                      {p.lastName}/{p.firstName} {p.title}
                    </td>
                    <td>{p.dateOfBirth}</td>
                    <td>{p.pnr}</td>
                    <td>{p.ticketNumber ?? '–'}</td>
                    <td>{p.status === 'ticketed' ? 'Ticketed' : 'On hold'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Flight</th>
              <th>Departure</th>
              <th style={{ textAlign: 'right' }}>Net fare</th>
              <th>Seats sold</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No flights in this period.
                </td>
              </tr>
            )}
            {rows?.map((a) => {
              const used = a.seatsSold + a.seatsHeld;
              return (
                <tr key={a.id}>
                  <td>
                    <strong>{flight(a)}</strong> {a.origin}–{a.destination}
                    <div className="muted small">
                      {KIND_LABEL[a.kind]} · {a.cabin.toLowerCase().replace('_', ' ')}
                    </div>
                  </td>
                  <td>
                    {a.departureLocal.replace('T', ' ')}
                    <div className="muted small">Release {new Date(a.releaseAt).toLocaleDateString()}</div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {m(a.baseAmount + a.taxAmount, a.currency)}
                    <div className="muted small">incl. {m(a.taxAmount, a.currency)} tax</div>
                  </td>
                  <td style={{ minWidth: 150 }}>
                    <div className="load" title={`${a.seatsSold} sold, ${a.seatsHeld} on hold, ${a.seatsAvailable} free`}>
                      <span className="sold" style={{ width: `${(a.seatsSold / a.seatsTotal) * 100}%` }} />
                      <span className="held" style={{ width: `${(a.seatsHeld / a.seatsTotal) * 100}%` }} />
                    </div>
                    <div className="small">
                      {used}/{a.seatsTotal}
                      {a.seatsHeld ? <span className="muted"> ({a.seatsHeld} on hold)</span> : null}
                    </div>
                  </td>
                  <td>
                    <span className={`tag ${a.status === 'active' ? 'good' : a.status === 'released' ? '' : 'warn'}`}>
                      {a.status === 'active' ? (a.seatsAvailable ? 'On sale' : 'Full') : a.status === 'released' ? 'Released' : 'Closed'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn secondary" style={{ height: 30 }} onClick={() => openManifest(a)}>
                      Manifest
                    </button>{' '}
                    <button
                      className="btn secondary"
                      style={{ height: 30 }}
                      onClick={() => {
                        setManifest(null);
                        setEdit({ a, base: String(a.baseAmount / 100), tax: String(a.taxAmount / 100), seats: String(a.seatsTotal) });
                      }}
                    >
                      Edit
                    </button>{' '}
                    {a.status !== 'released' && (
                      <button
                        className={`btn ${a.status === 'active' ? 'danger' : 'secondary'}`}
                        style={{ height: 30 }}
                        onClick={() =>
                          patch(
                            a,
                            { status: a.status === 'active' ? 'closed' : 'active' },
                            `${flight(a)} on ${a.departureLocal.slice(0, 10)} is ${a.status === 'active' ? 'closed for sale' : 'back on sale'}.`,
                          )
                        }
                      >
                        {a.status === 'active' ? 'Close' : 'Reopen'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
