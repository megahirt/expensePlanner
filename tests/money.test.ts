import { describe, expect, it } from 'vitest';
import {
  MoneyParseError,
  centsToCsvString,
  formatCents,
  parseMoneyToCents,
  sumCents,
} from '@/lib/money';

describe('parseMoneyToCents', () => {
  it('reads plain and decorated amounts', () => {
    expect(parseMoneyToCents('12.34')).toBe(1234);
    expect(parseMoneyToCents('$1,234.56')).toBe(123456);
    expect(parseMoneyToCents('  $ 0.05 ')).toBe(5);
    expect(parseMoneyToCents('1234')).toBe(123400);
    expect(parseMoneyToCents('.5')).toBe(50);
  });

  it('handles every negative convention banks use', () => {
    expect(parseMoneyToCents('-45.00')).toBe(-4500);
    expect(parseMoneyToCents('(45.00)')).toBe(-4500);
    expect(parseMoneyToCents('45.00-')).toBe(-4500);
    expect(parseMoneyToCents('($1,045.00)')).toBe(-104500);
    expect(parseMoneyToCents('45.00 DR')).toBe(-4500);
    expect(parseMoneyToCents('45.00 CR')).toBe(4500);
  });

  it('disambiguates European decimal notation', () => {
    expect(parseMoneyToCents('1.234,56')).toBe(123456);
    expect(parseMoneyToCents('1234,56')).toBe(123456);
    expect(parseMoneyToCents('1.234.567,89')).toBe(123456789);
    expect(parseMoneyToCents('1,234,567.89')).toBe(123456789);
  });

  it('resolves the ambiguous three-digit case by separator character', () => {
    // A comma before three digits is thousands grouping...
    expect(parseMoneyToCents('1,234')).toBe(123400);
    // ...while a lone dot before three digits is three decimal places, which is
    // what makes '0.005' a half-cent rather than five dollars.
    expect(parseMoneyToCents('1.234')).toBe(123);
    expect(parseMoneyToCents('1.234.567')).toBe(123456700);
  });

  it('rounds rather than truncating extra precision', () => {
    expect(parseMoneyToCents('0.005')).toBe(1);
    expect(parseMoneyToCents('0.004')).toBe(0);
    expect(parseMoneyToCents('19.999')).toBe(2000);
  });

  it('accepts numbers and rejects nonsense', () => {
    expect(parseMoneyToCents(12.34)).toBe(1234);
    expect(() => parseMoneyToCents('')).toThrow(MoneyParseError);
    expect(() => parseMoneyToCents('n/a')).toThrow(MoneyParseError);
    expect(() => parseMoneyToCents(null)).toThrow(MoneyParseError);
  });

  it('never accumulates float error, which is the whole point', () => {
    // 0.1 + 0.2 !== 0.3 in floating point; in cents it is exact.
    const cents = [parseMoneyToCents('0.10'), parseMoneyToCents('0.20')];
    expect(sumCents(cents)).toBe(30);

    const hundredDimes = Array.from({ length: 100 }, () => parseMoneyToCents('0.10'));
    expect(sumCents(hundredDimes)).toBe(1000);
  });
});

describe('formatting', () => {
  it('formats for display and for CSV differently', () => {
    expect(formatCents(-123456)).toBe('-$1,234.56');
    expect(formatCents(5)).toBe('$0.05');
    // CSV cells stay plain so spreadsheets read them as numbers.
    expect(centsToCsvString(-123456)).toBe('-1234.56');
    expect(centsToCsvString(5)).toBe('0.05');
    expect(centsToCsvString(0)).toBe('0.00');
  });
});
