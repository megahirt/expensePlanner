import { describe, expect, it } from 'vitest';
import { DateParseError, daysBetween, detectDateFormat, monthKey, monthStart, parseDate } from '@/lib/dates';

describe('parseDate', () => {
  it('parses the common export formats', () => {
    expect(parseDate('2025-03-04', 'YYYY-MM-DD')).toBe('2025-03-04');
    expect(parseDate('03/04/2025', 'MM/DD/YYYY')).toBe('2025-03-04');
    expect(parseDate('04/03/2025', 'DD/MM/YYYY')).toBe('2025-03-04');
    expect(parseDate('3/4/25', 'MM/DD/YY')).toBe('2025-03-04');
    expect(parseDate('04.03.2025', 'DD.MM.YYYY')).toBe('2025-03-04');
    expect(parseDate('Mar 4, 2025', 'MMM D, YYYY')).toBe('2025-03-04');
    expect(parseDate('March 4, 2025', 'MMM D, YYYY')).toBe('2025-03-04');
    expect(parseDate('4 Mar 2025', 'D MMM YYYY')).toBe('2025-03-04');
  });

  it('rejects impossible dates instead of rolling them over', () => {
    // Date() would turn this into March 2nd; silently shifting a transaction to
    // another month is exactly the kind of quiet corruption we refuse.
    expect(() => parseDate('02/30/2025', 'MM/DD/YYYY')).toThrow(DateParseError);
    expect(() => parseDate('13/01/2025', 'MM/DD/YYYY')).toThrow(DateParseError);
    expect(() => parseDate('not a date', 'MM/DD/YYYY')).toThrow(DateParseError);
  });

  it('handles leap years', () => {
    expect(parseDate('02/29/2024', 'MM/DD/YYYY')).toBe('2024-02-29');
    expect(() => parseDate('02/29/2025', 'MM/DD/YYYY')).toThrow(DateParseError);
  });
});

describe('detectDateFormat', () => {
  it('uses a day over 12 to tell MM/DD from DD/MM', () => {
    expect(detectDateFormat(['01/15/2025', '02/28/2025'])).toBe('MM/DD/YYYY');
    expect(detectDateFormat(['15/01/2025', '28/02/2025'])).toBe('DD/MM/YYYY');
  });

  it('prefers ISO when unambiguous', () => {
    expect(detectDateFormat(['2025-01-05', '2025-02-06'])).toBe('YYYY-MM-DD');
  });

  it('ignores junk values so a footer row does not defeat detection', () => {
    // Real exports append "Total" rows and stray notes. That row still fails
    // later as a visible row-level error; it just does not veto the column.
    expect(detectDateFormat(['2025-01-05', '2025-02-06', 'Total'])).toBe('YYYY-MM-DD');
  });

  it('refuses to guess when the column genuinely mixes conventions', () => {
    // No single format explains both, and picking one would silently misdate
    // half the rows.
    expect(detectDateFormat(['01/15/2025', '2025-01-05'])).toBeNull();
    expect(detectDateFormat(['garbage', 'more garbage'])).toBeNull();
    expect(detectDateFormat([])).toBeNull();
  });
});

describe('date helpers', () => {
  it('computes day gaps and month buckets', () => {
    expect(daysBetween('2025-03-01', '2025-03-04')).toBe(3);
    expect(daysBetween('2025-03-04', '2025-03-01')).toBe(3);
    expect(daysBetween('2024-12-31', '2025-01-01')).toBe(1);
    expect(monthKey('2025-03-04')).toBe('2025-03');
    expect(monthStart('2025-03-04')).toBe('2025-03-01');
    expect(monthStart('2025-01-15', 1)).toBe('2024-12-01');
  });
});
