'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, ApiError, PricingRule, session } from '@/lib/api';
import { formatMoney } from '@/lib/format';

const blank = { name: '', valueType: 'percent', value: '', origin: '', destination: '', channel: '', cabin: '' };

function describe(r: PricingRule): string {
  const scope = [
    r.product,
    r.channel?.toUpperCase(),
    r.origin && `from ${r.origin}`,
    r.destination && `to ${r.destination}`,
    r.cabin?.toLowerCase().replace('_', ' '),
    r.supplier && `via ${r.supplier}`,
  ].filter(Boolean);
  return scope.length ? scope.join(' · ') : 'Everything';
}

export default function PricingPage() {
  const me = session.user();
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<PricingRule[]>('/pricing/rules').then(setRules).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const raw = Number(form.value);
    // Percent is entered as e.g. 2.5 and stored as basis points; fixed is entered in currency units.
    const value = Math.round(form.valueType === 'percent' ? raw * 100 : raw * 100);
    try {
      await api('/pricing/rules', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          product: 'flight',
          valueType: form.valueType,
          value,
          origin: form.origin || null,
          destination: form.destination || null,
          channel: form.channel || null,
          cabin: form.cabin || null,
        }),
      });
      setForm(blank);
      load();
    } catch (err) {
      setError(
        err instanceof ApiError && Array.isArray(err.body.errors)
          ? (err.body.errors as { message: string }[]).map((x) => x.message).join('. ')
          : (err as Error).message,
      );
    }
  }

  async function remove(r: PricingRule) {
    if (!confirm(`Stop applying "${r.name}"?`)) return;
    await api(`/pricing/rules/${r.id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    load();
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Pricing rules</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Markups {me?.tenant.name} adds on top of what it pays. The most specific matching rule wins; your parent&apos;s
            markups are applied before yours.
          </p>
        </div>
      </div>
      {error && <div className="alert bad" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="two-col">
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Applies to</th>
                <th style={{ textAlign: 'right' }}>Markup</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No rules: you sell at the price you pay.
                  </td>
                </tr>
              )}
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="muted">{describe(r)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {r.valueType === 'percent' ? `${(r.value / 100).toFixed(2)}%` : formatMoney({ amount: r.value, currency: r.currency ?? 'USD' })}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn danger" style={{ height: 30 }} onClick={() => remove(r)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="card stack" onSubmit={create}>
          <h2>New flight markup</h2>
          <div className="field">
            <label>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Zanzibar season" required />
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="field">
              <label>Type</label>
              <select value={form.valueType} onChange={(e) => setForm({ ...form, valueType: e.target.value })}>
                <option value="percent">Percent</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </div>
            <div className="field">
              <label>{form.valueType === 'percent' ? 'Percent' : `Amount (${me?.tenant.currency})`}</label>
              <input type="number" step="0.01" min="0" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} required />
            </div>
            <div className="field">
              <label>From (optional)</label>
              <input maxLength={3} value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value.toUpperCase() })} />
            </div>
            <div className="field">
              <label>To (optional)</label>
              <input maxLength={3} value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value.toUpperCase() })} />
            </div>
            <div className="field">
              <label>Channel</label>
              <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                <option value="">Any</option>
                <option value="b2b">B2B</option>
                <option value="b2c">B2C</option>
                <option value="b2e">Corporate</option>
                <option value="pos">Front office</option>
              </select>
            </div>
            <div className="field">
              <label>Cabin</label>
              <select value={form.cabin} onChange={(e) => setForm({ ...form, cabin: e.target.value })}>
                <option value="">Any</option>
                <option value="ECONOMY">Economy</option>
                <option value="PREMIUM_ECONOMY">Premium economy</option>
                <option value="BUSINESS">Business</option>
                <option value="FIRST">First</option>
              </select>
            </div>
          </div>
          <button className="btn">Add rule</button>
        </form>
      </div>
    </Shell>
  );
}
