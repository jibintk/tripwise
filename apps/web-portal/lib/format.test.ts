import { dayOf, duration, formatMoney, statusLabel, timeOf } from './format';

describe('format', () => {
  it('formats minor units as money', () => {
    expect(formatMoney({ amount: 106045, currency: 'USD' })).toBe('USD 1,060.45');
    expect(formatMoney({ amount: 5, currency: 'KES' })).toBe('KES 0.05');
    expect(formatMoney(undefined)).toBe('–');
  });

  it('formats times, days and durations', () => {
    expect(timeOf('2026-12-10T06:05:00')).toBe('06:05');
    expect(dayOf('2026-12-10T06:05:00')).toBe('Thu 10 Dec');
    expect(duration(235)).toBe('3h 55m');
    expect(duration(45)).toBe('45m');
  });

  it('labels booking statuses for agents', () => {
    expect(statusLabel('confirmed')).toBe('Ticketed');
    expect(statusLabel('failed')).toBe('Failed, refunded');
  });
});
