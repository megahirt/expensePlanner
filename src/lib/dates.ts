/**
 * Date parsing and normalization.
 *
 * All dates are stored as ISO `YYYY-MM-DD` strings representing a calendar day,
 * never as timestamps. A transaction happened on a day, not at an instant, and
 * routing dates through `new Date()` is how "01/02/2025" silently becomes
 * January 1st in one timezone and January 2nd in another.
 */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Date formats we can parse, in the order we try to detect them. */
export const SUPPORTED_FORMATS = [
  'YYYY-MM-DD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM/DD/YY',
  'DD/MM/YY',
  'MM-DD-YYYY',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'MMM D, YYYY',
  'D MMM YYYY',
] as const;

export type DateFormat = (typeof SUPPORTED_FORMATS)[number];

export class DateParseError extends Error {
  constructor(public readonly input: string, format?: string) {
    super(`Could not read "${input}" as a date${format ? ` using ${format}` : ''}`);
    this.name = 'DateParseError';
  }
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse a date string with a known format into ISO `YYYY-MM-DD`. */
export function parseDate(input: string, format: DateFormat | string): string {
  const s = input.trim();
  if (s === '') throw new DateParseError(input, format);

  // Month-name formats are handled by pattern rather than by position.
  if (format === 'MMM D, YYYY' || format === 'D MMM YYYY') {
    const parsed = parseMonthNameDate(s);
    if (!parsed) throw new DateParseError(input, format);
    return parsed;
  }

  const parts = s.split(/[/\-.]/).map((p) => p.trim());
  if (parts.length !== 3) throw new DateParseError(input, format);

  const order = format.split(/[/\-.]/);
  if (order.length !== 3) throw new DateParseError(input, format);

  let year = 0;
  let month = 0;
  let day = 0;
  for (let i = 0; i < 3; i++) {
    const token = order[i]!;
    const value = Number(parts[i]);
    if (!Number.isInteger(value)) throw new DateParseError(input, format);
    if (token.startsWith('Y')) year = token.length === 2 ? expandTwoDigitYear(value) : value;
    else if (token.startsWith('M')) month = value;
    else if (token.startsWith('D')) day = value;
  }

  return assembleIso(year, month, day, input, format);
}

function parseMonthNameDate(s: string): string | null {
  // "Jan 5, 2025" / "January 5, 2025" / "5 Jan 2025"
  const m1 = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m1) {
    const month = MONTHS[m1[1]!.slice(0, 3).toLowerCase()];
    if (month) return assembleIso(Number(m1[3]), month, Number(m1[2]), s);
  }
  const m2 = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/);
  if (m2) {
    const month = MONTHS[m2[2]!.slice(0, 3).toLowerCase()];
    if (month) return assembleIso(Number(m2[3]), month, Number(m2[1]), s);
  }
  return null;
}

function assembleIso(year: number, month: number, day: number, input: string, format?: string): string {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) {
    throw new DateParseError(input, format);
  }
  // Reject impossible days (Feb 30) rather than silently rolling into March.
  if (day > daysInMonth(year, month)) throw new DateParseError(input, format);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Two-digit years: 70-99 => 1970-1999, 00-69 => 2000-2069. */
function expandTwoDigitYear(v: number): number {
  return v >= 70 ? 1900 + v : 2000 + v;
}

/**
 * Guess the date format used by a column of sample values.
 *
 * Returns the format that parses the most samples. Ties are broken toward the
 * earlier entry in SUPPORTED_FORMATS, which puts ISO and US-style first — the
 * right default for the US bank exports this tool targets. Crucially, a sample
 * containing a day > 12 disambiguates MM/DD from DD/MM, so a realistic column
 * usually resolves unambiguously; the UI still shows the guess for confirmation.
 */
export function detectDateFormat(samples: readonly string[]): DateFormat | null {
  const usable = samples.map((s) => s?.trim()).filter((s): s is string => Boolean(s));
  if (usable.length === 0) return null;

  let best: { format: DateFormat; score: number } | null = null;
  for (const format of SUPPORTED_FORMATS) {
    let score = 0;
    for (const sample of usable) {
      try {
        parseDate(sample, format);
        score++;
      } catch {
        /* not this format */
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { format, score };
  }

  // Require the winner to handle every sample; a partial match means we guessed
  // wrong and should ask rather than corrupt half the rows.
  if (!best || best.score < usable.length) return best && best.score === usable.length ? best.format : null;
  return best.format;
}

/** Days between two ISO dates (absolute). */
export function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/** `YYYY-MM` bucket key for monthly grouping. */
export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Today as ISO `YYYY-MM-DD` in the user's local timezone. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** First day of the month `offset` months before `from`. */
export function monthStart(from: string, offset = 0): string {
  const year = Number(from.slice(0, 4));
  const month = Number(from.slice(5, 7)) - 1 - offset;
  const d = new Date(Date.UTC(year, month, 1));
  return d.toISOString().slice(0, 10);
}
