'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, SpendReport } from '@/lib/api';
import { formatMoney } from '@/lib/format';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

export default function SpendReportPage() {
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const [report, setReport] = useState<SpendReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((from: string, to: string) => {
    setError(null);
    api<SpendReport>(`/corporate/reports/spend?from=${from}&to=${to}`).then(setReport).catch((e) => setError(e.message));
  }, []);
  useEffect(() => load(monthStart(), today()), [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    load(range.from, range.to);
  };
  const m = (amount: number | string) => formatMoney({ amount: Number(amount), currency: report?.currency ?? 'USD' });
  const t = report?.totals;
  const compliance = t && t.trips > 0 ? Math.round(((t.trips - t.outOfPolicyTrips) / t.trips) * 100) : null;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Travel spend</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Confirmed trips by traveller. Missed savings compare each booking with the lowest option in the same search.
          </p>
        </div>
      </div>
      <form className="card" onSubmit={submit} style={{ marginBottom: 16 }}>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr auto', alignItems: 'end' }}>
          <div className="field">
            <label htmlFor="from">From</label>
            <input id="from" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="to">To</label>
            <input id="to" type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} required />
          </div>
          <button className="btn">Show</button>
        </div>
      </form>
      {error && <div className="alert bad" style={{ marginBottom: 12 }}>{error}</div>}
      {report && t && (
        <>
          <div className="stats" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="muted small">Spend</div>
              <div className="price">{m(t.spend)}</div>
            </div>
            <div className="card">
              <div className="muted small">Trips</div>
              <div className="price">{t.trips}</div>
            </div>
            <div className="card">
              <div className="muted small">In policy</div>
              <div className="price">{compliance == null ? '—' : `${compliance}%`}</div>
            </div>
            <div className="card">
              <div className="muted small">Missed savings</div>
              <div className="price">{m(t.missedSavings)}</div>
            </div>
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Traveller</th>
                  <th>Cost centre</th>
                  <th style={{ textAlign: 'right' }}>Trips</th>
                  <th style={{ textAlign: 'right' }}>Out of policy</th>
                  <th style={{ textAlign: 'right' }}>Spend</th>
                  <th style={{ textAlign: 'right' }}>Missed savings</th>
                </tr>
              </thead>
              <tbody>
                {report.travellers.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No confirmed trips in this period.
                    </td>
                  </tr>
                )}
                {report.travellers.map((r) => (
                  <tr key={r.travellerId}>
                    <td>{r.traveller}</td>
                    <td>{r.costCentre ?? <span className="muted">—</span>}</td>
                    <td style={{ textAlign: 'right' }}>{r.trips}</td>
                    <td style={{ textAlign: 'right' }}>{r.outOfPolicyTrips}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{m(r.spend)}</td>
                    <td style={{ textAlign: 'right' }}>{Number(r.missedSavings) > 0 ? m(r.missedSavings) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Shell>
  );
}
