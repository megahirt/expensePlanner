import { beforeEach, describe, expect, it } from 'vitest';
import { parseCsvText, rowsToTransactions } from '@/adapters/csv';
import { detectMapping } from '@/adapters/csv/detect';
import { runImport, summarizeImport, toTransactions } from '@/lib/import';
import {
  clearAllData,
  countTransactions,
  getAllTransactions,
  getTransaction,
  undoImportBatch,
  updateUserFields,
} from '@/lib/db';
import { DEFAULT_CATEGORIES, defaultRules } from '@/categorize/defaults';

const RULES = defaultRules();
const CATEGORIES = DEFAULT_CATEGORIES;

function csvToRaw(text: string) {
  const parsed = parseCsvText(text);
  const { mapping } = detectMapping(parsed.headers, parsed.rows, { accountLabel: 'Checking' });
  if (!mapping) throw new Error('mapping not detected');
  return rowsToTransactions(parsed.records, mapping);
}

const importCsv = (text: string, label: string) => {
  const { rows, errors } = csvToRaw(text);
  return runImport(rows, {
    sourceId: 'csv:test-bank',
    adapterId: 'csv',
    label,
    rules: RULES,
    categories: CATEGORIES,
  }, errors);
};

const HEADER = 'Date,Description,Amount\n';
const JAN = '2025-01-10,TRADER JOES #123 SEATTLE WA,-45.99\n2025-01-11,SHELL OIL 574412,-52.10\n';
const FEB = '2025-02-10,STARBUCKS STORE 08812,-5.75\n2025-02-11,NETFLIX.COM,-15.49\n';
const MAR = '2025-03-10,COSTCO WHSE 0455,-142.88\n';

describe('overlapping re-imports', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  it('adds only genuinely new rows when ranges overlap', async () => {
    // The monthly workflow: download a wide window every time, because the bank
    // makes narrowing it tedious. Overlap must be free.
    const first = await importCsv(HEADER + JAN + FEB, 'jan-feb.csv');
    expect(first.stats.added).toBe(4);

    const second = await importCsv(HEADER + FEB + MAR, 'feb-mar.csv');

    expect(second.stats.added).toBe(1);
    expect(second.stats.duplicates).toBe(2);
    expect(await countTransactions()).toBe(5);
  });

  it('is completely idempotent when the same file is imported twice', async () => {
    await importCsv(HEADER + JAN + FEB, 'jan-feb.csv');
    const again = await importCsv(HEADER + JAN + FEB, 'jan-feb.csv');

    expect(again.stats.added).toBe(0);
    expect(again.stats.duplicates).toBe(4);
    expect(await countTransactions()).toBe(4);
  });

  it('keeps a hand-assigned category through a later overlapping import', async () => {
    // The single most important property of the whole pipeline: refreshing data
    // must never undo work the user did by hand.
    await importCsv(HEADER + JAN, 'jan.csv');
    const [target] = await getAllTransactions();
    await updateUserFields(target!.id, { categoryId: 'cat-kids', notes: 'school snacks' });

    await importCsv(HEADER + JAN + FEB, 'jan-feb.csv');

    const after = await getTransaction(target!.id);
    expect(after?.categoryId).toBe('cat-kids');
    expect(after?.categorySource).toBe('manual');
    expect(after?.notes).toBe('school snacks');
  });

  it('undoing the second import restores the exact prior state', async () => {
    await importCsv(HEADER + JAN, 'jan.csv');
    const before = (await getAllTransactions()).map((t) => t.id).sort();

    const second = await importCsv(HEADER + JAN + FEB, 'jan-feb.csv');
    expect(await countTransactions()).toBe(4);

    await undoImportBatch(second.batch.id);

    const after = (await getAllTransactions()).map((t) => t.id).sort();
    expect(after).toEqual(before);
  });

  it('keeps two identical charges on the same day as two rows', async () => {
    const twoCoffees =
      HEADER + '2025-04-01,STARBUCKS STORE 08812,-5.75\n2025-04-01,STARBUCKS STORE 08812,-5.75\n';

    const first = await importCsv(twoCoffees, 'april.csv');
    expect(first.stats.added).toBe(2);

    // …and re-importing the same file still adds nothing.
    const second = await importCsv(twoCoffees, 'april.csv');
    expect(second.stats.added).toBe(0);
    expect(await countTransactions()).toBe(2);
  });

  it('adds exactly one row when a third identical charge appears', async () => {
    await importCsv(HEADER + '2025-04-01,STARBUCKS 1,-5.75\n2025-04-01,STARBUCKS 1,-5.75\n', 'a.csv');
    const grew = await importCsv(
      HEADER + '2025-04-01,STARBUCKS 1,-5.75\n2025-04-01,STARBUCKS 1,-5.75\n2025-04-01,STARBUCKS 1,-5.75\n',
      'b.csv',
    );

    expect(grew.stats.added).toBe(1);
    expect(await countTransactions()).toBe(3);
  });
});

describe('categorization on import', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  it('applies starter rules so the first import is not a wall of blanks', async () => {
    const outcome = await importCsv(HEADER + JAN + FEB, 'jan-feb.csv');
    const byMerchant = new Map(outcome.transactions.map((t) => [t.merchant, t]));

    expect(byMerchant.get('Trader Joes')?.categoryId).toBe('cat-groceries');
    expect(byMerchant.get('Shell Oil')?.categoryId).toBe('cat-transport');
    expect(byMerchant.get('Starbucks')?.categoryId).toBe('cat-dining');
    expect(byMerchant.get('Netflix.com')?.categoryId).toBe('cat-subscriptions');
    expect(byMerchant.get('Trader Joes')?.categorySource).toBe('rule');
  });

  it('leaves unrecognised merchants uncategorized rather than guessing', async () => {
    const outcome = await importCsv(HEADER + '2025-05-01,ZORP INDUSTRIES LLC,-20.00\n', 'z.csv');
    expect(outcome.transactions[0]?.categoryId).toBeNull();
  });
});

describe('toTransactions', () => {
  it('derives merchant and preserves the source row for recovery', () => {
    const [t] = toTransactions(
      [{ date: '2025-01-01', description: 'SQ *BLUE BOTTLE', amountCents: -650, raw: { a: '1' } }],
      { sourceId: 's', batchId: 'b', rules: RULES, categories: CATEGORIES },
    );
    expect(t?.merchant).toBe('Blue Bottle');
    expect(t?.raw).toEqual({ a: '1' });
  });
});

describe('summarizeImport', () => {
  it('states the outcome plainly', () => {
    const text = summarizeImport({
      read: 142, added: 31, duplicates: 109, updated: 2, needsReview: 0, skipped: 0, errors: [],
    });
    expect(text).toBe('142 rows read → 31 added → 109 already present → 2 updated');
  });
});
