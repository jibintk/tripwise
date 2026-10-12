/** Plain, dependency-free email templates. Copy is editable here until the back-office template editor exists. */

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

interface BookingView {
  reference: string;
  pnr: string | null;
  passengers: { title: string; firstName: string; lastName: string }[];
  ticketNumbers: string[];
  route: string;
  departure: string;
  sell: string;
  holdExpiresAt?: string | null;
  failureReason?: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function wrap(title: string, lines: string[]): string {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#16202b;max-width:560px">
<h2 style="color:#0f6e6a">${esc(title)}</h2>${lines.map((l) => `<p>${l}</p>`).join('')}
<p style="color:#7b8794;font-size:12px">Tripwise · This is an automated message.</p></body></html>`;
}

function names(b: BookingView) {
  return b.passengers.map((p) => `${p.title} ${p.firstName} ${p.lastName}`).join(', ');
}

export function bookingConfirmed(b: BookingView): Rendered {
  const tickets = b.passengers.map((p, i) => `${p.firstName} ${p.lastName}: ${b.ticketNumbers[i] ?? '-'}`);
  const subject = `Your e-ticket ${b.reference} · ${b.route}`;
  const text = [
    `Your booking ${b.reference} is confirmed and ticketed.`,
    `Route: ${b.route}, departing ${b.departure}`,
    `Airline reference (PNR): ${b.pnr}`,
    'Tickets:',
    ...tickets.map((t) => `  ${t}`),
    `Total paid: ${b.sell}`,
    'Please carry your passport and arrive at the airport at least 3 hours before an international departure.',
  ].join('\n');
  const html = wrap('Your booking is confirmed', [
    `Booking <strong>${esc(b.reference)}</strong> for ${esc(names(b))} is ticketed.`,
    `<strong>${esc(b.route)}</strong>, departing ${esc(b.departure)}. Airline reference (PNR): <strong>${esc(b.pnr ?? '')}</strong>.`,
    `Tickets:<br>${tickets.map(esc).join('<br>')}`,
    `Total paid: ${esc(b.sell)}`,
    'Please carry your passport and arrive at the airport at least 3 hours before an international departure.',
  ]);
  return { subject, text, html };
}

export function bookingHeld(b: BookingView): Rendered {
  const subject = `Seats held ${b.reference} · pay before ${b.holdExpiresAt}`;
  const text = `Booking ${b.reference} (${b.route}) is on hold for ${names(b)}. Pay before ${b.holdExpiresAt} or the airline releases the seats.`;
  return { subject, text, html: wrap('Seats on hold', [esc(text)]) };
}

export function bookingFailed(b: BookingView): Rendered {
  const subject = `Action needed: ticketing failed for ${b.reference}`;
  const text = `The airline did not issue tickets for ${b.reference} (${b.route}), reason ${b.failureReason}. The full amount was refunded to the agency wallet. Operations has been notified.`;
  return { subject, text, html: wrap('Ticketing failed, refunded', [esc(text)]) };
}

export function bookingExpired(b: BookingView): Rendered {
  const subject = `Hold expired ${b.reference}`;
  const text = `The hold on ${b.reference} (${b.route}) expired before payment and the seats were released. Search again to rebook.`;
  return { subject, text, html: wrap('Hold expired', [esc(text)]) };
}

export function bookingCancelled(b: BookingView): Rendered {
  const subject = `Booking cancelled ${b.reference}`;
  const text = `Booking ${b.reference} (${b.route}) was cancelled and the seats were released.`;
  return { subject, text, html: wrap('Booking cancelled', [esc(text)]) };
}

export type { BookingView };
