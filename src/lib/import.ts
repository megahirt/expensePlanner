/**
 * The import pipeline.
 *
 * Every source — CSV file, Amazon scrape, a merge of someone else's export —
 * lands through this one function. Writing dedupe, batching, categorization and
 * undo once means a new adapter inherits all of it, and means the safety
 * properties can be reasoned about in a single place.
 */

import { assignOccurrences, normalizeMerchant, randomId, transactionId } from '@/lib/ids';
import {
  putImportBatch,
  putSource,
  upsertTransactions,
  type UpsertResult,
} from '@/lib/db';
import type {
  Category,
  ImportBatch,
  ImportStats,
  Rule,
  SourceRecord,
  Transaction,
} from '@/types/models';
import { emptyStats } from '@/types/models';
import type { RawTransaction } from '@/adapters/types';
import { classify } from '@/categorize/engine';

export interface ImportOptions {
  sourceId: string;
  adapterId: string;
  /** Shown in import history, e.g. the file name or "Amazon 2025". */
  label: string;
  rules: readonly Rule[];
  categories: readonly Category[];
  /** Persist/refresh the source record (CSV mapping profile). */
  source?: SourceRecord;
}

export interface ImportOutcome {
  batch: ImportBatch;
  stats: ImportStats;
  /** The rows as they were written, for immediate display. */
  transactions: Transaction[];
}

/**
 * Convert adapter output into stored transactions.
 *
 * The occurrence numbering here is what keeps two genuinely identical charges
 * on the same day from collapsing into one row, while still producing identical
 * ids when the same file is imported again.
 */
export function toTransactions(
  raw: readonly RawTransaction[],
  opts: { sourceId: string; batchId: string; rules: readonly Rule[]; categories: readonly Category[] },
): Transaction[] {
  const occurrences = assignOccurrences(raw, (r) =>
    // External ids are unique on their own, so they never need disambiguating.
    r.externalId ? `ext:${r.externalId}` : `${r.date}|${r.amountCents}|${r.description}`,
  );

  const importedAt = Date.now();

  return raw.map((row, i) => {
    const merchant = row.merchant ?? normalizeMerchant(row.description);
    const id = transactionId({
      sourceId: opts.sourceId,
      externalId: row.externalId ?? null,
      date: row.date,
      amountCents: row.amountCents,
      description: row.description,
      occurrence: occurrences[i] ?? 0,
    });

    const base: Transaction = {
      id,
      sourceId: opts.sourceId,
      accountLabel: row.accountLabel ?? 'Imported',
      date: row.date,
      description: row.description,
      merchant,
      amountCents: row.amountCents,
      currency: row.currency ?? 'USD',
      categoryId: null,
      categorySource: 'default',
      status: row.status ?? 'delivered',
      refundedCents: row.refundedCents ?? 0,
      batchId: opts.batchId,
      importedAt,
    };
    if (row.statusRaw !== undefined) base.statusRaw = row.statusRaw;
    if (row.externalId !== undefined) base.externalId = row.externalId;
    if (row.items !== undefined) base.items = row.items;
    if (row.raw !== undefined) base.raw = row.raw;

    const match = classify(base, opts.rules, opts.categories);
    if (match) {
      base.categoryId = match.categoryId;
      base.categorySource = match.source;
      base.categoryReason = match.reason;
    }

    return base;
  });
}

/**
 * Run an import: normalize, dedupe against what we already hold, and record a
 * reversible batch.
 *
 * Duplicates are an expected outcome, not a failure — importing the last 90
 * days when only the last 30 are new is the normal monthly workflow, and the
 * summary reports it plainly rather than treating it as a problem.
 */
export async function runImport(
  raw: readonly RawTransaction[],
  opts: ImportOptions,
  parseErrors: readonly string[] = [],
): Promise<ImportOutcome> {
  const batchId = randomId('batch');
  const startedAt = Date.now();

  const transactions = toTransactions(raw, {
    sourceId: opts.sourceId,
    batchId,
    rules: opts.rules,
    categories: opts.categories,
  });

  const result: UpsertResult = await upsertTransactions(transactions);

  const stats: ImportStats = {
    ...emptyStats(),
    read: raw.length + parseErrors.length,
    added: result.added.length,
    duplicates: result.duplicates.length,
    updated: result.updated.length,
    skipped: parseErrors.length,
    errors: [...parseErrors],
  };

  const batch: ImportBatch = {
    id: batchId,
    sourceId: opts.sourceId,
    adapterId: opts.adapterId,
    label: opts.label,
    startedAt,
    finishedAt: Date.now(),
    stats,
    createdIds: result.added,
    updatedBefore: result.updated.map((u) => ({ id: u.id, ...u.before })),
  };

  await putImportBatch(batch);

  if (opts.source) {
    await putSource({ ...opts.source, lastImportAt: Date.now() });
  }

  return { batch, stats, transactions };
}

/** One-line, plain-language summary of an import. */
export function summarizeImport(stats: ImportStats): string {
  const parts = [`${stats.read} rows read`, `${stats.added} added`];
  if (stats.duplicates > 0) parts.push(`${stats.duplicates} already present`);
  if (stats.updated > 0) parts.push(`${stats.updated} updated`);
  if (stats.needsReview > 0) parts.push(`${stats.needsReview} needing review`);
  if (stats.skipped > 0) parts.push(`${stats.skipped} could not be read`);
  return parts.join(' → ').replace(' → ', ' → ');
}
