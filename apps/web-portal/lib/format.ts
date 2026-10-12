export interface Money {
  amount: number;
  currency: string;
}

/** Formats minor units for display, e.g. { amount: 106045, currency: 'USD' } -> "USD 1,060.45". */
export function formatMoney(m: Money | undefined | null): string {
  if (!m) return '–';
  const value = (m.amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${m.currency} ${value}`;
}

/** "2026-12-10T06:05:00" -> "06:05" */
export function timeOf(isoLocal: string): string {
  return isoLocal.slice(11, 16);
}

/** "2026-12-10T06:05:00" -> "Thu 10 Dec" */
export function dayOf(isoLocal: string): string {
  const d = new Date(`${isoLocal.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** 235 -> "3h 55m" */
export function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}

const STATUS_LABEL: Record<string, string> = {
  held: 'On hold',
  paid: 'Paid',
  ticketing: 'Ticketing',
  confirmed: 'Ticketed',
  cancelled: 'Cancelled',
  failed: 'Failed, refunded',
  expired: 'Hold expired',
};

export function statusLabel(status: string, product: string = 'flight'): string {
  if (product !== 'flight' && status === 'confirmed') return 'Confirmed';
  if (product !== 'flight' && status === 'ticketing') return 'Booking';
  return STATUS_LABEL[status] ?? status;
}
