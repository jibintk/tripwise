import { ReactNode } from 'react';
import { ApprovalItem } from '@/lib/api';
import { formatMoney } from '@/lib/format';

/** What an approver needs to decide: who, what, how much and why it is outside policy. */
export function ApprovalSummary({ item, children }: { item: ApprovalItem; children?: ReactNode }) {
  const p = item.policy;
  return (
    <div className="card stack">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>{item.traveller}</h2>
          <div className="muted small">
            {item.product === 'hotel' ? 'Hotel' : 'Flight'} · {item.trip} · {item.reference}
          </div>
        </div>
        <div className="price">{formatMoney({ amount: item.amount, currency: item.currency })}</div>
      </div>
      {p && (
        <div className="tags" style={{ marginTop: 0 }}>
          {p.inPolicy ? <span className="tag good">In policy</span> : <span className="tag warn">Out of policy</span>}
          <span className="tag">{p.grade} policy</span>
          {p.missedSaving > 0 && (
            <span className="tag">Could have saved {formatMoney({ amount: p.missedSaving, currency: item.currency })}</span>
          )}
        </div>
      )}
      {p && p.violations.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {p.violations.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      )}
      {p?.reasonForException && (
        <p className="small" style={{ margin: 0 }}>
          <strong>Traveller&apos;s reason:</strong> {p.reasonForException}
        </p>
      )}
      {children}
    </div>
  );
}

export function decisionMessage(decision: 'approve' | 'reject', bookingStatus: string, failureReason: string | null): { kind: 'good' | 'warn' | 'bad'; text: string } {
  if (decision === 'reject') return { kind: 'good', text: 'Trip declined. The traveller has been told and the hold released.' };
  if (bookingStatus === 'confirmed') return { kind: 'good', text: 'Approved. The trip is booked and the traveller has their documents.' };
  if (bookingStatus === 'expired' && failureReason === 'PRICE_CHANGED_BEFORE_APPROVAL')
    return { kind: 'warn', text: 'Approved, but the price changed while waiting, so nothing was booked. The traveller will search again.' };
  if (bookingStatus === 'expired') return { kind: 'warn', text: 'Approved, but the fare was no longer available. The traveller will search again.' };
  if (bookingStatus === 'failed') return { kind: 'bad', text: 'Approved, but the supplier could not complete the booking. The charge was refunded; operations will follow up.' };
  return { kind: 'good', text: 'Approved. The booking is being completed.' };
}
