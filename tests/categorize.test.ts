import { describe, expect, it } from 'vitest';
import { categorize, describeRule, matcherMatches, proposeRuleFromTransaction, recategorizeAll } from '@/categorize/engine';
import { DEFAULT_CATEGORIES, defaultRules } from '@/categorize/defaults';
import type { Rule, Transaction } from '@/types/models';

function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'x',
    sourceId: 'csv:bank',
    accountLabel: 'Checking',
    date: '2025-03-04',
    description: 'TRADER JOES #123',
    merchant: 'Trader Joes',
    amountCents: -4599,
    currency: 'USD',
    categoryId: null,
    categorySource: 'default',
    status: 'delivered',
    refundedCents: 0,
    batchId: 'b',
    importedAt: 1,
    ...over,
  };
}

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    order: 0,
    matchers: [{ kind: 'merchant_contains', value: 'trader joe' }],
    categoryId: 'cat-groceries',
    enabled: true,
    createdAt: 1,
    ...over,
  };
}

const CATS = DEFAULT_CATEGORIES;

describe('matcherMatches', () => {
  it('matches merchant and description case-insensitively', () => {
    expect(matcherMatches({ kind: 'merchant_contains', value: 'TRADER' }, txn())).toBe(true);
    expect(matcherMatches({ kind: 'description_contains', value: '#123' }, txn())).toBe(true);
    expect(matcherMatches({ kind: 'merchant_contains', value: 'costco' }, txn())).toBe(false);
  });

  it('matches amount on magnitude so rules read naturally', () => {
    // "between $20 and $80" should match a $45.99 expense without the user
    // having to reason about sign conventions.
    expect(matcherMatches({ kind: 'amount_between', minCents: 2000, maxCents: 8000 }, txn())).toBe(true);
    expect(matcherMatches({ kind: 'amount_between', minCents: 5000, maxCents: 8000 }, txn())).toBe(false);
  });

  it('supports regex on either field', () => {
    expect(matcherMatches({ kind: 'regex', field: 'merchant', value: '^trader' }, txn())).toBe(true);
    expect(matcherMatches({ kind: 'regex', field: 'description', value: '\\d{3}$' }, txn())).toBe(true);
  });

  it('treats a malformed regex as never matching rather than throwing', () => {
    // A bad rule must not be able to take down an entire import.
    expect(matcherMatches({ kind: 'regex', field: 'merchant', value: '([' }, txn())).toBe(false);
  });
});

describe('categorize', () => {
  it('returns the first matching rule in order', () => {
    const rules = [
      rule({ id: 'second', order: 2, categoryId: 'cat-shopping' }),
      rule({ id: 'first', order: 1, categoryId: 'cat-groceries' }),
    ];
    expect(categorize(txn(), rules, CATS)?.ruleId).toBe('first');
  });

  it('requires every matcher in a rule to match', () => {
    const both = rule({
      matchers: [
        { kind: 'merchant_contains', value: 'trader joe' },
        { kind: 'amount_between', minCents: 10000, maxCents: 20000 },
      ],
    });
    expect(categorize(txn(), [both], CATS)).toBeNull();
  });

  it('skips disabled rules and rules pointing at a deleted category', () => {
    expect(categorize(txn(), [rule({ enabled: false })], CATS)).toBeNull();
    // A dangling category id would otherwise be assigned and render as blank.
    expect(categorize(txn(), [rule({ categoryId: 'cat-deleted' })], CATS)).toBeNull();
  });

  it('returns null rather than guessing at an unknown merchant', () => {
    expect(categorize(txn({ merchant: 'Zorp Industries' }), defaultRules(), CATS)).toBeNull();
  });
});

describe('recategorizeAll', () => {
  it('never overwrites a category the user set by hand', () => {
    // Editing rules should fix the rows you never got to, not undo decisions
    // you already made.
    const manual = txn({ categoryId: 'cat-kids', categorySource: 'manual' });
    const result = recategorizeAll([manual], [rule()], CATS);

    expect(result.changed).toHaveLength(0);
    expect(result.skippedManual).toBe(1);
  });

  it('updates rule-assigned rows when the rules change', () => {
    const byRule = txn({ categoryId: 'cat-shopping', categorySource: 'rule' });
    const result = recategorizeAll([byRule], [rule({ categoryId: 'cat-groceries' })], CATS);

    expect(result.changed[0]?.categoryId).toBe('cat-groceries');
    expect(result.changed[0]?.categorySource).toBe('rule');
  });

  it('clears a category when no rule matches any more', () => {
    const orphaned = txn({ merchant: 'Zorp', categoryId: 'cat-groceries', categorySource: 'rule' });
    const result = recategorizeAll([orphaned], [rule()], CATS);

    expect(result.changed[0]?.categoryId).toBeNull();
    expect(result.changed[0]?.categorySource).toBe('default');
  });

  it('reports nothing changed when rules already agree', () => {
    const settled = txn({ categoryId: 'cat-groceries', categorySource: 'rule' });
    expect(recategorizeAll([settled], [rule()], CATS).changed).toHaveLength(0);
  });
});

describe('proposeRuleFromTransaction', () => {
  it('matches on the normalized merchant so it covers future visits', () => {
    // The merchant field is engineered to be stable across store numbers and
    // cities, which is what makes one rule cover every future visit.
    const proposed = proposeRuleFromTransaction(txn(), 'cat-groceries', 5, 'r-new');

    expect(proposed.matchers).toEqual([{ kind: 'merchant_contains', value: 'Trader Joes' }]);
    expect(proposed.learned).toBe(true);
    expect(categorize(txn({ description: 'TRADER JOES #987 PORTLAND OR' }), [proposed], CATS)).not.toBeNull();
  });
});

describe('describeRule', () => {
  it('explains a rule in plain language', () => {
    expect(describeRule(rule(), CATS)).toBe('merchant contains "trader joe" → Groceries');
    expect(
      describeRule(rule({ matchers: [{ kind: 'amount_between', minCents: 2000, maxCents: 8000 }] }), CATS),
    ).toBe('amount between 20.00 and 80.00 → Groceries');
  });
});

describe('starter rules', () => {
  it('categorize common merchants without touching anything unusual', () => {
    const rules = defaultRules();
    const check = (merchant: string) => categorize(txn({ merchant }), rules, CATS)?.categoryId;

    expect(check('Trader Joes')).toBe('cat-groceries');
    expect(check('Starbucks')).toBe('cat-dining');
    expect(check('Shell Oil')).toBe('cat-transport');
    expect(check('Netflix.com')).toBe('cat-subscriptions');
    expect(check('Zorp Industries')).toBeUndefined();
  });

  it('has no rule pointing at a category that does not exist', () => {
    const ids = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
    const dangling = defaultRules().filter((r) => !ids.has(r.categoryId));
    expect(dangling).toEqual([]);
  });

  it('gives every starter rule a distinct order so matching is deterministic', () => {
    const orders = defaultRules().map((r) => r.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
