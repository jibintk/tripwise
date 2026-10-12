'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, APPROVAL_MODE_LABEL, ApprovalMode, PolicyRules, session, TravelPolicy } from '@/lib/api';

const CABINS: [string, string][] = [
  ['', 'Any cabin'],
  ['ECONOMY', 'Economy'],
  ['PREMIUM_ECONOMY', 'Premium economy'],
  ['BUSINESS', 'Business'],
  ['FIRST', 'First'],
];

/** Form state keeps money in major units as text so inputs can be blank (= no limit). */
interface Draft {
  grade: string;
  approvalMode: ApprovalMode;
  maxCabin: string;
  maxFare: string;
  minAdvanceDays: string;
  refundableOnly: boolean;
  maxStars: string;
  maxNightly: string;
}

const toDraft = (p: TravelPolicy): Draft => ({
  grade: p.grade,
  approvalMode: p.approvalMode,
  maxCabin: p.rules.flight?.maxCabin ?? '',
  maxFare: p.rules.flight?.maxFarePerTraveller != null ? String(p.rules.flight.maxFarePerTraveller / 100) : '',
  minAdvanceDays: p.rules.flight?.minAdvanceDays != null ? String(p.rules.flight.minAdvanceDays) : '',
  refundableOnly: !!p.rules.flight?.refundableOnly,
  maxStars: p.rules.hotel?.maxStars != null ? String(p.rules.hotel.maxStars) : '',
  maxNightly: p.rules.hotel?.maxNightlyPerRoom != null ? String(p.rules.hotel.maxNightlyPerRoom / 100) : '',
});

const EMPTY: Draft = { grade: '', approvalMode: 'out_of_policy', maxCabin: 'ECONOMY', maxFare: '', minAdvanceDays: '', refundableOnly: false, maxStars: '', maxNightly: '' };

function toRules(d: Draft): PolicyRules {
  const minor = (v: string) => (v ? Math.round(Number(v) * 100) : undefined);
  const int = (v: string) => (v ? Number(v) : undefined);
  return {
    flight: {
      maxCabin: d.maxCabin || undefined,
      maxFarePerTraveller: minor(d.maxFare),
      minAdvanceDays: int(d.minAdvanceDays),
      refundableOnly: d.refundableOnly || undefined,
    },
    hotel: { maxStars: int(d.maxStars), maxNightlyPerRoom: minor(d.maxNightly) },
  };
}

export default function PoliciesPage() {
  const currency = session.user()?.tenant.currency ?? 'USD';
  const [policies, setPolicies] = useState<TravelPolicy[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<TravelPolicy[]>('/corporate/policies').then(setPolicies).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function save() {
    if (!draft) return;
    setError(null);
    try {
      await api('/corporate/policies', {
        method: 'PUT',
        body: JSON.stringify({ grade: draft.grade, approvalMode: draft.approvalMode, rules: toRules(draft) }),
      });
      setNotice(`Saved the ${draft.grade} policy. It applies to new searches straight away.`);
      setDraft(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => draft && setDraft({ ...draft, [k]: v });
  const limit = (amount: number | undefined, unit = '') => (amount == null ? 'No limit' : `${(amount / 100).toLocaleString()} ${currency}${unit}`);

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Travel policies</h1>
          <p className="muted small" style={{ margin: 0 }}>
            One policy per employee grade. Employees without a grade use the &quot;default&quot; policy.
          </p>
        </div>
        <button
          className="btn"
          onClick={() => {
            setDraft({ ...EMPTY });
            setIsNew(true);
          }}
        >
          Add grade
        </button>
      </div>
      {error && <div className="alert bad" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="alert good" style={{ marginBottom: 12 }}>{notice}</div>}

      {draft && (
        <div className="card stack" style={{ marginBottom: 16 }}>
          <h2>{isNew ? 'New policy' : `Edit ${draft.grade} policy`}</h2>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 2fr' }}>
            <div className="field">
              <label>Grade</label>
              <input value={draft.grade} disabled={!isNew} onChange={(e) => set('grade', e.target.value)} placeholder="e.g. manager" />
            </div>
            <div className="field">
              <label>Approval</label>
              <select value={draft.approvalMode} onChange={(e) => set('approvalMode', e.target.value as ApprovalMode)}>
                {(Object.keys(APPROVAL_MODE_LABEL) as ApprovalMode[]).map((m) => (
                  <option key={m} value={m}>
                    {APPROVAL_MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <h3 style={{ margin: '4px 0 0' }}>Flights</h3>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
            <div className="field">
              <label>Highest cabin</label>
              <select value={draft.maxCabin} onChange={(e) => set('maxCabin', e.target.value)}>
                {CABINS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Max fare per traveller ({currency})</label>
              <input type="number" min="0" step="1" value={draft.maxFare} onChange={(e) => set('maxFare', e.target.value)} placeholder="No limit" />
            </div>
            <div className="field">
              <label>Book at least (days ahead)</label>
              <input type="number" min="0" max="365" value={draft.minAdvanceDays} onChange={(e) => set('minAdvanceDays', e.target.value)} placeholder="Any time" />
            </div>
            <div className="field">
              <label>Fares</label>
              <select value={draft.refundableOnly ? 'yes' : 'no'} onChange={(e) => set('refundableOnly', e.target.value === 'yes')}>
                <option value="no">Any fare</option>
                <option value="yes">Refundable only</option>
              </select>
            </div>
          </div>
          <h3 style={{ margin: '4px 0 0' }}>Hotels</h3>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 2fr' }}>
            <div className="field">
              <label>Highest star rating</label>
              <select value={draft.maxStars} onChange={(e) => set('maxStars', e.target.value)}>
                <option value="">Any</option>
                {[2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} stars
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Max per room per night ({currency})</label>
              <input type="number" min="0" step="1" value={draft.maxNightly} onChange={(e) => set('maxNightly', e.target.value)} placeholder="No limit" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn" onClick={save} disabled={!draft.grade.trim()}>
              Save policy
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Grade</th>
              <th>Flights</th>
              <th>Hotels</th>
              <th>Approval</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {policies.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No policies yet, so every trip is in policy.
                </td>
              </tr>
            )}
            {policies.map((p) => (
              <tr key={p.id}>
                <td style={{ fontWeight: 600 }}>{p.grade}</td>
                <td className="small">
                  {CABINS.find(([v]) => v === (p.rules.flight?.maxCabin ?? ''))?.[1]} · {limit(p.rules.flight?.maxFarePerTraveller)}
                  {p.rules.flight?.minAdvanceDays ? ` · ${p.rules.flight.minAdvanceDays}+ days ahead` : ''}
                  {p.rules.flight?.refundableOnly ? ' · refundable only' : ''}
                </td>
                <td className="small">
                  {p.rules.hotel?.maxStars ? `Up to ${p.rules.hotel.maxStars} stars` : 'Any rating'} · {limit(p.rules.hotel?.maxNightlyPerRoom, '/night')}
                </td>
                <td className="small">{APPROVAL_MODE_LABEL[p.approvalMode]}</td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="btn secondary"
                    style={{ height: 30 }}
                    onClick={() => {
                      setDraft(toDraft(p));
                      setIsNew(false);
                    }}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
