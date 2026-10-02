import { dateRangeFilter } from './date-range.util';

describe('dateRangeFilter', () => {
  it('returns undefined when neither bound is set', () => {
    expect(dateRangeFilter()).toBeUndefined();
  });

  it('makes a date-only upper bound include that whole day', () => {
    expect(dateRangeFilter('2026-10-01', '2026-10-02')).toEqual({
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lt: new Date('2026-10-03T00:00:00.000Z'),
    });
  });

  it('rolls over month and year ends', () => {
    expect(dateRangeFilter(undefined, '2026-12-31')).toEqual({
      lt: new Date('2027-01-01T00:00:00.000Z'),
    });
  });

  it('uses a datetime upper bound exactly', () => {
    expect(dateRangeFilter(undefined, '2026-10-02T14:30:00+06:00')).toEqual({
      lte: new Date('2026-10-02T08:30:00.000Z'),
    });
  });
});
