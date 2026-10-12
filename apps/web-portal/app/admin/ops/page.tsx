'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, Booking } from '@/lib/api';
import { formatMoney, statusLabel } from '@/lib/format';

type QueueItem = Booking & { agencyPath: string; updatedAt: string };

export default function OpsPage() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [jobResult, setJobResult] = useState<string | null>(null);

  const load = useCallback(() => {
    api<QueueItem[]>('/ops/queue').then(setItems).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function resolve(ref: string) {
    try {
      await api(`/ops/bookings/${ref}/resolve`, { method: 'POST', body: JSON.stringify({ note: notes[ref] ?? '' }) });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function runJobs() {
    try {
      const r = await api<{ eventsDelivered: number; holdsExpired: string[]; ticketingRecovered: string[] }>('/ops/jobs/run', {
        method: 'POST',
      });
      setJobResult(
        `Delivered ${r.eventsDelivered} events, expired ${r.holdsExpired.length} holds, recovered ${r.ticketingRecovered.length} bookings.`,
      );
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Operations queue</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Bookings that need a person: ticketing failed (already refunded to the agency), or stuck in ticketing for more than 10
            minutes.
          </p>
        </div>
        <button className="btn secondary" onClick={runJobs}>
          Run background jobs now
        </button>
      </div>
      {error && <div className="alert bad" style={{ marginBottom: 12 }}>{error}</div>}
      {jobResult && <div className="alert good" style={{ marginBottom: 12 }}>{jobResult}</div>}
      {items?.length === 0 && <div className="alert good">Nothing waiting. All bookings are healthy.</div>}
      <div className="stack">
        {items?.map((b) => (
          <div className="card" key={b.reference}>
            <div className="offer">
              <div>
                <strong>
                  <Link href={`/bookings/${b.reference}`}>{b.reference}</Link>
                </strong>{' '}
                <span className={`status ${b.status}`}>{statusLabel(b.status, b.product)}</span>
                <div className="muted small">
                  {b.agencyPath.split('.').pop()} · PNR {b.pnr ?? '–'} · {b.failureReason ?? 'no ticket yet'} ·{' '}
                  {b.passengers[0].lastName}/{b.passengers[0].firstName} · {formatMoney(b.pricing.agentCost)}
                </div>
              </div>
              {b.status === 'failed' && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
                  <div className="field" style={{ minWidth: 260 }}>
                    <label>What was done</label>
                    <input
                      value={notes[b.reference] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [b.reference]: e.target.value })}
                      placeholder="e.g. Rebooked on TW-XXXXXX"
                    />
                  </div>
                  <button className="btn" disabled={(notes[b.reference] ?? '').length < 3} onClick={() => resolve(b.reference)}>
                    Mark resolved
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
