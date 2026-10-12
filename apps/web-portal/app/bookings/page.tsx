'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, Booking } from '@/lib/api';
import { formatMoney, statusLabel } from '@/lib/format';

export default function BookingsPage() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBookings(null);
    api<Booking[]>(`/bookings${status ? `?status=${status}` : ''}`)
      .then(setBookings)
      .catch((e) => setError(e.message));
  }, [status]);

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Newest first. Held bookings must be paid before the hold expires.
          </p>
        </div>
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="held">On hold</option>
            <option value="confirmed">Ticketed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Hold expired</option>
          </select>
        </div>
      </div>
      {error && <div className="alert bad">{error}</div>}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Trip</th>
              <th>Lead guest / traveller</th>
              <th>PNR</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Customer pays</th>
            </tr>
          </thead>
          <tbody>
            {bookings === null && (
              <tr>
                <td colSpan={6} className="muted">
                  Loading…
                </td>
              </tr>
            )}
            {bookings?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No bookings yet. <Link href="/search">Search flights</Link>
                </td>
              </tr>
            )}
            {bookings?.map((b) => {
              const first = b.itinerary?.[0].segments[0];
              const last = b.itinerary?.[0].segments.at(-1);
              return (
                <tr key={b.reference}>
                  <td>
                    <Link href={`/bookings/${b.reference}`}>{b.reference}</Link>
                  </td>
                  <td>
                    {b.product === 'hotel' ? (
                      <>
                        {b.hotel?.name}
                        <div className="muted small">
                          Hotel · {b.stay?.checkIn} to {b.stay?.checkOut}
                        </div>
                      </>
                    ) : (
                      <>
                        {first?.origin} → {last?.destination}
                        {(b.itinerary?.length ?? 0) > 1 ? ' (return)' : ''}
                        <div className="muted small">Flight · {first?.departureLocal.slice(0, 10)}</div>
                      </>
                    )}
                  </td>
                  <td>
                    {b.passengers[0].lastName}/{b.passengers[0].firstName}
                    {b.passengers.length > 1 ? ` +${b.passengers.length - 1}` : ''}
                  </td>
                  <td>{b.pnr ?? '–'}</td>
                  <td>
                    <span className={`status ${b.status}`}>{statusLabel(b.status, b.product)}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(b.pricing.sell)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
