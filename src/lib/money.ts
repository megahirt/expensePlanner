/**
 * Integer-cent money handling.
 *
 * Every amount in this app is an integer number of cents. Parsing happens once,
 * here, at the boundary; nothing downstream ever sees a float. Bank CSVs are a
 * zoo of formats — "$1,234.56", "(45.00)" for negatives, "1.234,56" in European
 * locales, "45.00 CR", trailing minus signs — so the parser is deliberately
 * forgiving about presentation and strict about the result.
 */

/** Thrown when a value cannot be read as money at all. */
export class MoneyParseError extends Error {
  constructor(public readonly input: string) {
    super(`Could not read "${input}" as an amount`);
    this.name = 'MoneyParseError';
  }
}

/**
 * Parse a money string into signed integer cents.
 *
 * Handles: currency symbols, thousands separators, parentheses-for-negative,
 * leading or trailing minus, "CR"/"DR" suffixes, and both `1,234.56` and
 * `1.234,56` decimal conventions.
 *
 * @returns signed cents, e.g. "-$1,234.56" -> -123456
 */
export function parseMoneyToCents(input: string | number | null | undefined): number {
  if (input === null || input === undefined) throw new MoneyParseError(String(input));
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyParseError(String(input));
    return Math.round(input * 100);
  }

  let s = input.trim();
  if (s === '') throw new MoneyParseError(input);

  let negative = false;

  // (123.45) means -123.45 in most accounting exports.
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // "45.00 CR" is a credit (money in); "DR" is a debit.
  const crdr = s.match(/\b(CR|DR)\b\.?$/i);
  if (crdr) {
    if (crdr[1]!.toUpperCase() === 'DR') negative = !negative;
    s = s.slice(0, crdr.index).trim();
  }

  // Leading or trailing minus (some exports put it after the number).
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith('+')) s = s.slice(1).trim();

  // Strip currency symbols, codes and whitespace (incl. non-breaking space).
  // `\s` already covers non-breaking and narrow no-break spaces, which show up
  // in exports that were pasted through a web page.
  s = s.replace(/[\p{Sc}]/gu, '').replace(/\b[A-Z]{3}\b/g, '').replace(/\s/g, '');
  if (s === '') throw new MoneyParseError(input);

  s = normalizeDecimalSeparators(s);

  if (!/^\d*(\.\d*)?$/.test(s)) throw new MoneyParseError(input);

  const [whole = '0', frac = ''] = s.split('.');
  if (whole === '' && frac === '') throw new MoneyParseError(input);

  // Round rather than truncate so three-decimal inputs don't silently lose money.
  const fracPadded = (frac + '00').slice(0, 3);
  let cents = Number(whole || '0') * 100 + Number(fracPadded.slice(0, 2) || '0');
  if (Number(fracPadded[2] ?? '0') >= 5) cents += 1;

  if (!Number.isFinite(cents)) throw new MoneyParseError(input);
  return negative ? -cents : cents;
}

/**
 * Decide which of `.` and `,` is the decimal point and normalize to `.`.
 *
 * When both appear, whichever comes last is the decimal point — that rule is
 * unambiguous and covers "1,234.56" and "1.234,56" alike.
 *
 * A single separator followed by exactly three digits is the genuinely
 * ambiguous case ("1,234" vs "1.234"), so the separator character decides:
 * a comma is read as a thousands separator and a dot as a decimal point. That
 * matches the convention each character carries in the files this tool reads —
 * US exports group with commas, and a lone dot before three digits is far more
 * likely three decimal places (a $3.459 gallon of gas, a converted amount) than
 * European thousands grouping, which almost always brings a comma decimal along
 * with it and so takes the both-separators path above.
 */
function normalizeDecimalSeparators(s: string): string {
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  if (lastDot === -1 && lastComma === -1) return s;

  if (lastDot !== -1 && lastComma !== -1) {
    const decimalAt = Math.max(lastDot, lastComma);
    const intPart = s.slice(0, decimalAt).replace(/[.,]/g, '');
    const fracPart = s.slice(decimalAt + 1);
    return `${intPart}.${fracPart}`;
  }

  const isComma = lastComma !== -1;
  const sep = isComma ? ',' : '.';
  const at = isComma ? lastComma : lastDot;
  const trailingDigits = s.length - at - 1;
  const occurrences = s.split(sep).length - 1;

  // Repeated separators can only be thousands grouping: "1.234.567".
  if (occurrences > 1) return s.replace(/[.,]/g, '');

  if (trailingDigits === 3 && isComma) return s.replace(/,/g, '');

  return `${s.slice(0, at).replace(/[.,]/g, '')}.${s.slice(at + 1)}`;
}

/** Format signed cents for display, e.g. -123456 -> "-$1,234.56". */
export function formatCents(cents: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/** Format signed cents for a CSV cell: plain, unambiguous, no symbols. */
export function centsToCsvString(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Sum cents safely. Integer addition, so no accumulation error. */
export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
