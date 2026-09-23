import { randomInt } from 'crypto';

/** e.g. "ORD-20260923-483920". Not guaranteed unique — callers must check. */
function generateOrderNumber(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const suffix = randomInt(100000, 999999);
  return `ORD-${y}${m}${d}-${suffix}`;
}

export { generateOrderNumber };
