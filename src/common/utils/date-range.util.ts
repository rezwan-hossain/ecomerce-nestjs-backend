const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Prisma `createdAt` filter from optional ISO `from` / `to` query strings.
 * A date-only `to` ("2026-10-02") includes that whole day (UTC) — passed
 * as-is it would mean midnight at the START of the day and drop it. A
 * datetime is used exactly. Returns undefined when neither is set.
 */
function dateRangeFilter(
  from?: string,
  to?: string,
): { gte?: Date; lt?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;

  let upper: { lt: Date } | { lte: Date } | undefined;
  if (to && DATE_ONLY.test(to)) {
    const nextDay = new Date(`${to}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    upper = { lt: nextDay };
  } else if (to) {
    upper = { lte: new Date(to) };
  }

  return { ...(from && { gte: new Date(from) }), ...upper };
}

export { dateRangeFilter };
