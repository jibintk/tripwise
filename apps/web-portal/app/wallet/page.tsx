'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, Wallet } from '@/lib/api';
import { formatMoney } from '@/lib/format';

interface Entry {
  id: number;
  amount: number;
  currency: string;
  kind: string;
  refType: string;
  refId: string;
  memo: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = { topup: 'Top-up', booking_payment: 'Booking', refund: 'Refund' };

export default function WalletPage() {
  const [data, setData] = useState<{ account: Wallet; entries: Entry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ account: Wallet; entries: Entry[] }>('/accounts/me/ledger')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  const m = (amount: number) => formatMoney({ amount, currency: data?.account.currency ?? 'USD' });

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Wallet</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Bookings are paid from your balance first, then your credit line. Contact your account manager to top up.
          </p>
        </div>
      </div>
      {error && <div className="alert bad">{error}</div>}
      {data && (
        <div className="stack">
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="card">
              <div className="muted small">Balance</div>
              <div className="price">{m(data.account.balance)}</div>
            </div>
            <div className="card">
              <div className="muted small">Credit line</div>
              <div className="price">{m(data.account.creditLimit)}</div>
            </div>
            <div className="card">
              <div className="muted small">Available to spend</div>
              <div className="price">{m(data.account.available)}</div>
            </div>
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Reference</th>
                  <th>Note</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(e.createdAt).toLocaleString()}</td>
                    <td>{KIND_LABEL[e.kind] ?? e.kind}</td>
                    <td>{e.refType === 'booking' ? e.refId : '–'}</td>
                    <td className="muted">{e.memo}</td>
                    <td style={{ textAlign: 'right', color: e.amount < 0 ? 'var(--bad)' : 'var(--good)', fontWeight: 600 }}>
                      {e.amount > 0 ? '+' : ''}
                      {m(e.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Shell>
  );
}
