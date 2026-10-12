import { add, CurrencyMismatchError, money, percentOf, subtract } from './money';

describe('money', () => {
  it('rejects fractional minor units', () => {
    expect(() => money(10.5, 'USD')).toThrow();
  });

  it('rejects invalid currency codes', () => {
    expect(() => money(100, 'usd')).toThrow();
  });

  it('adds and subtracts in the same currency', () => {
    expect(add(money(1000, 'USD'), money(250, 'USD'))).toEqual(money(1250, 'USD'));
    expect(subtract(money(1000, 'USD'), money(250, 'USD'))).toEqual(money(750, 'USD'));
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(1, 'USD'), money(1, 'KES'))).toThrow(CurrencyMismatchError);
  });

  it('computes basis-point percentages rounded to whole minor units', () => {
    expect(percentOf(money(12345, 'USD'), 250)).toEqual(money(309, 'USD')); // 2.5% of 123.45 = 3.086
    expect(percentOf(money(10000, 'USD'), 1000)).toEqual(money(1000, 'USD'));
  });
});
