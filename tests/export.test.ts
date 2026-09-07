import { beforeEach, describe, expect, it } from 'vitest';
import { buildCsv, csvEscape, EXPORT_COLUMNS } from '@/transfer/exportCsv';
import { buildBackup, BackupParseError, parseBackup } from '@/transfer/backup';
import { looksLikeOurExport, mergeBackup, mergeOurCsv, transactionsFromOurCsv } from '@/transfer/merge';
import { parseCsvText } from '@/adapters/csv';
import { clearAllData, countTransactions, getAllTransactions, getTransaction, upsertTransactions } from '@/lib/db';
import { DEFAULT_CATEGORIES, defaultRules } from '@/categorize/defaults';
import { defaultSettings, type Transaction } from '@/types/models';

function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    sourceId: 'csv:bank',
    accountLabel: 'Schwab Checking',
    date: '2025-03-04',
    description: 'TRADER JOES #123',
    merchant: 'Trader Joes',
    amountCents: -4599,
    currency: 'USD',
    categoryId: 'cat-groceries',
    categorySource: 'manual',
    status: 'delivered',
    refundedCents: 0,
    batchId: 'b',
    importedAt: 1,
    ...over,
  };
}

const opts = { explodeItems: false, profileLabel: 'chris', categories: DEFAULT_CATEGORIES };

describe('csvEscape', () => {
  it('quotes the characters that would otherwise corrupt the file', () => {
    // A merchant with a comma or quote, or a note with a newline, must survive
    // the round trip — a naive join breaks the file in a way nobody notices
    // until they open it months later.
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('O’Brien, Ltd')).toBe('"O’Brien, Ltd"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line one\nline two')).toBe('"line one\nline two"');
  });
});

describe('buildCsv', () => {
  it('writes the decisions, not just the rows', () => {
    const csv = buildCsv([txn({ notes: 'split with Sam', tags: ['reimbursable'] })], opts);
    const parsed = parseCsvText(csv);

    expect(parsed.headers).toEqual([...EXPORT_COLUMNS]);
    expect(parsed.records[0]).toMatchObject({
      date: '2025-03-04',
      merchant: 'Trader Joes',
      amount: '-45.99',
      category: 'Groceries',
      category_source: 'manual',
      notes: 'split with Sam',
      tags: 'reimbursable',
      profile: 'chris',
    });
  });

  it('records what a row is actually worth alongside its face value', () => {
    // $89 charged, $82 refunded: a spreadsheet should be able to sum the real
    // $7 without having to redo the returns logic itself.
    const csv = buildCsv([txn({ amountCents: -8900, refundedCents: 8200, status: 'returned' })], opts);
    const record = parseCsvText(csv).records[0]!;

    expect(record['amount']).toBe('-89.00');
    expect(record['refunded']).toBe('82.00');
    expect(record['effective_amount']).toBe('-7.00');
  });

  it('gives a cancelled order an effective value of zero', () => {
    const csv = buildCsv([txn({ amountCents: -12999, status: 'cancelled' })], opts);
    expect(parseCsvText(csv).records[0]?.['effective_amount']).toBe('0.00');
  });

  it('can explode an order into one row per item', () => {
    const withItems = txn({
      merchant: 'Amazon',
      items: [
        { name: 'Echo Dot', quantity: 1, amountCents: 4999, status: 'delivered', refundedCents: 0 },
        { name: 'USB-C Cable', quantity: 2, amountCents: 1422, status: 'returned', refundedCents: 1422 },
      ],
    });

    const flat = parseCsvText(buildCsv([withItems], opts)).records;
    expect(flat).toHaveLength(1);

    const exploded = parseCsvText(buildCsv([withItems], { ...opts, explodeItems: true })).records;
    expect(exploded).toHaveLength(2);
    expect(exploded[0]?.['item_name']).toBe('Echo Dot');
    expect(exploded[1]?.['item_status']).toBe('returned');
    expect(exploded[1]?.['item_refunded']).toBe('14.22');
  });

  it('starts with a BOM so Excel does not mangle accented names', () => {
    expect(buildCsv([txn({ merchant: 'Café Lumière' })], opts).charCodeAt(0)).toBe(0xfeff);
  });
});

describe('backup files', () => {
  const data = {
    profileLabel: 'chris',
    transactions: [txn()],
    categories: DEFAULT_CATEGORIES,
    rules: defaultRules().slice(0, 3),
    sources: [],
    links: [],
    batches: [],
    settings: defaultSettings(),
  };

  it('round-trips everything a CSV cannot carry', () => {
    const restored = parseBackup(buildBackup(data));
    expect(restored.transactions).toHaveLength(1);
    expect(restored.rules).toHaveLength(3);
    expect(restored.categories).toHaveLength(DEFAULT_CATEGORIES.length);
  });

  it('refuses files that are not backups instead of corrupting data', () => {
    expect(() => parseBackup('not json')).toThrow(BackupParseError);
    expect(() => parseBackup('{"hello":"world"}')).toThrow(BackupParseError);
    expect(() => parseBackup(JSON.stringify({ format: 'expenseplanner-backup', version: 99 }))).toThrow(
      /newer version/,
    );
  });
});

