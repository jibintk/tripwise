'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Itinerary } from '@/components/Itinerary';
import { notifyWalletChanged, Shell } from '@/components/Shell';
import { api, ApiError, Booking, download } from '@/lib/api';
import { formatMoney, statusLabel } from '@/lib/format';

const EVENT_LABEL: Record<string, string> = {
  held: 'Seats held with the airline',
  paid: 'Paid from wallet',
  ticketed: 'Tickets issued',
  ticketing_failed: 'Ticketing failed',
  refunded: 'Refunded to wallet',
  cancelled: 'Cancelled',
  expired: 'Hold expired, seats released',
  ops_resolved: 'Resolved by operations',
};

export default function BookingDetailPage() {
  const { reference } = useParams<{ reference: string }>();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'pay' | 'cancel' | null>(null);

  const load = useCallback(() => {
    api<Booking>(`/bookings/${reference}`)
      .then(setBooking)
      .catch((e) => setError(e.message));
  }, [reference]);

  useEffect(load, [load]);

  async function act(kind: 'pay' | 'cancel') {
    if (kind === 'cancel' && !confirm('Cancel this booking and release the seats?')) return;
    setBusy(kind);
    setError(null);
    try {
      await api<Booking>(`/bookings/${reference}/${kind === 'pay' ? 'payments' : 'cancel'}`, { method: 'POST' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_FUNDS') {
        setError(
          `Not enough funds: ${formatMoney({ amount: err.body.available as number, currency: err.body.currency as string })} available. Top up your wallet and try again.`,
        );
      } else {
        setError(err instanceof Error ? err.message : 'Action failed');
      }
    } finally {
      setBusy(null);
      load();
      notifyWalletChanged();
    }
  }

  if (!booking) {
    return <Shell>{error ? <div className="alert bad">{error}</div> : <p className="muted">Loading…</p>}</Shell>;
  }

  const expires = booking.holdExpiresAt ? new Date(booking.holdExpiresAt) : null;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>
            {booking.reference} <span className={`status ${booking.status}`}>{statusLabel(booking.status)}</span>
          </h1>
          <p className="muted small" style={{ margin: 0 }}>
            PNR {booking.pnr ?? '–'} · created {new Date(booking.createdAt).toLocaleString()}
          </p>
        </div>
        {booking.status === 'confirmed' && (
          <button
            className="btn secondary"
            onClick={() => download(`/bookings/${booking.reference}/eticket.pdf`, `eticket-${booking.reference}.pdf`).catch((e) => setError(e.message))}
          >
            Download e-ticket (PDF)
          </button>
        )}
        {booking.status === 'held' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn danger" onClick={() => act('cancel')} disabled={!!busy}>
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
            </button>
            <button className="btn" onClick={() => act('pay')} disabled={!!busy}>
              {busy === 'pay' ? 'Paying and ticketing…' : `Pay ${formatMoney(booking.pricing.agentCost)} and ticket`}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="alert bad" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}
      {booking.status === 'held' && expires && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          Seats are held until {expires.toLocaleString()}. Pay before then or the airline releases them.
        </div>
      )}
      {booking.status === 'failed' && (
        <div className="alert bad" style={{ marginBottom: 16 }}>
          The airline did not issue tickets ({booking.failureReason}). Your wallet has been refunded in full and our operations
          team has been notified.
        </div>
      )}

      <div className="two-col">
        <div className="stack">
          <div className="card">
            <h2>Itinerary</h2>
            <Itinerary slices={booking.itinerary} />
          </div>
          <div className="card">
            <h2>Travellers</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Date of birth</th>
                  <th>Ticket</th>
                </tr>
              </thead>
              <tbody>
                {booking.passengers.map((p, i) => (
                  <tr key={i}>
                    <td>
                      {p.title} {p.firstName} {p.lastName}
                    </td>
                    <td>{p.dateOfBirth}</td>
                    <td>{booking.ticketNumbers[i] ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <h2>Price</h2>
            <dl className="kv">
              <dt>Your cost</dt>
              <dd>{formatMoney(booking.pricing.agentCost)}</dd>
              <dt>Your markup</dt>
              <dd>{formatMoney(booking.pricing.yourMarkup)}</dd>
              <dt className="total">Customer pays</dt>
              <dd className="total">{formatMoney(booking.pricing.sell)}</dd>
            </dl>
          </div>
          <div className="card">
            <h2>History</h2>
            <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
              {booking.events?.map((e, i) => (
                <li key={i}>
                  {EVENT_LABEL[e.type] ?? e.type} <span className="muted">· {new Date(e.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Shell>
  );
}
