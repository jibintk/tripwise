import { PolicyVerdict } from '@/lib/api';

/** In / out of travel policy, with the reasons on hover. Renders nothing for non-corporate users. */
export function PolicyBadge({ policy }: { policy?: PolicyVerdict }) {
  if (!policy) return null;
  return policy.inPolicy ? (
    <span className="tag good">In policy</span>
  ) : (
    <span className="tag warn" title={policy.violations.join('\n')}>
      Out of policy: {policy.violations[0]}
      {policy.violations.length > 1 ? ` (+${policy.violations.length - 1})` : ''}
    </span>
  );
}

/** The reason box shown when a corporate traveller picks an out-of-policy option. */
export function ExceptionReason({
  policy,
  value,
  onChange,
}: {
  policy?: PolicyVerdict;
  value: string;
  onChange: (v: string) => void;
}) {
  if (!policy || policy.inPolicy) return null;
  return (
    <div className="alert warn stack">
      <div>
        <strong>Outside your travel policy</strong>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {policy.violations.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      </div>
      <div className="field">
        <label htmlFor="reason">Reason for this choice (sent to your approver)</label>
        <textarea id="reason" value={value} onChange={(e) => onChange(e.target.value)} required minLength={3} maxLength={500} />
      </div>
    </div>
  );
}
