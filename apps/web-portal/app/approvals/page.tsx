'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApprovalSummary, decisionMessage } from '@/components/ApprovalCard';
import { Shell } from '@/components/Shell';
import { api, ApprovalItem, DecisionResult } from '@/lib/api';

export default function ApprovalsPage() {
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ApprovalItem[]>('/approvals').then(setItems).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function decide(item: ApprovalItem, decision: 'approve' | 'reject') {
    setBusy(item.id);
    setError(null);
    try {
      const r = await api<DecisionResult>(`/approvals/${item.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment: comments[item.id] || undefined }),
      });
      setNotice({ ...decisionMessage(decision, r.bookingStatus, r.failureReason), text: `${item.traveller}: ${decisionMessage(decision, r.bookingStatus, r.failureReason).text}` });
      load();
    } catch (e) {
      setError((e as Error).message);
      load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Trips waiting for your decision. Approving books and pays for the trip straight away.
          </p>
        </div>
      </div>
      <div className="stack">
        {error && <div className="alert bad">{error}</div>}
        {notice && <div className={`alert ${notice.kind}`}>{notice.text}</div>}
        {items && items.length === 0 && <div className="card muted">Nothing waiting for you.</div>}
        {items?.map((item) => (
          <ApprovalSummary key={item.id} item={item}>
            <div className="field">
              <label htmlFor={`c-${item.id}`}>Comment for the traveller (optional)</label>
              <input
                id={`c-${item.id}`}
                value={comments[item.id] ?? ''}
                maxLength={500}
                onChange={(e) => setComments({ ...comments, [item.id]: e.target.value })}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn danger" disabled={busy === item.id} onClick={() => decide(item, 'reject')}>
                Decline
              </button>
              <button className="btn" disabled={busy === item.id} onClick={() => decide(item, 'approve')}>
                {busy === item.id ? 'Working…' : 'Approve and book'}
              </button>
            </div>
          </ApprovalSummary>
        ))}
      </div>
    </Shell>
  );
}
