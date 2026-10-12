/**
 * Money is always an integer amount of minor units (cents) plus an ISO 4217 currency code.
 * Never use floating point for money anywhere in Tripwise.
 */
export interface Money {
  amount: number;
  currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
  }
}

export function money(amount: number, currency: string): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`Money amount must be an integer number of minor units, got ${amount}`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Invalid currency code: ${currency}`);
  }
  return { amount, currency };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return money(a.amount - b.amount, a.currency);
}

/** Percentage of an amount in basis points (1% = 100 bps), rounded half up to a whole minor unit. */
export function percentOf(base: Money, basisPoints: number): Money {
  return money(Math.round((base.amount * basisPoints) / 10_000), base.currency);
}

export function zero(currency: string): Money {
  return money(0, currency);
}
