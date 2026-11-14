/**
 * IndexedDB storage.
 *
 * Everything lives on this machine, in this Chrome profile. There is no server,
 * no account and no sync — moving data between installs is an explicit export
 * and import (see `transfer/`).
 *
 * IndexedDB rather than chrome.storage.local because we need indexed range
 * queries by date and by source over tens of thousands of rows, and because
 * chrome.storage.local's quota and whole-object read/write model make it a poor
 * fit for a growing transaction ledger.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Category,
  ImportBatch,
  Rule,
  Settings,
  SourceRecord,
  Transaction,
  TransactionLink,
} from '@/types/models';
import { defaultSettings } from '@/types/models';

export const DB_NAME = 'expenseplanner';
export const DB_VERSION = 1;

interface ExpenseDB extends DBSchema {
  transactions: {
    key: string;
    value: Transaction;
    indexes: {
      'by-date': string;
      'by-source': string;
      'by-category': string;
      'by-merchant': string;
      'by-batch': string;
      'by-external': string;
    };
  };
  categories: { key: string; value: Category };
  rules: { key: string; value: Rule; indexes: { 'by-order': number } };
  sources: { key: string; value: SourceRecord; indexes: { 'by-header': string } };
  links: {
    key: string;
    value: TransactionLink;
    indexes: { 'by-canonical': string; 'by-linked': string; 'by-status': string };
  };
  importBatches: { key: string; value: ImportBatch; indexes: { 'by-started': number } };
  settings: { key: string; value: Settings };
}

export type ExpenseDatabase = IDBPDatabase<ExpenseDB>;

let dbPromise: Promise<ExpenseDatabase> | null = null;

export function getDb(): Promise<ExpenseDatabase> {
  if (!dbPromise) {
    dbPromise = openDB<ExpenseDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const tx = db.createObjectStore('transactions', { keyPath: 'id' });
          tx.createIndex('by-date', 'date');
          tx.createIndex('by-source', 'sourceId');
          tx.createIndex('by-category', 'categoryId');
          tx.createIndex('by-merchant', 'merchant');
          tx.createIndex('by-batch', 'batchId');
          tx.createIndex('by-external', 'externalId');

          db.createObjectStore('categories', { keyPath: 'id' });

          const rules = db.createObjectStore('rules', { keyPath: 'id' });
          rules.createIndex('by-order', 'order');

          const sources = db.createObjectStore('sources', { keyPath: 'id' });
          sources.createIndex('by-header', 'headerHash');

          const links = db.createObjectStore('links', { keyPath: 'id' });
          links.createIndex('by-canonical', 'canonicalId');
          links.createIndex('by-linked', 'linkedId');
          links.createIndex('by-status', 'status');

          const batches = db.createObjectStore('importBatches', { keyPath: 'id' });
          batches.createIndex('by-started', 'startedAt');

          db.createObjectStore('settings', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

/** Test hook: drop the cached connection so a fresh DB can be opened. */
export function resetDbCache(): void {
  dbPromise = null;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export async function getTransaction(id: string): Promise<Transaction | undefined> {
  return (await getDb()).get('transactions', id);
}

export async function getAllTransactions(): Promise<Transaction[]> {
  return (await getDb()).getAll('transactions');
}

export async function countTransactions(): Promise<number> {
  return (await getDb()).count('transactions');
}

export async function getTransactionsInRange(fromIso: string, toIso: string): Promise<Transaction[]> {
  const db = await getDb();
  return db.getAllFromIndex('transactions', 'by-date', IDBKeyRange.bound(fromIso, toIso));
}

export async function putTransaction(t: Transaction): Promise<void> {
  await (await getDb()).put('transactions', t);
}

export async function deleteTransactions(ids: readonly string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('transactions', 'readwrite');
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}

/**
 * Fields a re-import is allowed to overwrite on a row that already exists.
 *
 * The complement of this list is what makes refreshing safe: a category you
 * assigned by hand, a note you wrote, tags, and confirmed links all survive
 * re-importing the same transaction. Losing hand-categorization every time you
 * pulled fresh data would make the tool actively worse than a spreadsheet.
 */
const REFRESHABLE_FIELDS = [
  'status',
  'statusRaw',
  'refundedCents',
  'items',
  'description',
  'merchant',
  'amountCents',
  'accountLabel',
  'raw',
] as const satisfies readonly (keyof Transaction)[];

export interface UpsertResult {
  added: string[];
  updated: Array<{ id: string; before: Partial<Transaction> }>;
  duplicates: string[];
}

/**
 * Insert new transactions and refresh existing ones without clobbering user
 * decisions.
 *
 * A row whose id we already hold is *not* a problem to report — it is the
 * expected outcome of importing an overlapping date range, and is counted as a
 * duplicate. If its refreshable fields changed (an Amazon order that has since
 * been returned, a pending charge that posted) we update just those and record
 * the previous values so the batch can be undone.
 */
export async function upsertTransactions(incoming: readonly Transaction[]): Promise<UpsertResult> {
  const db = await getDb();
  const tx = db.transaction('transactions', 'readwrite');
  const result: UpsertResult = { added: [], updated: [], duplicates: [] };

  for (const row of incoming) {
    const existing = await tx.store.get(row.id);
    if (!existing) {
      await tx.store.put(row);
      result.added.push(row.id);
      continue;
    }

    const before: Partial<Transaction> = {};
    const merged: Transaction = { ...existing };
    let changed = false;

    for (const field of REFRESHABLE_FIELDS) {
      const next = row[field];
      if (next === undefined) continue;
      if (JSON.stringify(existing[field]) === JSON.stringify(next)) continue;
      (before as unknown as Record<string, unknown>)[field] = existing[field];
      (merged as unknown as Record<string, unknown>)[field] = next;
      changed = true;
    }

    // A rule-assigned category may be refreshed by a later rule run, but a
    // manual assignment is the user's decision and is never overwritten here.
    // Neither is one taken from a matched Amazon order in Review, which knows
    // more about the purchase than a card description ever can.
    const settled = existing.categorySource === 'manual' || existing.categorySource === 'linked';
    const differs =
      row.categoryId !== existing.categoryId ||
      row.categorySource !== existing.categorySource ||
      row.categoryReason !== existing.categoryReason;
    if (!settled && row.categoryId && differs) {
      before.categoryId = existing.categoryId;
      before.categorySource = existing.categorySource;
      merged.categoryId = row.categoryId;
      merged.categorySource = row.categorySource;
      if (row.categoryReason !== undefined) merged.categoryReason = row.categoryReason;
      else delete merged.categoryReason;
      changed = true;
    }

    if (changed) {
      await tx.store.put(merged);
      result.updated.push({ id: row.id, before });
    } else {
      result.duplicates.push(row.id);
    }
  }

  await tx.done;
  return result;
}

/** The fields a person edits by hand. Imports never write these. */
export interface UserEditableFields {
  categoryId: string | null;
  categorySource: 'manual';
  notes: string;
  tags: string[];
}

/**
 * Apply a user's own edits to a transaction.
 *
 * Deliberately separate from `upsertTransactions`: imports refresh facts that
 * came from the source, people record decisions. Keeping the two on different
 * paths is what makes it structurally impossible for a refresh to overwrite a
 * judgement call.
 */
export async function updateUserFields(
  id: string,
  patch: Partial<UserEditableFields>,
): Promise<Transaction | undefined> {
  const db = await getDb();
  const tx = db.transaction('transactions', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    return undefined;
  }
  const updated: Transaction = { ...existing, ...patch };
  if (patch.categoryId !== undefined) updated.categorySource = 'manual';
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

/** Apply the same category to many rows at once (bulk recategorize). */
export async function setCategoryForMany(ids: readonly string[], categoryId: string | null): Promise<number> {
  const db = await getDb();
  const tx = db.transaction('transactions', 'readwrite');
  let changed = 0;
  for (const id of ids) {
    const existing = await tx.store.get(id);
    if (!existing) continue;
    await tx.store.put({ ...existing, categoryId, categorySource: 'manual' });
    changed++;
  }
  await tx.done;
  return changed;
}

// ---------------------------------------------------------------------------
// Categories, rules, sources, links, batches, settings
// ---------------------------------------------------------------------------

export async function getCategories(): Promise<Category[]> {
  return (await getDb()).getAll('categories');
}

export async function putCategory(c: Category): Promise<void> {
  await (await getDb()).put('categories', c);
}

export async function putCategories(list: readonly Category[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('categories', 'readwrite');
  await Promise.all(list.map((c) => tx.store.put(c)));
  await tx.done;
}

export async function deleteCategory(id: string): Promise<void> {
  await (await getDb()).delete('categories', id);
}

export async function getRules(): Promise<Rule[]> {
  const rules = await (await getDb()).getAll('rules');
  return rules.sort((a, b) => a.order - b.order);
}

export async function putRule(r: Rule): Promise<void> {
  await (await getDb()).put('rules', r);
}

export async function putRules(list: readonly Rule[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('rules', 'readwrite');
  await Promise.all(list.map((r) => tx.store.put(r)));
  await tx.done;
}

export async function deleteRule(id: string): Promise<void> {
  await (await getDb()).delete('rules', id);
}

export async function getSources(): Promise<SourceRecord[]> {
  return (await getDb()).getAll('sources');
}

export async function getSource(id: string): Promise<SourceRecord | undefined> {
  return (await getDb()).get('sources', id);
}

/** Find a saved CSV mapping profile by the shape of the file's header row. */
export async function findSourceByHeaderHash(hash: string): Promise<SourceRecord | undefined> {
  const matches = await (await getDb()).getAllFromIndex('sources', 'by-header', hash);
  return matches[0];
}

export async function putSource(s: SourceRecord): Promise<void> {
  await (await getDb()).put('sources', s);
}

export async function deleteSource(id: string): Promise<void> {
  await (await getDb()).delete('sources', id);
}

export async function getLinks(): Promise<TransactionLink[]> {
  return (await getDb()).getAll('links');
}

export async function putLink(l: TransactionLink): Promise<void> {
  await (await getDb()).put('links', l);
}

export async function putLinks(list: readonly TransactionLink[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('links', 'readwrite');
  await Promise.all(list.map((l) => tx.store.put(l)));
  await tx.done;
}

export async function deleteLink(id: string): Promise<void> {
  await (await getDb()).delete('links', id);
}

export async function getImportBatches(): Promise<ImportBatch[]> {
  const all = await (await getDb()).getAll('importBatches');
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getImportBatch(id: string): Promise<ImportBatch | undefined> {
  return (await getDb()).get('importBatches', id);
}

export async function putImportBatch(b: ImportBatch): Promise<void> {
  await (await getDb()).put('importBatches', b);
}

export async function deleteImportBatch(id: string): Promise<void> {
  await (await getDb()).delete('importBatches', id);
}

export async function getSettings(): Promise<Settings> {
  const stored = await (await getDb()).get('settings', 'settings');
  return stored ?? defaultSettings();
}

export async function putSettings(s: Settings): Promise<void> {
  await (await getDb()).put('settings', s);
}

/**
 * Undo an import batch: remove the rows it created and restore the prior values
 * of the rows it updated. Rows that merely matched (duplicates) are untouched,
 * because this batch is not what put them there.
 */
export async function undoImportBatch(batchId: string): Promise<{ removed: number; restored: number }> {
  const batch = await getImportBatch(batchId);
  if (!batch) return { removed: 0, restored: 0 };

  const db = await getDb();
  const tx = db.transaction('transactions', 'readwrite');

  let removed = 0;
  for (const id of batch.createdIds) {
    const existing = await tx.store.get(id);
    if (existing && existing.batchId === batchId) {
      await tx.store.delete(id);
      removed++;
    }
  }

  let restored = 0;
  for (const prior of batch.updatedBefore ?? []) {
    const current = await tx.store.get(prior.id);
    if (!current) continue;
    await tx.store.put({ ...current, ...prior } as Transaction);
    restored++;
  }

  await tx.done;
  await deleteImportBatch(batchId);
  return { removed, restored };
}

/** Wipe everything. Used by "start over" and by the export round-trip test. */
export async function clearAllData(): Promise<void> {
  const db = await getDb();
  const stores = ['transactions', 'categories', 'rules', 'sources', 'links', 'importBatches'] as const;
  const tx = db.transaction(stores, 'readwrite');
  await Promise.all(stores.map((s) => tx.objectStore(s).clear()));
  await tx.done;
}
