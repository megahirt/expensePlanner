/**
 * Generic CSV adapter.
 *
 * One adapter handles any bank or card export, because the differences between
 * them are data (which column is the date, how negatives are written) rather
 * than code. The user maps the columns once per institution and the mapping is
 * saved against a hash of the header row, so the next export from the same bank
 * maps itself with no clicks.
 */

import Papa from 'papaparse';
import { parseDate } from '@/lib/dates';
import { parseMoneyToCents } from '@/lib/money';
import { normalizeMerchant } from '@/lib/ids';
import type { ColumnMapping } from '@/types/models';
import type { FileAdapter, ParseInput, RawTransaction } from '../types';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  /** Rows as objects, keyed by header. */
  records: Record<string, string>[];
  delimiter: string;
}

/** Parse CSV text into headers and rows, letting PapaParse sniff the delimiter. */
export function parseCsvText(text: string): ParsedCsv {
  // Strip a UTF-8 BOM; Excel writes one and it would otherwise become part of
  // the first header name, breaking every mapping lookup.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const result = Papa.parse<string[]>(cleaned.trim(), {
    skipEmptyLines: 'greedy',
    delimiter: '',
  });

  const all = (result.data as string[][]).filter((r) => r.some((c) => String(c).trim() !== ''));
  const headerRow = all[0] ?? [];
  return {
    headers: headerRow.map((h) => String(h).trim()),
    rows: all.slice(1),
    records: all.slice(1).map((row) => {
      const rec: Record<string, string> = {};
      headerRow.forEach((h, i) => {
        rec[String(h).trim()] = String(row[i] ?? '').trim();
      });
      return rec;
    }),
    delimiter: result.meta.delimiter ?? ',',
  };
}

export class CsvRowError extends Error {
  constructor(public readonly rowNumber: number, message: string) {
    super(`Row ${rowNumber}: ${message}`);
    this.name = 'CsvRowError';
  }
}

export interface CsvParseOutcome {
  rows: RawTransaction[];
  /** Rows we could not read, reported rather than dropped in silence. */
  errors: string[];
}

/**
 * Turn parsed CSV records into normalized transactions.
 *
 * A row that cannot be read is collected as an error rather than aborting the
 * import or being quietly skipped: importing 138 of 140 rows and saying so is
 * far more useful than failing the file outright, and far more honest than
 * pretending the file had 138 rows.
 */
export function rowsToTransactions(
  records: readonly Record<string, string>[],
  mapping: ColumnMapping,
): CsvParseOutcome {
  const rows: RawTransaction[] = [];
  const errors: string[] = [];

  records.forEach((record, i) => {
    const rowNumber = i + 2; // 1-based, plus the header row
    try {
      rows.push(recordToTransaction(record, mapping));
    } catch (err) {
      errors.push(`Row ${rowNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { rows, errors };
}

function recordToTransaction(record: Record<string, string>, mapping: ColumnMapping): RawTransaction {
  const rawDate = record[mapping.date] ?? '';
  if (!rawDate) throw new Error('no date');
  const date = parseDate(rawDate, mapping.dateFormat);

  const description = (record[mapping.description] ?? '').trim();

  const amountCents = readAmount(record, mapping);

  const accountLabel =
    (mapping.accountLabel ? record[mapping.accountLabel] : undefined)?.trim() ||
    mapping.defaultAccountLabel ||
    'Imported';

  const externalId = mapping.externalId ? record[mapping.externalId]?.trim() : undefined;

  return {
    date,
    description: description || '(no description)',
    merchant: normalizeMerchant(description),
    amountCents,
    currency: mapping.currency,
    accountLabel,
    ...(externalId ? { externalId } : {}),
    status: 'delivered',
    refundedCents: 0,
    raw: record,
  };
}

/**
 * Read a row's amount as signed cents, money out negative.
 *
 * Handles both shapes: a single signed column (whose convention the mapping
 * records) and separate debit/credit columns, where a value in the debit column
 * is spending regardless of how the bank wrote its sign.
 */
function readAmount(record: Record<string, string>, mapping: ColumnMapping): number {
  if (mapping.debit || mapping.credit) {
    const debitRaw = mapping.debit ? (record[mapping.debit] ?? '').trim() : '';
    const creditRaw = mapping.credit ? (record[mapping.credit] ?? '').trim() : '';

    if (debitRaw && creditRaw) {
      // Some exports put 0.00 in the unused column rather than leaving it blank.
      const debit = Math.abs(parseMoneyToCents(debitRaw));
      const credit = Math.abs(parseMoneyToCents(creditRaw));
      if (debit && !credit) return -debit;
      if (credit && !debit) return credit;
      if (!debit && !credit) throw new Error('debit and credit are both zero');
      throw new Error('both debit and credit have values');
    }
    if (debitRaw) return -Math.abs(parseMoneyToCents(debitRaw));
    if (creditRaw) return Math.abs(parseMoneyToCents(creditRaw));
    throw new Error('no debit or credit value');
  }

  if (!mapping.amount) throw new Error('no amount column mapped');
  const raw = (record[mapping.amount] ?? '').trim();
  if (!raw) throw new Error('no amount');
  const cents = parseMoneyToCents(raw);
  return mapping.positiveMeansSpend ? -cents : cents;
}

export const csvAdapter: FileAdapter = {
  id: 'csv',
  label: 'CSV file',
  kind: 'file',
  extensions: ['.csv', '.tsv', '.txt'],

  // The generic adapter is the fallback: it can handle anything with a
  // recognisable date column, but a bank-specific adapter should outrank it.
  sniff(headers) {
    return headers.length >= 2 ? 0.3 : 0;
  },

  async parse(input: ParseInput): Promise<RawTransaction[]> {
    const parsed = parseCsvText(input.text);
    const { rows, errors } = rowsToTransactions(parsed.records, input.mapping);
    if (errors.length > 0 && rows.length === 0) {
      throw new Error(`No rows could be read from ${input.fileName}. First problem: ${errors[0]}`);
    }
    return rows;
  },
};
