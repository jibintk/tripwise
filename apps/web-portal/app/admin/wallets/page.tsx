'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, session, WalletRow } from '@/lib/api';
import { formatMoney } from '@/lib/format';

type Action = { kind: 'topup' | 'credit'; wallet: WalletRow } | null;

export default function WalletsPage() {
  const me = session.user();
  const isFinance = !!me?.roles.includes('finance');
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [action, setAction] = useState<Action>(null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<WalletRow[]>('/accounts').then(setWallets).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function submit() {
    if (!action) return;
    setError(null);
    const minor = Math.round(Number(amount) * 100);
    try {
      if (action.kind === 'topup') {
        await api(`/accounts/${action.wallet.tenantId}/topups`, {
          method: 'POST',
          body: JSON.stringify({ amount: minor, currency: action.wallet.currency, memo }),
        });
        setNotice(`Topped up ${action.wallet.name} by ${formatMoney({ amount: minor, currency: action.wallet.currency })}.`);
      } else {
        await api(`/accounts/${action.wallet.tenantId}/credit-limit`, {
          method: 'PUT',
          body: JSON.stringify({ creditLimit: minor, currency: action.wallet.currency }),
        });
        setNotice(`Credit line for ${action.wallet.name} set to ${formatMoney({ amount: minor, currency: action.wallet.currency })}.`);
      }
      setAction(null);
      setAmount('');
      setMemo('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Wallets</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Balances across the network. {isFinance ? 'Record bank transfers as top-ups and set credit lines here.' : 'Finance users can top up and set credit lines.'}
          </p>
        </div>
      </div>
      {error && <div className="alert bad" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="alert good" style={{ marginBottom: 12 }}>{notice}</div>}

      {action && (
        <div className="card stack" style={{ marginBottom: 16 }}>
          <h2>
            {action.kind === 'topup' ? 'Top up' : 'Set credit line for'} {action.wallet.name}
          </h2>
          <div className="form-grid" style={{ gridTemplateColumns: action.kind === 'topup' ? '200px 1fr auto auto' : '200px auto auto' }}>
            <div className="field">
              <label>Amount ({action.wallet.currency})</label>
              <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </div>
            {action.kind === 'topup' && (
              <div className="field">
                <label>Reference (bank transfer, receipt…)</label>
                <input value={memo} onChange={(e) => setMemo(e.target.value)} />
              </div>
            )}
            <button className="btn" onClick={submit} disabled={!amount || (action.kind === 'topup' && memo.length < 2)}>
              Confirm
            </button>
            <button className="btn secondary" onClick={() => setAction(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Agency</th>
              <th style={{ textAlign: 'right' }}>Balance</th>
              <th style={{ textAlign: 'right' }}>Credit line</th>
              <th style={{ textAlign: 'right' }}>Available</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {wallets.map((w) => {
              const m = (amount: number) => formatMoney({ amount, currency: w.currency });
              return (
                <tr key={w.tenantId}>
                  <td>
                    {w.name}
                    <div className="muted small">
                      {w.type} {w.status !== 'active' ? `· ${w.status}` : ''}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', color: w.balance < 0 ? 'var(--bad)' : undefined }}>{m(w.balance)}</td>
                  <td style={{ textAlign: 'right' }}>{m(w.creditLimit)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{m(w.available)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {isFinance && (
                      <>
                        <button className="btn secondary" style={{ height: 30 }} onClick={() => setAction({ kind: 'credit', wallet: w })}>
                          Credit line
                        </button>{' '}
                        <button className="btn" style={{ height: 30 }} onClick={() => setAction({ kind: 'topup', wallet: w })}>
                          Top up
                        </button>
                      </>
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
