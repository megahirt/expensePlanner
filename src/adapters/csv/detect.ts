/**
 * Working out what a bank's CSV actually contains.
 *
 * Every institution exports a different shape: one signed Amount column, or
 * separate Debit and Credit columns, or an Amount plus a Type column saying
 * DEBIT/CREDIT. Sign conventions are inconsistent too — some list spending as
 * positive, some as negative. Guessing wrong flips every number in the file, so
 * detection produces a proposal the user confirms in the mapping wizard rather
 * than something applied silently.
 */

import { detectDateFormat, type DateFormat } from '@/lib/dates';
import { parseMoneyToCents } from '@/lib/money';
import type { ColumnMapping } from '@/types/models';

/** Header names we recognise, in rough order of preference. */
const DATE_HEADERS = [
  'transaction date', 'posted date', 'post date', 'date', 'trans date',
  'transaction_date', 'posting date', 'effective date', 'settlement date',
];
const DESCRIPTION_HEADERS = [
  'description', 'payee', 'merchant', 'name', 'memo', 'details',
  'transaction description', 'original description', 'narrative',
];
const AMOUNT_HEADERS = ['amount', 'transaction amount', 'value', 'amt'];
const DEBIT_HEADERS = ['debit', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'charges'];
const CREDIT_HEADERS = ['credit', 'deposit', 'deposits', 'money in', 'paid in', 'payments'];
const ACCOUNT_HEADERS = ['account', 'account name', 'account number', 'card', 'card number'];
const EXTERNAL_ID_HEADERS = ['transaction id', 'reference', 'reference number', 'fitid', 'id', 'check number'];

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function findHeader(headers: readonly string[], candidates: readonly string[]): string | undefined {
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  for (const candidate of candidates) {
    const exact = normalized.find((h) => h.norm === candidate);
    if (exact) return exact.raw;
  }
  for (const candidate of candidates) {
    const partial = normalized.find((h) => h.norm.includes(candidate));
    if (partial) return partial.raw;
  }
  return undefined;
}

export interface DetectionResult {
  mapping: ColumnMapping | null;
  /** Human-readable notes shown in the wizard so the guess is inspectable. */
  notes: string[];
  /** Fields we could not determine; the wizard requires the user to fill these. */
  missing: string[];
}

/**
 * Propose a column mapping from a file's headers and sample rows.
 *
 * Sign convention is inferred from the data rather than assumed: in a typical
 * account statement spending outnumbers income, so whichever sign dominates the
 * amount column is taken to be spending. That is a heuristic, which is exactly
 * why the wizard shows it as a labelled toggle with a live preview.
 */
export function detectMapping(
  headers: readonly string[],
  rows: readonly string[][],
  defaults: { currency?: string; accountLabel?: string } = {},
): DetectionResult {
  const notes: string[] = [];
  const missing: string[] = [];

  const dateCol = findHeader(headers, DATE_HEADERS);
  const descCol = findHeader(headers, DESCRIPTION_HEADERS);
  const amountCol = findHeader(headers, AMOUNT_HEADERS);
  const debitCol = findHeader(headers, DEBIT_HEADERS);
  const creditCol = findHeader(headers, CREDIT_HEADERS);
  const accountCol = findHeader(headers, ACCOUNT_HEADERS);
  const externalIdCol = findHeader(headers, EXTERNAL_ID_HEADERS);

  if (!dateCol) missing.push('date');
  if (!descCol) missing.push('description');
  if (!amountCol && !(debitCol || creditCol)) missing.push('amount');

  const columnIndex = (name: string | undefined): number =>
    name === undefined ? -1 : headers.findIndex((h) => h === name);

  // Date format
  let dateFormat: DateFormat | null = null;
  if (dateCol) {
    const idx = columnIndex(dateCol);
    const samples = rows.map((r) => r[idx] ?? '').filter(Boolean);
    dateFormat = detectDateFormat(samples);
    if (dateFormat) notes.push(`Dates look like ${dateFormat}`);
    else {
      missing.push('dateFormat');
      notes.push('Could not tell the date format apart — please pick one.');
    }
  }

  // Sign convention
  let positiveMeansSpend = false;
  if (amountCol && !debitCol && !creditCol) {
    const idx = columnIndex(amountCol);
    let positives = 0;
    let negatives = 0;
    for (const row of rows) {
      try {
        const cents = parseMoneyToCents(row[idx] ?? '');
        if (cents > 0) positives++;
        else if (cents < 0) negatives++;
      } catch {
        /* unparseable sample; the wizard preview will show it */
      }
    }
    positiveMeansSpend = positives > negatives;
    notes.push(
      positiveMeansSpend
        ? 'Most amounts are positive, so positive is being read as money out.'
        : 'Negative amounts are being read as money out.',
    );
  } else if (debitCol || creditCol) {
    notes.push('Using separate debit and credit columns.');
  }

  if (missing.length > 0 || !dateCol || !descCol || !dateFormat) {
    return { mapping: null, notes, missing };
  }

  const mapping: ColumnMapping = {
    date: dateCol,
    description: descCol,
    dateFormat,
    positiveMeansSpend,
    currency: defaults.currency ?? 'USD',
  };
  if (amountCol) mapping.amount = amountCol;
  if (debitCol) mapping.debit = debitCol;
  if (creditCol) mapping.credit = creditCol;
  if (accountCol) mapping.accountLabel = accountCol;
  if (externalIdCol) mapping.externalId = externalIdCol;
  if (defaults.accountLabel) mapping.defaultAccountLabel = defaults.accountLabel;

  return { mapping, notes, missing: [] };
}
