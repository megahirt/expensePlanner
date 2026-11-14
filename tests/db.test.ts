import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  countTransactions,
  getActiveWorkspace,
  getTransaction,
  putImportBatch,
  setActiveWorkspace,
  setCategoryForMany,
  undoImportBatch,
  updateUserFields,
  upsertTransactions,
  WORKSPACE_KEY,
} from '@/lib/db';
import type { ImportBatch, Transaction } from '@/types/models';
import { emptyStats } from '@/types/models';

function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'id-1',
    sourceId: 'csv:test',
    accountLabel: 'Test Checking',
    date: '2025-03-04',
    description: 'TRADER JOES',
    merchant: 'Trader Joes',
    amountCents: -4599,
    currency: 'USD',
    categoryId: null,
    categorySource: 'default',
    status: 'delivered',
    refundedCents: 0,
    batchId: 'batch-1',
    importedAt: 1,
    ...over,
  };
}

describe('upsertTransactions', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  it('adds new rows', async () => {
    const result = await upsertTransactions([txn(), txn({ id: 'id-2' })]);
    expect(result.added).toHaveLength(2);
    expect(await countTransactions()).toBe(2);
  });

  it('treats an unchanged re-import as a duplicate, not an error', async () => {
    await upsertTransactions([txn()]);
    const second = await upsertTransactions([txn({ batchId: 'batch-2', importedAt: 2 })]);

    expect(second.added).toHaveLength(0);
    expect(second.duplicates).toEqual(['id-1']);
    expect(await countTransactions()).toBe(1);
  });

  it('preserves a manual category across a re-import', async () => {
    // This is the guarantee that makes refreshing data safe: hand-categorization
    // is a user decision and a later import must never silently undo it.
    await upsertTransactions([txn()]);
    await updateUserFields('id-1', { categoryId: 'cat-groceries' });

    await upsertTransactions([txn({ categoryId: 'cat-other', categorySource: 'rule' })]);

    const after = await getTransaction('id-1');
    expect(after?.categoryId).toBe('cat-groceries');
    expect(after?.categorySource).toBe('manual');
  });

  it('preserves notes and tags across a re-import', async () => {
    await upsertTransactions([txn()]);
    await updateUserFields('id-1', { notes: 'split with Sam', tags: ['reimbursable'] });

    await upsertTransactions([txn({ status: 'returned', refundedCents: 4599 })]);

    const after = await getTransaction('id-1');
    expect(after?.notes).toBe('split with Sam');
    expect(after?.tags).toEqual(['reimbursable']);
    // …while still taking the refreshed status, which is the point of upserting.
    expect(after?.status).toBe('returned');
    expect(after?.refundedCents).toBe(4599);
  });

  it('refreshes a pending charge that has since posted', async () => {
    await upsertTransactions([txn({ status: 'ordered', amountCents: -4599 })]);
    const result = await upsertTransactions([txn({ status: 'delivered', amountCents: -4650 })]);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.before.amountCents).toBe(-4599);
    const after = await getTransaction('id-1');
    expect(after?.amountCents).toBe(-4650);
  });
});

describe('undoImportBatch', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  function batch(over: Partial<ImportBatch> = {}): ImportBatch {
    return {
      id: 'batch-2',
      sourceId: 'csv:test',
      adapterId: 'csv',
      label: 'march.csv',
      startedAt: 2,
      stats: emptyStats(),
      createdIds: [],
      ...over,
    };
  }

  it('removes only the rows the batch created', async () => {
    await upsertTransactions([txn({ id: 'old', batchId: 'batch-1' })]);
    await upsertTransactions([txn({ id: 'new', batchId: 'batch-2' })]);
    await putImportBatch(batch({ createdIds: ['new'] }));

    const result = await undoImportBatch('batch-2');

    expect(result.removed).toBe(1);
    expect(await getTransaction('old')).toBeDefined();
    expect(await getTransaction('new')).toBeUndefined();
  });

  it('restores prior values of rows it updated', async () => {
    await upsertTransactions([txn({ id: 'a', status: 'delivered', batchId: 'batch-1' })]);
    await upsertTransactions([txn({ id: 'a', status: 'returned', refundedCents: 4599 })]);
    await putImportBatch(
      batch({ createdIds: [], updatedBefore: [{ id: 'a', status: 'delivered', refundedCents: 0 }] }),
    );

    await undoImportBatch('batch-2');

    const after = await getTransaction('a');
    expect(after?.status).toBe('delivered');
    expect(after?.refundedCents).toBe(0);
  });
});

describe('setCategoryForMany', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  it('marks bulk-assigned rows as manual so imports leave them alone', async () => {
    await upsertTransactions([txn({ id: 'a' }), txn({ id: 'b' }), txn({ id: 'c' })]);

    const changed = await setCategoryForMany(['a', 'b'], 'cat-groceries');

    expect(changed).toBe(2);
    expect((await getTransaction('a'))?.categorySource).toBe('manual');
    expect((await getTransaction('c'))?.categoryId).toBeNull();
  });
});

describe('workspaces', () => {
  beforeEach(async () => {
    await setActiveWorkspace('demo');
    await clearAllData();
    await setActiveWorkspace('real');
    await clearAllData();
  });

  afterAll(async () => {
    await setActiveWorkspace('real');
  });

  it('starts on the real data', () => {
    expect(getActiveWorkspace()).toBe('real');
  });

  it('keeps real and demo rows in separate databases', async () => {
    await upsertTransactions([txn({ id: 'mine' })]);

    await setActiveWorkspace('demo');
    expect(await countTransactions()).toBe(0);
    expect(await getTransaction('mine')).toBeUndefined();
    await upsertTransactions([txn({ id: 'demo-1' }), txn({ id: 'demo-2' })]);
    expect(await countTransactions()).toBe(2);

    await setActiveWorkspace('real');
    expect(await countTransactions()).toBe(1);
    expect(await getTransaction('demo-1')).toBeUndefined();
    expect((await getTransaction('mine'))?.id).toBe('mine');
  });

  it('keeps a decision made in the demo out of the real data', async () => {
    await upsertTransactions([txn({ id: 'same-id' })]);

    await setActiveWorkspace('demo');
    await upsertTransactions([txn({ id: 'same-id' })]);
    await updateUserFields('same-id', { categoryId: 'cat-groceries', notes: 'demo note' });

    await setActiveWorkspace('real');
    const mine = await getTransaction('same-id');
    expect(mine?.categoryId).toBeNull();
    expect(mine?.notes).toBeUndefined();
  });

  it('wiping the demo leaves real data alone', async () => {
    await upsertTransactions([txn({ id: 'mine' })]);
    await setActiveWorkspace('demo');
    await upsertTransactions([txn({ id: 'demo-1' })]);

    await clearAllData();
    expect(await countTransactions()).toBe(0);

    await setActiveWorkspace('real');
    expect(await countTransactions()).toBe(1);
  });

  it('remembers the choice for the next time the app opens', async () => {
    await setActiveWorkspace('demo');
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe('demo');
    await setActiveWorkspace('real');
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe('real');
  });
});
