import { Decimal } from '@prisma/client/runtime/client';

export const ZERO = new Decimal(0);

/** Round to 2dp, half-up (what customers expect on a receipt). */
export function round2(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sumDecimals(values: Iterable<Decimal>): Decimal {
  let total = ZERO;
  for (const value of values) total = total.plus(value);
  return total;
}

export function formatMoney(value: Decimal, currency = 'BDT'): string {
  const amount = value.toFixed(2);
  return currency === 'BDT' ? `৳${amount}` : `${amount} ${currency}`;
}