describe('export round trip', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  it('survives a full export, wipe and re-import', async () => {
    // The property that makes the export a real escape hatch rather than a
    // one-way door.
    const original = [
      txn({ id: 'a', notes: 'split with Sam', tags: ['reimbursable'] }),
      txn({ id: 'b', date: '2025-03-05', merchant: 'Shell Oil', amountCents: -5210, categoryId: 'cat-transport' }),
      txn({ id: 'c', amountCents: -8900, refundedCents: 8200, status: 'returned' }),
    ];
    await upsertTransactions(original);

    const csv = buildCsv(await getAllTransactions(), opts);
    await clearAllData();
    expect(await countTransactions()).toBe(0);

    const { transactions, errors } = transactionsFromOurCsv(csv, DEFAULT_CATEGORIES);
    expect(errors).toEqual([]);
    await mergeOurCsv(transactions, 'restore.csv');

    expect(await countTransactions()).toBe(3);
    const restored = await getTransaction('a');
    expect(restored).toMatchObject({
      date: '2025-03-04',
      merchant: 'Trader Joes',
      amountCents: -4599,
      categoryId: 'cat-groceries',
      notes: 'split with Sam',
      tags: ['reimbursable'],
    });
    expect((await getTransaction('c'))?.refundedCents).toBe(8200);
  });

  it('recognises its own export format', () => {
    const headers = parseCsvText(buildCsv([txn()], opts)).headers;
    expect(looksLikeOurExport(headers)).toBe(true);
    expect(looksLikeOurExport(['Date', 'Description', 'Amount'])).toBe(false);
  });
});

describe('merging two installs', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  it('adds only what this install does not already have', async () => {
    // Chris and his wife both shopped at Trader Joes on the same card; the
    // shared row must not be counted twice in the household view.
    const mine = [txn({ id: 'shared' }), txn({ id: 'mine-only', date: '2025-03-06' })];
    await upsertTransactions(mine);

    const theirs = parseBackup(
      buildBackup({
        profileLabel: 'partner',
        transactions: [txn({ id: 'shared' }), txn({ id: 'theirs-only', date: '2025-03-07' })],
        categories: DEFAULT_CATEGORIES,
        rules: [],
        sources: [],
        links: [],
        batches: [],
        settings: defaultSettings(),
      }),
    );

    const result = await mergeBackup(theirs, { categories: DEFAULT_CATEGORIES, rules: [] });

    expect(result.stats.added).toBe(1);
    expect(result.stats.duplicates).toBe(1);
    expect(await countTransactions()).toBe(3);
  });

  it('keeps the other person’s hand-categorization as a decision', async () => {
    const theirs = parseBackup(
      buildBackup({
        profileLabel: 'partner',
        transactions: [txn({ id: 't', categoryId: 'cat-kids', categorySource: 'manual' })],
        categories: DEFAULT_CATEGORIES,
        rules: [],
        sources: [],
        links: [],
        batches: [],
        settings: defaultSettings(),
      }),
    );
    await mergeBackup(theirs, { categories: DEFAULT_CATEGORIES, rules: [] });

    expect((await getTransaction('t'))?.categorySource).toBe('manual');
  });

  it('brings in new rules and reports conflicts instead of overwriting', async () => {
    const existingRule = { ...defaultRules()[0]!, categoryId: 'cat-groceries' };
    const clashing = { ...existingRule, categoryId: 'cat-shopping' };
    const brandNew = { ...defaultRules()[1]!, id: 'rule-theirs' };

    const theirs = parseBackup(
      buildBackup({
        profileLabel: 'partner',
        transactions: [],
        categories: [],
        rules: [clashing, brandNew],
        sources: [],
        links: [],
        batches: [],
        settings: defaultSettings(),
      }),
    );

    const result = await mergeBackup(theirs, { categories: DEFAULT_CATEGORIES, rules: [existingRule] });

    expect(result.rulesAdded).toBe(1);
    expect(result.ruleConflicts).toHaveLength(1);
    expect(result.ruleConflicts[0]?.existing.categoryId).toBe('cat-groceries');
  });

  it('brings across categories the other install invented', async () => {
    const custom = { id: 'cat-boat', name: 'Boat', color: '#123456' };
    const theirs = parseBackup(
      buildBackup({
        profileLabel: 'partner',
        transactions: [],
        categories: [...DEFAULT_CATEGORIES, custom],
        rules: [],
        sources: [],
        links: [],
        batches: [],
        settings: defaultSettings(),
      }),
    );

    const result = await mergeBackup(theirs, { categories: DEFAULT_CATEGORIES, rules: [] });
    expect(result.categoriesAdded).toBe(1);
  });
});
