'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useState } from 'react';
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
  approval_requested: 'Sent for approval',
  approved: 'Approved',
  rejected: 'Not approved',
};

function eventLabel(type: string, product: Booking['product']): string {
  if (product === 'insurance') {
    if (type === 'confirmed') return 'Policy issued';
    if (type === 'booking_failed') return 'Insurer declined the policy';
    if (type === 'expired') return 'Quote expired';
  }
  return EVENT_LABEL[type] ?? type;
}

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
      booking?.status !== 'confirmed'
        ? 'Cancel this booking and release the hold?'
        : booking.product === 'insurance'
          ? 'Cancel this policy? Cover has not started, so the full premium is refunded.'
          : 'Cancel this stay with the hotel? Any cancellation penalty is deducted from the refund.';
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
  const isInsurance = booking.product === 'insurance';
  const isFlight = booking.product === 'flight';
  const doc = isInsurance
    ? { label: 'Download certificate (PDF)', file: 'insurance' }
    : isHotel
      ? { label: 'Download voucher (PDF)', file: 'voucher' }
      : { label: 'Download e-ticket (PDF)', file: 'eticket' };
  const coverStarted = isInsurance && !!booking.cover && booking.cover.startDate <= new Date().toISOString().slice(0, 10);
  const holdText = isInsurance
    ? 'The premium is held until {t}. The policy is issued when you pay.'
    : isHotel
      ? 'The price is held until {t}. The room is reserved when you pay.'
      : 'Seats are held until {t}. Pay before then or the airline releases them.';
  const failedText = isInsurance
    ? 'The insurer did not issue the policy'
    : isHotel
      ? 'The hotel supplier did not confirm the booking'
      : 'The airline did not issue tickets';

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>
            {booking.reference} <span className={`status ${booking.status}`}>{statusLabel(booking.status, booking.product)}</span>
          </h1>
          <p className="muted small" style={{ margin: 0 }}>
            {isInsurance ? 'Policy' : isHotel ? 'Supplier ref' : 'PNR'} {booking.pnr ?? (isInsurance ? 'issued on payment' : '–')}
            {booking.hotelConfirmation ? ` · hotel confirmation ${booking.hotelConfirmation}` : ''} · created{' '}
            {new Date(booking.createdAt).toLocaleString()}
          </p>
        </div>
        {booking.status === 'confirmed' && (
          <div style={{ display: 'flex', gap: 8 }}>
            {isFlight && (
              <Link className="btn secondary" href={`/insurance?from=${booking.reference}`} style={{ display: 'inline-flex', alignItems: 'center' }}>
                Add travel insurance
              </Link>
            )}
            {(isHotel || (isInsurance && !coverStarted)) && (
              <button className="btn danger" onClick={() => act('cancel')} disabled={!!busy}>
                {busy === 'cancel' ? 'Cancelling…' : isInsurance ? 'Cancel policy' : 'Cancel stay'}
              </button>
            )}
            <button
              className="btn secondary"
              onClick={() =>
                download(`/bookings/${booking.reference}/document.pdf`, `${doc.file}-${booking.reference}.pdf`).catch((e) => setError(e.message))
              }
            >
              {doc.label}
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
                ? isInsurance
                  ? 'Paying and issuing…'
                  : isHotel
                    ? 'Paying and booking…'
                    : 'Paying and ticketing…'
                : `Pay ${formatMoney(booking.pricing.agentCost)} and ${isInsurance ? 'issue' : isHotel ? 'book' : 'ticket'}`}
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
          {holdText.replace('{t}', expires.toLocaleString())}
        </div>
      )}
      {booking.status === 'failed' && (
        <div className="alert bad" style={{ marginBottom: 16 }}>
          {failedText} ({booking.failureReason}). Your
          wallet has been refunded in full and our operations team has been notified.
        </div>
      )}

      {booking.status === 'pending_approval' && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          Waiting for your approver. The trip is booked and paid automatically once approved; you will get an email either way.
        </div>
      )}
      {booking.status === 'rejected' && (
        <div className="alert bad" style={{ marginBottom: 16 }}>
          Your approver did not approve this trip and the hold was released.
        </div>
      )}
      {booking.status === 'expired' && booking.failureReason === 'PRICE_CHANGED_BEFORE_APPROVAL' && (
        <div className="alert bad" style={{ marginBottom: 16 }}>
          Approved, but the price changed while waiting, so nothing was booked. Please search again.
        </div>
      )}
      {booking.cancellation && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          {isInsurance ? 'Policy cancelled.' : `Cancelled. Hotel penalty ${formatMoney(booking.cancellation.penalty)};`} Refunded to your wallet{' '}
          {formatMoney(booking.cancellation.refunded)}.
        </div>
      )}

      <div className="two-col">
        <div className="stack">
          {isInsurance && booking.plan && booking.cover ? (
            <div className="card">
              <h2>{booking.plan.name}</h2>
              <p className="muted small" style={{ marginTop: -8 }}>
                {booking.plan.summary}
              </p>
              <dl className="kv" style={{ maxWidth: 560 }}>
                <dt>Area</dt>
                <dd>{booking.cover.regionLabel}</dd>
                <dt>Cover</dt>
                <dd>
                  {booking.cover.startDate} to {booking.cover.endDate} ({booking.cover.days} days)
                </dd>
                {booking.linkedReference && (
                  <>
                    <dt>For trip</dt>
                    <dd>
                      <Link href={`/bookings/${booking.linkedReference}`}>{booking.linkedReference}</Link>
                    </dd>
                  </>
                )}
                {booking.plan.coverage.map((c) => (
                  <Fragment key={c.label}>
                    <dt>{c.label}</dt>
                    <dd>{c.limit}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          ) : isHotel && booking.hotel && booking.stay && booking.room ? (
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
            <h2>{isHotel ? 'Guests' : isInsurance ? 'Insured travellers' : 'Travellers'}</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  {!isHotel && <th>Date of birth</th>}
                  {isFlight && <th>Ticket</th>}
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
                    {isFlight && <td>{booking.ticketNumbers[i] ?? '–'}</td>}
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
              {booking.channel !== 'b2e' && (
                <>
                  <dt>Your cost</dt>
                  <dd>{formatMoney(booking.pricing.agentCost)}</dd>
                  <dt>Your markup</dt>
                  <dd>{formatMoney(booking.pricing.yourMarkup)}</dd>
                </>
              )}
              <dt className="total">{booking.channel === 'b2e' ? 'Total (charged to company account)' : 'Customer pays'}</dt>
              <dd className="total">{formatMoney(booking.pricing.sell)}</dd>
            </dl>
          </div>
          {booking.policy && (
            <div className="card">
              <h2>Travel policy</h2>
              <p className="small" style={{ marginTop: -6 }}>
                {booking.policy.inPolicy ? 'Within the ' : 'Outside the '}
                {booking.policy.grade} policy.
              </p>
              {booking.policy.violations.length > 0 && (
                <ul className="small" style={{ paddingLeft: 18 }}>
                  {booking.policy.violations.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
              )}
              {booking.policy.reasonForException && <p className="small muted">Reason: {booking.policy.reasonForException}</p>}
              {booking.policy.missedSaving > 0 && (
                <p className="small muted">
                  Lowest fare in the search was {formatMoney({ amount: booking.policy.lowestSell ?? 0, currency: booking.pricing.sell.currency })} (missed
                  saving {formatMoney({ amount: booking.policy.missedSaving, currency: booking.pricing.sell.currency })}).
                </p>
              )}
            </div>
          )}
          <div className="card">
            <h2>History</h2>
            <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
              {booking.events?.map((e, i) => (
                <li key={i}>
                  {eventLabel(e.type, booking.product)} <span className="muted">· {new Date(e.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Shell>
  );
}
