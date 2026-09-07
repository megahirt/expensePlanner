/**
 * Deterministic, content-addressed transaction ids.
 *
 * This is the mechanism that makes re-importing overlapping data safe. The id of
 * a transaction is derived purely from its content, so the same real-world
 * transaction always hashes to the same id no matter how many times, or from how
 * many overlapping exports, you import it. Duplicate detection is then just a
 * primary-key lookup rather than fuzzy matching.
 *
 * The hash is 128-bit FNV-1a (two independent 64-bit passes with different
 * offset bases). It is not cryptographic — it doesn't need to be, since nothing
 * here is a security boundary — but at 128 bits the chance of a collision across
 * a lifetime of household transactions is negligible.
 */

const FNV_PRIME = 1099511628211n;
const FNV_OFFSET_A = 14695981039346656037n;
const FNV_OFFSET_B = 14695981039346656039n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(bytes: Uint8Array, offset: bigint): bigint {
  let hash = offset;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

const encoder = new TextEncoder();

/** 128-bit content hash of a string, as 32 lowercase hex characters. */
export function hash128(input: string): string {
  const bytes = encoder.encode(input);
  const a = fnv1a64(bytes, FNV_OFFSET_A);
  const b = fnv1a64(bytes, FNV_OFFSET_B);
  return a.toString(16).padStart(16, '0') + b.toString(16).padStart(16, '0');
}

/**
 * Field separator for hash keys: the ASCII Unit Separator, which cannot appear
 * in real source data. Joining with it means ('ab','c') and ('a','bc') can never
 * produce the same key.
 */
const SEP = String.fromCharCode(31);

function joinFields(parts: readonly (string | number)[]): string {
  return parts.map((p) => String(p).split(SEP).join('')).join(SEP);
}

/**
 * The id for a transaction.
 *
 * When the source provides a stable unique id (an OFX FITID, an Amazon order
 * number) we key on that, because it survives the bank rewording a description
 * between exports. Otherwise we key on the natural composite of
 * source + date + amount + normalized description, which is stable in practice
 * for the same reason a human recognises the row as the same one.
 */
export function transactionId(input: {
  sourceId: string;
  externalId?: string | null;
  date: string;
  amountCents: number;
  description: string;
  /** Distinguishes multiple identical rows in the same file (see below). */
  occurrence?: number;
}): string {
  const { sourceId, externalId, date, amountCents, description, occurrence = 0 } = input;
  const key = externalId
    ? joinFields(['ext', sourceId, externalId])
    : joinFields(['nat', sourceId, date, amountCents, normalizeDescription(description), occurrence]);
  return hash128(key);
}

/**
 * Two genuinely distinct charges can be identical in every field — two $5.00
 * coffees at the same shop on the same day. Content addressing would collapse
 * them into one and quietly lose a real expense, so the importer numbers
 * repeats within a single file and feeds that as `occurrence`. Re-importing the
 * same file reproduces the same numbering, so the ids still match; a file
 * containing three of them where we already have two adds exactly one row.
 */
export function assignOccurrences<T>(rows: readonly T[], keyOf: (row: T) => string): number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = keyOf(row);
    const next = seen.get(key) ?? 0;
    seen.set(key, next + 1);
    return next;
  });
}

/** Lowercase, collapse whitespace, drop punctuation noise. */
export function normalizeDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Reduce a raw bank description to a merchant name suitable for grouping and
 * rule matching.
 *
 * Card networks pad descriptions with payment-processor prefixes, store
 * numbers, cities, state codes, phone numbers and reference ids, all of which
 * vary between otherwise identical purchases. Stripping them is what lets one
 * rule cover every Trader Joe's visit instead of one rule per store number.
 */
export function normalizeMerchant(description: string): string {
  let s = description.trim();

  // Payment-processor prefixes: SQ *COFFEE, TST* DINER, PP*STORE, PAYPAL *X.
  s = s.replace(/^(SQ|TST|PP|PAYPAL|SP|EIG|WPY|IC)\s*\*\s*/i, '');
  s = s.replace(/^(PAYPAL|SQUARE|TOAST)\s+/i, '');

  // Amazon's many faces, normalized to one merchant.
  if (/\b(amzn|amazon)\b/i.test(s)) {
    if (/\bprime\s*video\b/i.test(s)) return 'Amazon Prime Video';
    if (/\baws\b/i.test(s)) return 'Amazon Web Services';
    return 'Amazon';
  }

  // Trailing reference/transaction ids and long alphanumeric runs.
  s = s.replace(/\b[A-Z0-9]{10,}\b/g, ' ');
  s = s.replace(/#\s*\d+/g, ' ');

  // Phone numbers.
  s = s.replace(/\b\d{3}[- .]?\d{3}[- .]?\d{4}\b/g, ' ');

  // Dates embedded in descriptions.
  s = s.replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ');

  // Store numbers: "STORE 01234", "#1234".
  s = s.replace(/\b(store|str|no|num)\.?\s*\d+\b/gi, ' ');
  s = s.replace(/\s+\d{3,}\b/g, ' ');

  // Trailing "CITY ST". Card feeds overwhelmingly format descriptions as
  // MERCHANT CITY ST, and leaving the city in would split one merchant into one
  // entry per location — "Trader Joes Seattle" and "Trader Joes Portland" would
  // never group or share a rule, which defeats the point of normalizing at all.
  // So a valid trailing US state code takes the preceding word with it, but only
  // when at least two words survive; that guard keeps "THE DINER WA" from being
  // eroded down to "The". The cost is that a merchant whose real name ends in a
  // word before a state code ("BLUE BOTTLE COFFEE CA") loses that last word —
  // still unique and still consistent, which is what grouping needs, and the
  // user can override any merchant with a rule.
  s = stripTrailingLocation(s);

  s = s
    .replace(/[^A-Za-z0-9&'\-. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (s === '') return description.trim() || 'Unknown';
  return titleCase(s, description);
}

const US_STATE_CODES = new Set(
  ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO ' +
    'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU')
    .split(' '),
);

function stripTrailingLocation(input: string): string {
  const words = input.trim().split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  if (!last || !US_STATE_CODES.has(last.toUpperCase())) return input;

  words.pop();
  if (words.length >= 3) words.pop(); // drop the city too
  return words.join(' ');
}

/**
 * Title-case a merchant name.
 *
 * Bank feeds usually SHOUT EVERYTHING, so all-caps carries no signal there and
 * every word gets title-cased. When the original had mixed case, capitals were a
 * deliberate choice by the source, so short all-caps tokens (CVS, USPS, IKEA)
 * are preserved as written.
 */
function titleCase(s: string, original: string): string {
  const sourceWasAllCaps = original === original.toUpperCase();
  return s
    .split(' ')
    .map((word) => {
      if (!sourceWasAllCaps && word.length <= 4 && word === word.toUpperCase() && /[A-Z]/.test(word)) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/** Stable id for a CSV mapping profile, derived from its header row. */
export function headerHash(headers: readonly string[]): string {
  return hash128(headers.map((h) => h.trim().toLowerCase()).join(SEP));
}

/** Random id for records that aren't content-addressed (batches, rules, links). */
export function randomId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(16).slice(2).padStart(16, '0');
  return `${prefix}_${rand}`;
}
