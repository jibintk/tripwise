'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Itinerary } from '@/components/Itinerary';
import { notifyWalletChanged, Shell } from '@/components/Shell';
import { api, ApiError, Booking, BOARD_LABEL, download } from '@/lib/api';
import { formatMoney, statusLabel } from '@/lib/format';

const EVENT_LABEL: Record<string, string> = {
  held: 'Held',
  paid: 'Paid from wallet',
  ticketed: 'Tickets issued',
  confirmed: 'Confirmed by the hotel supplier',
  booking_failed: 'Hotel supplier rejected the booking',
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
    const question =
      booking?.product === 'hotel' && booking.status === 'confirmed'
        ? 'Cancel this stay with the hotel? Any cancellation penalty is deducted from the refund.'
        : 'Cancel this booking and release the hold?';
    if (kind === 'cancel' && !confirm(question)) return;
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
  const isHotel = booking.product === 'hotel';
  const docLabel = isHotel ? 'Download voucher (PDF)' : 'Download e-ticket (PDF)';

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>
            {booking.reference} <span className={`status ${booking.status}`}>{statusLabel(booking.status, booking.product)}</span>
          </h1>
          <p className="muted small" style={{ margin: 0 }}>
            {isHotel ? 'Supplier ref' : 'PNR'} {booking.pnr ?? '–'}
            {booking.hotelConfirmation ? ` · hotel confirmation ${booking.hotelConfirmation}` : ''} · created{' '}
            {new Date(booking.createdAt).toLocaleString()}
          </p>
        </div>
        {booking.status === 'confirmed' && (
          <div style={{ display: 'flex', gap: 8 }}>
            {isHotel && (
              <button className="btn danger" onClick={() => act('cancel')} disabled={!!busy}>
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel stay'}
              </button>
            )}
            <button
              className="btn secondary"
              onClick={() =>
                download(`/bookings/${booking.reference}/document.pdf`, `${isHotel ? 'voucher' : 'eticket'}-${booking.reference}.pdf`).catch((e) =>
                  setError(e.message),
                )
              }
            >
              {docLabel}
            </button>
          </div>
        )}
        {booking.status === 'held' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn danger" onClick={() => act('cancel')} disabled={!!busy}>
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
            </button>
            <button className="btn" onClick={() => act('pay')} disabled={!!busy}>
              {busy === 'pay'
                ? isHotel
                  ? 'Paying and booking…'
                  : 'Paying and ticketing…'
                : `Pay ${formatMoney(booking.pricing.agentCost)} and ${isHotel ? 'book' : 'ticket'}`}
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
          {isHotel
            ? `The price is held until ${expires.toLocaleString()}. The room is reserved when you pay.`
            : `Seats are held until ${expires.toLocaleString()}. Pay before then or the airline releases them.`}
        </div>
      )}
      {booking.status === 'failed' && (
        <div className="alert bad" style={{ marginBottom: 16 }}>
          {isHotel ? 'The hotel supplier did not confirm the booking' : 'The airline did not issue tickets'} ({booking.failureReason}). Your
          wallet has been refunded in full and our operations team has been notified.
        </div>
      )}

      {booking.cancellation && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          Cancelled. Hotel penalty {formatMoney(booking.cancellation.penalty)}; refunded to your wallet{' '}
          {formatMoney(booking.cancellation.refunded)}.
        </div>
      )}

      <div className="two-col">
        <div className="stack">
          {isHotel && booking.hotel && booking.stay && booking.room ? (
            <div className="card">
              <h2>{booking.hotel.name}</h2>
              <p className="muted small" style={{ marginTop: -8 }}>
                {'★'.repeat(booking.hotel.stars)} · {booking.hotel.address}
              </p>
              <dl className="kv" style={{ maxWidth: 420 }}>
                <dt>Check-in</dt>
                <dd>{booking.stay.checkIn}</dd>
                <dt>Check-out</dt>
                <dd>{booking.stay.checkOut}</dd>
                <dt>Nights</dt>
                <dd>{booking.stay.nights}</dd>
                <dt>Room</dt>
                <dd>
                  {booking.stay.rooms.length} × {booking.room.name}
                </dd>
                <dt>Board</dt>
                <dd>{BOARD_LABEL[booking.room.board] ?? booking.room.board}</dd>
                <dt>Cancellation</dt>
                <dd>{booking.room.refundable ? `Free until ${booking.room.freeCancellationUntil?.slice(0, 10)}` : 'Non-refundable'}</dd>
              </dl>
              {booking.specialRequests && <p className="small muted">Requests: {booking.specialRequests}</p>}
            </div>
          ) : (
            <div className="card">
              <h2>Itinerary</h2>
              <Itinerary slices={booking.itinerary ?? []} />
            </div>
          )}
          <div className="card">
            <h2>{isHotel ? 'Guests' : 'Travellers'}</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  {!isHotel && <th>Date of birth</th>}
                  {!isHotel && <th>Ticket</th>}
                  {isHotel && <th>Room</th>}
                </tr>
              </thead>
              <tbody>
                {booking.passengers.map((p, i) => (
                  <tr key={i}>
                    <td>
                      {p.title} {p.firstName} {p.lastName}
                    </td>
                    {!isHotel && <td>{p.dateOfBirth}</td>}
                    {!isHotel && <td>{booking.ticketNumbers[i] ?? '–'}</td>}
                    {isHotel && <td>Room {i + 1}</td>}
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
