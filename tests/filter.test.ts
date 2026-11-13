import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  emptyFilters,
  sortTransactions,
  spendByCategory,
  spendByMerchant,
  spendByMonth,
  totals,
} from '@/lib/filter';
import type { Transaction } from '@/types/models';

function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    sourceId: 'csv:bank',
    accountLabel: 'Checking',
    date: '2025-03-04',
    description: 'TRADER JOES',
    merchant: 'Trader Joes',
    amountCents: -4599,
    currency: 'USD',
    categoryId: 'cat-groceries',
    categorySource: 'rule',
    status: 'delivered',
    refundedCents: 0,
    batchId: 'b',
    importedAt: 1,
    ...over,
  };
}

describe('totals', () => {
  it('separates spending from income', () => {
    const t = totals([txn(), txn({ amountCents: 245000, categoryId: 'cat-income' })]);
    expect(t.spentCents).toBe(4599);
    expect(t.receivedCents).toBe(245000);
    expect(t.netCents).toBe(240401);
  });

  it('excludes cancelled orders entirely', () => {
    // A cancelled order never hit a card. Counting it would invent spending
    // that never happened.
    const t = totals([txn(), txn({ amountCents: -9999, status: 'cancelled' })]);
    expect(t.spentCents).toBe(4599);
  });

  it('subtracts refunds rather than dropping the row', () => {
    const t = totals([txn({ amountCents: -10000, status: 'returned', refundedCents: 10000 })]);
    expect(t.spentCents).toBe(0);
  });

  it('handles a partial refund, which is the common case', () => {
    // $100 item, $85 refunded after a restocking fee: $15 was genuinely spent.
    const t = totals([txn({ amountCents: -10000, status: 'refunded', refundedCents: 8500 })]);
    expect(t.spentCents).toBe(1500);
  });

  it('ignores the non-canonical half of a linked pair', () => {
    // The Amazon order and the card charge are one purchase; counting both
    // would double the spend.
    const t = totals([
      txn({ id: 'card', amountCents: -5000 }),
      txn({ id: 'amazon', amountCents: -5000, supersededBy: 'card' }),
    ]);
    expect(t.spentCents).toBe(5000);
  });

  it('never lets a refund exceeding the charge become income', () => {
    const t = totals([txn({ amountCents: -1000, refundedCents: 5000 })]);
    expect(t.spentCents).toBe(0);
    expect(t.receivedCents).toBe(0);
  });
});

describe('transfers between your own accounts', () => {
  // Paying a card from checking is one expense seen three times: the purchases
  // on the card, the payment leaving checking, and the payment arriving on the
  // card. Only the purchases are spending.
  const purchase = txn({ amountCents: -12000, accountLabel: 'Card' });
  const paymentOut = txn({ amountCents: -12000, categoryId: 'cat-transfer', merchant: 'Chase Autopay' });
  const paymentIn = txn({ amountCents: 12000, categoryId: 'cat-transfer', accountLabel: 'Card' });

  it('counts a card payment as neither spending nor income', () => {
    const t = totals([purchase, paymentOut, paymentIn]);
    expect(t.spentCents).toBe(12000);
    expect(t.receivedCents).toBe(0);
    expect(t.netCents).toBe(-12000);
  });

  it('still reports how much moved, so nothing vanishes without a trace', () => {
    const t = totals([purchase, paymentOut, paymentIn]);
    expect(t.transferCents).toBe(24000);
    expect(t.transferCount).toBe(2);
    expect(t.count).toBe(3);
  });

  it('keeps transfers out of every breakdown', () => {
    const rows = [purchase, paymentOut, paymentIn];
    const names = new Map([['cat-groceries', 'Groceries'], ['cat-transfer', 'Transfers & Payments']]);

    expect(spendByCategory(rows, names).map((b) => b.key)).toEqual(['cat-groceries']);
    expect(spendByMonth(rows)[0]?.spentCents).toBe(12000);
    expect(spendByMerchant(rows).map((b) => b.label)).toEqual(['Trader Joes']);
  });

  it('keeps transfers visible in the list, unlike cancelled or returned rows', () => {
    expect(applyFilters([purchase, paymentOut, paymentIn], emptyFilters())).toHaveLength(3);
  });
});

