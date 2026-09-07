/**
 * Merging another install's data into this one.
 *
 * This is how a household gets one combined view without a server, an account
 * or any data leaving either machine: one person exports, the other imports.
 *
 * The merge runs through the *same* dedupe path as any other import, so
 * bringing in a file that overlaps what you already hold adds only what is
 * genuinely new, and is undoable as a batch like everything else.
 */

import { randomId } from '@/lib/ids';
import { parseCsvText } from '@/adapters/csv';
import { parseDate } from '@/lib/dates';
import { parseMoneyToCents } from '@/lib/money';
import { putCategories, putImportBatch, putRules, upsertTransactions } from '@/lib/db';
import type {
  Category,
  ImportBatch,
  ImportStats,
  ItemStatus,
  Rule,
  Transaction,
} from '@/types/models';
import { emptyStats } from '@/types/models';
import type { BackupFile } from './backup';
import { EXPORT_COLUMNS } from './exportCsv';

export interface MergeResult {
  stats: ImportStats;
  batch: ImportBatch;
  /** Rules that could not be merged because a different rule owns that order. */
  ruleConflicts: Array<{ incoming: Rule; existing: Rule }>;
  categoriesAdded: number;
  rulesAdded: number;
}

/** Is this CSV one of ours (and therefore carries categories and decisions)? */
export function looksLikeOurExport(headers: readonly string[]): boolean {
  const lower = new Set(headers.map((h) => h.trim().toLowerCase()));
  return lower.has('transaction_id') && lower.has('effective_amount') && lower.has('category');
}

/**
 * Rebuild transactions from one of our own CSV exports.
 *
 * Our export carries `transaction_id`, so merged rows keep the identity they
 * had in the other install and dedupe exactly rather than approximately. Rows
 * exploded to one line per item are collapsed back to one transaction.
 */
export function transactionsFromOurCsv(
  text: string,
  categories: readonly Category[],
): { transactions: Transaction[]; errors: string[] } {
  const parsed = parseCsvText(text);
  const errors: string[] = [];
  const byId = new Map<string, Transaction>();

  const categoryIdByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id] as const));

  parsed.records.forEach((record, i) => {
    const rowNumber = i + 2;
    try {
      const id = record['transaction_id'];
      if (!id) throw new Error('no transaction_id');
      // An exploded export repeats the transaction across item rows; the first
      // occurrence carries everything we need.
      if (byId.has(id)) return;

      const dateRaw = record['date'] ?? '';
      const date = parseDate(dateRaw, 'YYYY-MM-DD');
      const amountCents = parseMoneyToCents(record['amount'] ?? '0');
      const refundedCents = Math.abs(parseMoneyToCents(record['refunded'] ?? '0'));

      const categoryName = (record['category'] ?? '').trim();
      const categoryId = categoryName ? (categoryIdByName.get(categoryName.toLowerCase()) ?? null) : null;

      const tags = (record['tags'] ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean);

      const transaction: Transaction = {
        id,
        sourceId: record['source'] || 'merged',
        accountLabel: record['account'] || 'Merged',
        date,
        description: record['description'] ?? '',
        merchant: record['merchant'] || record['description'] || 'Unknown',
        amountCents,
        currency: record['currency'] || 'USD',
        categoryId,
        // The other person's categorization is a decision, not a guess, so it
        // is preserved as such and protected from later rule runs here too.
        categorySource: record['category_source'] === 'manual' ? 'manual' : 'imported',
        status: (record['status'] as ItemStatus) || 'delivered',
        refundedCents,
        batchId: '',
        importedAt: Date.now(),
      };
      if (record['notes']) transaction.notes = record['notes'];
      if (tags.length > 0) transaction.tags = tags;
      if (record['order_id']) transaction.externalId = record['order_id'];

      byId.set(id, transaction);
    } catch (err) {
      errors.push(`Row ${rowNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { transactions: [...byId.values()], errors };
}

/** Merge a parsed backup file into this install. */
export async function mergeBackup(
  file: BackupFile,
  existing: { categories: readonly Category[]; rules: readonly Rule[] },
): Promise<MergeResult> {
  const batchId = randomId('batch');
  const startedAt = Date.now();

  // Categories first, so incoming transactions can reference them.
  const existingCategoryIds = new Set(existing.categories.map((c) => c.id));
  const newCategories = file.categories.filter((c) => !existingCategoryIds.has(c.id));
  if (newCategories.length > 0) await putCategories(newCategories);

  // Rules are merged by id. Where the same id exists we keep ours and report
  // the conflict rather than silently replacing a rule the user may have
  // tuned — a rules engine you cannot trust is worse than no rules engine.
  const existingRulesById = new Map(existing.rules.map((r) => [r.id, r] as const));
  const ruleConflicts: MergeResult['ruleConflicts'] = [];
  const rulesToAdd: Rule[] = [];
  let nextOrder = existing.rules.reduce((max, r) => Math.max(max, r.order), 0) + 1;

  for (const incoming of file.rules) {
    const clash = existingRulesById.get(incoming.id);
    if (clash) {
      if (JSON.stringify(clash.matchers) !== JSON.stringify(incoming.matchers) || clash.categoryId !== incoming.categoryId) {
        ruleConflicts.push({ incoming, existing: clash });
      }
      continue;
    }
    rulesToAdd.push({ ...incoming, order: nextOrder++ });
  }
  if (rulesToAdd.length > 0) await putRules(rulesToAdd);

  const stamped = file.transactions.map((t) => ({ ...t, batchId }));
  const result = await upsertTransactions(stamped);

  const stats: ImportStats = {
    ...emptyStats(),
    read: file.transactions.length,
    added: result.added.length,
    duplicates: result.duplicates.length,
    updated: result.updated.length,
  };

  const batch: ImportBatch = {
    id: batchId,
    sourceId: 'merge',
    adapterId: 'merge',
    label: `Merged from ${file.profileLabel || 'another install'}`,
    startedAt,
    finishedAt: Date.now(),
    stats,
    createdIds: result.added,
    updatedBefore: result.updated.map((u) => ({ id: u.id, ...u.before })),
  };
  await putImportBatch(batch);

  return {
    stats,
    batch,
    ruleConflicts,
    categoriesAdded: newCategories.length,
    rulesAdded: rulesToAdd.length,
  };
}

/** Merge transactions read from one of our CSV exports. */
export async function mergeOurCsv(
  transactions: readonly Transaction[],
  label: string,
  parseErrors: readonly string[] = [],
): Promise<{ stats: ImportStats; batch: ImportBatch }> {
  const batchId = randomId('batch');
  const startedAt = Date.now();

  const stamped = transactions.map((t) => ({ ...t, batchId }));
  const result = await upsertTransactions(stamped);

  const stats: ImportStats = {
    ...emptyStats(),
    read: transactions.length + parseErrors.length,
    added: result.added.length,
    duplicates: result.duplicates.length,
    updated: result.updated.length,
    skipped: parseErrors.length,
    errors: [...parseErrors],
  };

  const batch: ImportBatch = {
    id: batchId,
    sourceId: 'merge',
    adapterId: 'merge-csv',
    label,
    startedAt,
    finishedAt: Date.now(),
    stats,
    createdIds: result.added,
    updatedBefore: result.updated.map((u) => ({ id: u.id, ...u.before })),
  };
  await putImportBatch(batch);

  return { stats, batch };
}

export { EXPORT_COLUMNS };
