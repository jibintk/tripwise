'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApprovalSummary, decisionMessage } from '@/components/ApprovalCard';
import { api, ApiError, ApprovalItem, DecisionResult } from '@/lib/api';

/** Opened from the approval email. No login: the one-time token in the link is the authority. */
function ApproveByLink() {
  const { id } = useParams<{ id: string }>();
  const token = useSearchParams().get('token') ?? '';
  const [item, setItem] = useState<ApprovalItem | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ApprovalItem>(`/approvals/${id}/by-token?token=${encodeURIComponent(token)}`)
      .then(setItem)
      .catch((e) => setError(e instanceof ApiError && e.code === 'LINK_EXPIRED' ? 'This approval link has expired. Please decide in the Tripwise portal.' : e.message));
  }, [id, token]);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      const r = await api<DecisionResult>(`/approvals/${id}/by-token`, {
        method: 'POST',
        body: JSON.stringify({ token, decision, comment: comment || undefined }),
      });
      setResult(decisionMessage(decision, r.bookingStatus, r.failureReason));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const decided = item && item.status !== 'pending';

  return (
    <div className="login-wrap">
      <div className="stack" style={{ width: '100%', maxWidth: 560 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand)' }}>Tripwise</div>
        <h1 style={{ margin: 0 }}>Trip approval</h1>
        {error && <div className="alert bad">{error}</div>}
        {result && <div className={`alert ${result.kind}`}>{result.text}</div>}
        {item && (
          <ApprovalSummary item={item}>
            {decided && !result && <div className="alert warn">This trip was already {item.status}.</div>}
            {!decided && !result && (
              <>
                <div className="field">
                  <label htmlFor="comment">Comment for the traveller (optional)</label>
                  <input id="comment" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn danger" disabled={busy} onClick={() => decide('reject')}>
                    Decline
                  </button>
                  <button className="btn" disabled={busy} onClick={() => decide('approve')}>
                    {busy ? 'Working…' : 'Approve and book'}
                  </button>
                </div>
              </>
            )}
          </ApprovalSummary>
        )}
      </div>
    </div>
  );
}

export default function ApprovePage() {
  return (
    <Suspense fallback={null}>
      <ApproveByLink />
    </Suspense>
  );
}