describe('applyFilters', () => {
  const rows = [
    txn({ id: 'a', date: '2025-01-15', merchant: 'Trader Joes', description: 'TRADER JOES #123', amountCents: -4599 }),
    txn({ id: 'b', date: '2025-02-15', merchant: 'Shell Oil', description: 'SHELL OIL 5744', amountCents: -5210, categoryId: 'cat-transport' }),
    txn({ id: 'c', date: '2025-03-15', merchant: 'Acme Corp', description: 'PAYROLL ACME', amountCents: 245000, categoryId: 'cat-income' }),
    txn({ id: 'd', date: '2025-03-20', merchant: 'Gone', description: 'CANCELLED THING', amountCents: -1000, status: 'cancelled' }),
    txn({ id: 'e', date: '2025-03-21', merchant: 'Mystery', description: 'ZORP LLC', amountCents: -700, categoryId: null }),
  ];

  const ids = (f: Partial<ReturnType<typeof emptyFilters>>) =>
    applyFilters(rows, { ...emptyFilters(), ...f }).map((t) => t.id);

  it('hides rows that count for nothing by default', () => {
    expect(ids({})).not.toContain('d');
    expect(ids({ showNonSpend: true })).toContain('d');
  });

  it('keeps a partly-refunded row visible, because part of it was really spent', () => {
    // $89 charged, $82 refunded: the $7 restocking fee is genuine spending, and
    // hiding the row would quietly understate what was paid.
    const partial = [txn({ id: 'p', amountCents: -8900, status: 'returned', refundedCents: 8200 })];
    expect(applyFilters(partial, emptyFilters())).toHaveLength(1);

    // A fully refunded row is worth nothing, so it does drop out.
    const full = [txn({ id: 'f', amountCents: -8900, status: 'returned', refundedCents: 8900 })];
    expect(applyFilters(full, emptyFilters())).toHaveLength(0);
  });

  it('filters by date range inclusively', () => {
    expect(ids({ from: '2025-02-15', to: '2025-03-15' })).toEqual(['b', 'c']);
  });

  it('filters by category and by direction', () => {
    expect(ids({ categoryIds: ['cat-transport'] })).toEqual(['b']);
    expect(ids({ direction: 'in' })).toEqual(['c']);
    expect(ids({ direction: 'out' })).toEqual(['a', 'b', 'e']);
  });

  it('filters by amount magnitude, ignoring sign', () => {
    expect(ids({ minCents: 5000 })).toEqual(['b', 'c']);
    expect(ids({ maxCents: 1000 })).toEqual(['e']);
  });

  it('finds uncategorized rows', () => {
    expect(ids({ uncategorizedOnly: true })).toEqual(['e']);
  });

  it('searches merchant, description, notes and Amazon item names', () => {
    expect(ids({ search: 'trader' })).toEqual(['a']);

    const withItems = [
      txn({
        id: 'z',
        merchant: 'Amazon',
        items: [
          { name: 'Bluetooth headphones', quantity: 1, amountCents: 4999, status: 'delivered', refundedCents: 0 },
        ],
      }),
    ];
    // Per-item detail earns its keep here: nothing else in the row says
    // "headphones".
    expect(applyFilters(withItems, { ...emptyFilters(), search: 'headphones' })).toHaveLength(1);

    const withNote = [txn({ id: 'n', description: 'SOMETHING', merchant: 'Something', notes: 'reimbursable by work' })];
    expect(applyFilters(withNote, { ...emptyFilters(), search: 'reimbursable' })).toHaveLength(1);
  });
});

describe('sortTransactions', () => {
  const rows = [
    txn({ id: 'a', date: '2025-01-15', amountCents: -100, merchant: 'Zebra' }),
    txn({ id: 'b', date: '2025-03-15', amountCents: -9000, merchant: 'Apple' }),
    txn({ id: 'c', date: '2025-02-15', amountCents: -500, merchant: 'Mango' }),
  ];

  it('sorts by date, amount magnitude and merchant', () => {
    expect(sortTransactions(rows, { key: 'date', direction: 'desc' }).map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(sortTransactions(rows, { key: 'amount', direction: 'desc' }).map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(sortTransactions(rows, { key: 'merchant', direction: 'asc' }).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('is stable for equal keys so rows do not shuffle between renders', () => {
    const same = [txn({ id: 'x', date: '2025-01-01' }), txn({ id: 'y', date: '2025-01-01' })];
    const once = sortTransactions(same, { key: 'date', direction: 'asc' }).map((t) => t.id);
    const twice = sortTransactions(same, { key: 'date', direction: 'asc' }).map((t) => t.id);
    expect(once).toEqual(twice);
  });
});

describe('grouping', () => {
  it('groups spend by category, excluding income', () => {
    const names = new Map([['cat-groceries', 'Groceries'], ['cat-income', 'Income']]);
    const buckets = spendByCategory(
      [txn({ amountCents: -1000 }), txn({ amountCents: -2000 }), txn({ amountCents: 5000, categoryId: 'cat-income' })],
      names,
    );
    expect(buckets).toEqual([{ key: 'cat-groceries', label: 'Groceries', spentCents: 3000, count: 2 }]);
  });

  it('labels rows with no category rather than dropping them', () => {
    const buckets = spendByCategory([txn({ categoryId: null, amountCents: -700 })], new Map());
    expect(buckets[0]?.label).toBe('Uncategorized');
  });

  it('groups by month in chronological order', () => {
    const buckets = spendByMonth([
      txn({ date: '2025-03-01', amountCents: -100 }),
      txn({ date: '2025-01-01', amountCents: -200 }),
      txn({ date: '2025-01-31', amountCents: -300 }),
    ]);
    expect(buckets.map((b) => b.key)).toEqual(['2025-01', '2025-03']);
    expect(buckets[0]?.spentCents).toBe(500);
  });
});
