/**
 * Export everything to one flat CSV.
 *
 * The point of exporting is not just to get the rows out — it is to get the
 * *work* out. Categories, notes, tags and the returned/refunded state all
 * travel with the data, so a spreadsheet or another budgeting tool sees the
 * decisions you made rather than a pile of raw descriptions.
 *
 * The file is also re-importable by this extension, which is how two installs
 * merge into a household view.
 */

import { centsToCsvString } from '@/lib/money';
import { effectiveCents, type Category, type Transaction } from '@/types/models';

/** Column order of the export. Stable: other tools may depend on it. */
export const EXPORT_COLUMNS = [
  'date',
  'source',
  'account',
  'profile',
  'description',
  'merchant',
  'amount',
  'refunded',
  'effective_amount',
  'currency',
  'category',
  'category_source',
  'status',
  'notes',
  'tags',
  'order_id',
  'item_name',
  'item_quantity',
  'item_amount',
  'item_status',
  'item_refunded',
  'transaction_id',
] as const;

export interface ExportOptions {
  /** One row per item for orders that have them, instead of one row per order. */
  explodeItems: boolean;
  /** Written into every row so a merged household view knows whose data it is. */
  profileLabel: string;
  categories: readonly Category[];
}

/**
 * RFC 4180 quoting.
 *
 * A merchant called `O'Brien, Ltd "The Shop"` and a note containing a newline
 * both have to survive the round trip, and a naive join would corrupt the file
 * in a way that is not obvious until someone opens it months later.
 */
export function csvEscape(value: string): string {
  if (value === '') return '';
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function row(values: readonly string[]): string {
  return values.map(csvEscape).join(',');
}

/** Build the CSV text for a set of transactions. */
export function buildCsv(transactions: readonly Transaction[], options: ExportOptions): string {
  const categoryNames = new Map(options.categories.map((c) => [c.id, c.name] as const));
  const lines: string[] = [row([...EXPORT_COLUMNS])];

  for (const t of transactions) {
    const base = [
      t.date,
      t.sourceId,
      t.accountLabel,
      options.profileLabel,
      t.description,
      t.merchant,
      centsToCsvString(t.amountCents),
      centsToCsvString(t.refundedCents),
      centsToCsvString(effectiveCents(t)),
      t.currency,
      t.categoryId ? (categoryNames.get(t.categoryId) ?? t.categoryId) : '',
      t.categorySource,
      t.status,
      t.notes ?? '',
      (t.tags ?? []).join('; '),
      t.externalId ?? '',
    ];

    if (options.explodeItems && t.items && t.items.length > 0) {
      for (const item of t.items) {
        lines.push(
          row([
            ...base,
            item.name,
            String(item.quantity),
            centsToCsvString(-item.amountCents),
            item.status,
            centsToCsvString(item.refundedCents),
            t.id,
          ]),
        );
      }
    } else {
      lines.push(row([...base, '', '', '', '', '', t.id]));
    }
  }

  // A UTF-8 BOM so Excel reads accented merchant names correctly instead of
  // mangling them, and CRLF line endings per RFC 4180.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Suggested file name, dated so successive exports do not overwrite. */
export function csvFileName(now = new Date()): string {
  return `expenseplanner-${now.toISOString().slice(0, 10)}.csv`;
}
