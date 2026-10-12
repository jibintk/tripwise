/** Plain, dependency-free email templates. Copy is editable here until the back-office template editor exists. */

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

interface BookingView {
  reference: string;
  product: 'flight' | 'hotel' | 'insurance';
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
  if (b.product === 'hotel') return hotelConfirmed(b);
  if (b.product === 'insurance') return policyIssued(b);
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

function hotelConfirmed(b: BookingView): Rendered {
  const subject = `Your hotel voucher ${b.reference} · ${b.route}`;
  const text = [
    `Your stay at ${b.route} is confirmed.`,
    `Dates: ${b.departure}`,
    `Guests: ${names(b)}`,
    `Supplier reference: ${b.pnr}`,
    `Total paid: ${b.sell}`,
    'Show your voucher at check-in. Extras and city taxes are paid at the hotel.',
  ].join('\n');
  const html = wrap('Your stay is confirmed', [
    `<strong>${esc(b.route)}</strong>`,
    esc(b.departure),
    `Guests: ${esc(names(b))}`,
    `Booking ${esc(b.reference)} · supplier reference ${esc(b.pnr ?? '')}`,
    `Total paid: ${esc(b.sell)}`,
    'Show your voucher at check-in. Extras and city taxes are paid at the hotel.',
  ]);
  return { subject, text, html };
}

function policyIssued(b: BookingView): Rendered {
  const subject = `Your travel insurance ${b.pnr} · ${b.reference}`;
  const lines = [
    `${b.route} is issued: policy number ${b.pnr}.`,
    `Period: ${b.departure}`,
    `Insured: ${names(b)}`,
    `Total paid: ${b.sell}`,
    'Download the certificate from your booking and carry it while travelling. It can be cancelled for a full refund until cover starts.',
  ];
  return { subject, text: lines.join('\n'), html: wrap('Your travel insurance is issued', lines.map(esc)) };
}

export function bookingHeld(b: BookingView): Rendered {
  if (b.product === 'insurance') {
    const subject = `Insurance quote held ${b.reference} · pay before ${b.holdExpiresAt}`;
    const text = `The premium for ${b.route} (${b.departure}) is held for ${names(b)} until ${b.holdExpiresAt}. The policy is issued once payment is made.`;
    return { subject, text, html: wrap('Quote held', [esc(text)]) };
  }
  if (b.product === 'hotel') {
    const subject = `Price held ${b.reference} · pay before ${b.holdExpiresAt}`;
    const text = `The price for ${b.route} (${b.departure}) is held for ${names(b)} until ${b.holdExpiresAt}. The room is reserved once payment is made.`;
    return { subject, text, html: wrap('Price held', [esc(text)]) };
  }
  const subject = `Seats held ${b.reference} · pay before ${b.holdExpiresAt}`;
  const text = `Booking ${b.reference} (${b.route}) is on hold for ${names(b)}. Pay before ${b.holdExpiresAt} or the airline releases the seats.`;
  return { subject, text, html: wrap('Seats on hold', [esc(text)]) };
}

export function bookingFailed(b: BookingView): Rendered {
  const what = { hotel: 'The hotel supplier did not confirm', insurance: 'The insurer did not issue', flight: 'The airline did not issue tickets for' }[b.product];
  const subject = `Action needed: ${b.product === 'flight' ? 'ticketing' : 'booking'} failed for ${b.reference}`;
  const text = `${what} ${b.reference} (${b.route}), reason ${b.failureReason}. The full amount was refunded to the agency wallet. Operations has been notified.`;
  return { subject, text, html: wrap(b.product === 'flight' ? 'Ticketing failed, refunded' : 'Booking failed, refunded', [esc(text)]) };
}

export function bookingExpired(b: BookingView): Rendered {
  const subject = `Hold expired ${b.reference}`;
  const text = `The hold on ${b.reference} (${b.route}) expired before payment. Search again to rebook.`;
  return { subject, text, html: wrap('Hold expired', [esc(text)]) };
}

export function bookingCancelled(b: BookingView): Rendered {
  const subject = `Booking cancelled ${b.reference}`;
  const released = { hotel: 'the reservation was released', insurance: 'the policy was cancelled', flight: 'the seats were released' }[b.product];
  const text = `Booking ${b.reference} (${b.route}) was cancelled and ${released}.`;
  return { subject, text, html: wrap('Booking cancelled', [esc(text)]) };
}

export function bookingRejected(b: BookingView): Rendered {
  const subject = `Trip not approved ${b.reference}`;
  const text = `Your trip ${b.reference} (${b.route}) was not approved and the hold was released. Talk to your approver or choose another option.`;
  return { subject, text, html: wrap('Trip not approved', [esc(text)]) };
}

export function approvalRequested(a: {
  approverName: string;
  travellerName: string;
  reference: string;
  trip: string;
  price: string;
  violations: string[];
  reason?: string;
  link: string;
  validHours: number;
}): Rendered {
  const subject = `Approval needed: ${a.travellerName}, ${a.trip}`;
  const policyLines = a.violations.length
    ? ['Outside policy:', ...a.violations.map((v) => `  - ${v}`), `Reason given: ${a.reason ?? '-'}`]
    : ['Within policy.'];
  const text = [
    `Hello ${a.approverName},`,
    `${a.travellerName} asks you to approve trip ${a.reference}: ${a.trip}, ${a.price}.`,
    ...policyLines,
    `Approve or decline here (link valid ${a.validHours} hours): ${a.link}`,
  ].join('\n');
  const html = wrap('Approval needed', [
    `${esc(a.travellerName)} asks you to approve <strong>${esc(a.reference)}</strong>: ${esc(a.trip)}, <strong>${esc(a.price)}</strong>.`,
    a.violations.length
      ? `Outside policy:<br>${a.violations.map(esc).join('<br>')}<br>Reason given: ${esc(a.reason ?? '-')}`
      : 'Within policy.',
    `<a href="${esc(a.link)}" style="display:inline-block;background:#0f6e6a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Review and decide</a>`,
    `The link is valid for ${a.validHours} hours.`,
  ]);
  return { subject, text, html };
}

export type { BookingView };
