/**
 * Categorizing without a model: the bundled merchant directory, the bank's own
 * category, telling words, Amazon item names, and suggestions from merchants
 * already settled.
 */
import { describe, expect, it } from 'vitest';
import { classify } from '@/categorize/engine';
import { DIRECTORY_INFO, lookupMerchant } from '@/categorize/directory';
import { bankCategoryOf, mapBankCategory } from '@/categorize/bankCategory';
import { categoryFromItems, categoryFromMerchantName } from '@/categorize/lexicon';
import { merchantSimilarity, suggestFromSimilar } from '@/categorize/similar';
import { DEFAULT_CATEGORIES, defaultRules } from '@/categorize/defaults';
import { normalizeMerchant } from '@/lib/ids';
import { detectRecurring, recurringMonthlyCents } from '@/lib/recurring';
import type { Rule, Transaction } from '@/types/models';

const CATS = DEFAULT_CATEGORIES;
const STARTER = defaultRules();

function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    sourceId: 'csv:bank',
    accountLabel: 'Card',
    date: '2025-03-04',
    description: 'SOMEWHERE',
    merchant: 'Somewhere',
    amountCents: -2500,
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

describe('merchant directory', () => {
  it('holds a few thousand merchants', () => {
    expect(DIRECTORY_INFO.count).toBeGreaterThan(3000);
  });

  it.each([
    ['Best Buy', 'cat-shopping'],
    ['Jiffy Lube', 'cat-transport'],
    ['King Soopers', 'cat-groceries'],
    ['Petco', 'cat-household'],
    ['Olive Garden', 'cat-dining'],
    ['Holiday Inn Express', 'cat-travel'],
  ])('knows %s', (merchant, categoryId) => {
    expect(lookupMerchant(merchant)?.categoryId).toBe(categoryId);
  });

  it('recognises names the way banks mangle them', () => {
    // Apostrophes dropped or split off, store numbers, a trailing country code.
    expect(lookupMerchant(normalizeMerchant('TRADER JOE S #130'))?.categoryId).toBe('cat-groceries');
    expect(lookupMerchant(normalizeMerchant("CARTER'S #812"))?.categoryId).toBe('cat-shopping');
    expect(lookupMerchant(normalizeMerchant('OLD NAVY US 5123'))?.categoryId).toBe('cat-shopping');
    expect(lookupMerchant(normalizeMerchant('THE HOME DEPOT #4702'))?.categoryId).toBe('cat-household');
  });

  it('picks the main business when a brand is tagged as several things', () => {
    // Costco is a warehouse club that also sells gas; Shell is a gas station
    // that also has a shop.
    expect(lookupMerchant('Costco')?.categoryId).toBe('cat-groceries');
    expect(lookupMerchant('Shell')?.categoryId).toBe('cat-transport');
  });

  it('does not match a short brand name inside a longer, different name', () => {
    // "Express" is a clothing chain. "Express Scripts" is a pharmacy benefits
    // company, and a wrong automatic category is worse than none.
    expect(lookupMerchant('Express')?.categoryId).toBe('cat-shopping');
    expect(lookupMerchant('Express Scripts')).toBeNull();
    expect(lookupMerchant('Subway Tile Outlet Supply')).toBeNull();
    expect(lookupMerchant('Apple Valley Dental')).toBeNull();
  });

  it('leaves banks out, because they are usually the other end of a transfer', () => {
    expect(lookupMerchant('Chase')).toBeNull();
    expect(lookupMerchant('Wells Fargo')).toBeNull();
  });

  it('has nothing to say about a merchant it has never heard of', () => {
    expect(lookupMerchant('Fern & Finch Cafe')).toBeNull();
  });
});

describe('bank category', () => {
  it.each([
    ['Groceries', 'cat-groceries'], // Chase
    ['Food & Drink', 'cat-dining'],
    ['Gas', 'cat-transport'],
    ['Bills & Utilities', 'cat-utilities'],
    ['Health & Wellness', 'cat-health'],
    ['Merchandise & Supplies-Groceries', 'cat-groceries'], // Amex
    ['Restaurant-Restaurant', 'cat-dining'],
    ['Transportation-Fuel', 'cat-transport'],
    ['Travel-Airline', 'cat-travel'],
    ['Gas/Automotive', 'cat-transport'], // Capital One
    ['Dining', 'cat-dining'],
    ['Supermarkets', 'cat-groceries'], // Discover
    ['Gasoline', 'cat-transport'],
    ['Home Improvement', 'cat-household'],
  ])('reads "%s"', (label, categoryId) => {
    expect(mapBankCategory(label)).toBe(categoryId);
  });

  it('ignores labels too vague to mean anything', () => {
    for (const label of ['Personal', 'Services', 'Other', 'Payments and Credits', 'Professional Services', '']) {
      expect(mapBankCategory(label), label).toBeNull();
    }
  });

  it('finds the column in the original row, whatever its capitalisation', () => {
    expect(bankCategoryOf({ raw: { Description: 'X', Category: 'Groceries' } })).toBe('Groceries');
    expect(bankCategoryOf({ raw: { 'transaction category': ' Dining ' } })).toBe('Dining');
    expect(bankCategoryOf({ raw: { Description: 'X' } })).toBeNull();
    expect(bankCategoryOf({})).toBeNull();
  });
});

describe('telling words in a merchant name', () => {
  it.each([
    ['Bright Smiles Orthodontics', 'cat-health'],
    ['Greenwood Auto Repair', 'cat-transport'],
    ['Rocket Mortgage Loan Pmt', 'cat-home'],
    ['Lakeview Elementary', 'cat-kids'],
    ['Puget Sound Energy Billpay', 'cat-utilities'],
    ['Northwest Family Food Bank', 'cat-gifts'],
    ['Ballard Farmers Market', 'cat-groceries'],
  ])('reads %s', (merchant, categoryId) => {
    expect(categoryFromMerchantName(merchant, -1000)?.categoryId).toBe(categoryId);
  });

  it('matches whole words only', () => {
    // "rent" must not fire inside "Trent", nor "inn" inside "Dinner".
    expect(categoryFromMerchantName('Trent Dinner Club', -1000)).toBeNull();
  });

  it('prefers the longer phrase', () => {
    // A food bank is a donation, not groceries.
    expect(categoryFromMerchantName('Food Bank Of The Rockies', -1000)?.word).toBe('food bank');
  });

  it('reads income words only on money coming in', () => {
    expect(categoryFromMerchantName('Acme Corp Payroll', 245000)?.categoryId).toBe('cat-income');
    expect(categoryFromMerchantName('Acme Corp Payroll', -5000)).toBeNull();
  });
});

describe('Amazon orders by item', () => {
  const item = (name: string, amountCents: number) => ({ name, amountCents });

  it('categorizes by what was bought', () => {
    expect(categoryFromItems([item('Dog Food Salmon Recipe 30 lb', 5498)])?.categoryId).toBe('cat-household');
    expect(categoryFromItems([item('LEGO City Fire Station', 6399)])?.categoryId).toBe('cat-kids');
    expect(categoryFromItems([item('Childrens Multivitamin Gummies', 1647)])?.categoryId).toBe('cat-health');
  });

  it('lets the bigger part of the order decide', () => {
    const order = [item('AA Batteries 48 Pack', 1899), item('LEGO City Fire Station', 6399)];
    expect(categoryFromItems(order)?.categoryId).toBe('cat-kids');
  });

  it('does not let a small recognised item speak for a large unrecognised one', () => {
    const order = [item('AA Batteries 48 Pack', 600), item('Mechanical Keyboard', 9000)];
    expect(categoryFromItems(order)).toBeNull();
  });

  it('says nothing when it recognises nothing', () => {
    expect(categoryFromItems([item('Mechanical Keyboard', 9000)])).toBeNull();
  });
});

describe('classify', () => {
  const learned: Rule = {
    id: 'mine',
    order: 9999, // after every starter rule, as the app creates them
    matchers: [{ kind: 'merchant_contains', value: 'Costco Gas' }],
    categoryId: 'cat-transport',
    enabled: true,
    learned: true,
    createdAt: 1,
  };

  it('puts a rule the user made ahead of a starter rule', () => {
    // The starter rule files anything "costco" under groceries. A person who
    // says Costco Gas is fuel must win, even though their rule was added last.
    const t = txn({ merchant: 'Costco Gas' });
    expect(classify(t, STARTER, CATS)?.categoryId).toBe('cat-groceries');
    expect(classify(t, [...STARTER, learned], CATS)).toMatchObject({ categoryId: 'cat-transport', source: 'rule' });
    expect(classify(t, [...STARTER, learned], CATS)?.reason).toMatch(/^Your rule/);
  });

  it('files an Amazon order by its items rather than by the starter rule for Amazon', () => {
    const order = txn({
      sourceId: 'amazon',
      merchant: 'Amazon',
      items: [{ name: 'Dog Food Salmon Recipe 30 lb', quantity: 1, amountCents: 5498, status: 'delivered', refundedCents: 0 }],
    });
    expect(classify(order, STARTER, CATS)).toMatchObject({ categoryId: 'cat-household', source: 'items' });

    // With nothing recognisable in it, the starter rule still catches it.
    const plain = txn({ sourceId: 'amazon', merchant: 'Amazon', items: [{ name: 'Mechanical Keyboard', quantity: 1, amountCents: 9000, status: 'delivered', refundedCents: 0 }] });
    expect(classify(plain, STARTER, CATS)).toMatchObject({ categoryId: 'cat-shopping', source: 'rule' });
  });

  it('falls through directory, then bank, then a telling word', () => {
    expect(classify(txn({ merchant: 'Jiffy Lube' }), STARTER, CATS)?.source).toBe('directory');
    expect(classify(txn({ merchant: 'Qfc', raw: { Category: 'Groceries' } }), STARTER, CATS)).toMatchObject({
      categoryId: 'cat-groceries',
      source: 'bank',
    });
    expect(classify(txn({ merchant: 'Bright Smiles Orthodontics' }), STARTER, CATS)?.source).toBe('keyword');
  });

  it('always explains itself', () => {
    expect(classify(txn({ merchant: 'Jiffy Lube' }), STARTER, CATS)?.reason).toBe('Well-known merchant "jiffy lube"');
    expect(classify(txn({ merchant: 'Qfc', raw: { Category: 'Groceries' } }), STARTER, CATS)?.reason).toBe(
      'Your bank files this under "Groceries"',
    );
    expect(classify(txn({ merchant: 'Bright Smiles Orthodontics' }), STARTER, CATS)?.reason).toBe(
      'The name contains "orthodontics"',
    );
  });

  it('gives no answer rather than a guess', () => {
    expect(classify(txn({ merchant: 'Check Paid' }), STARTER, CATS)).toBeNull();
    expect(classify(txn({ merchant: 'Atm 4th Ave' }), STARTER, CATS)).toBeNull();
  });

  it('never assigns a category that has been deleted', () => {
    const withoutHealth = CATS.filter((c) => c.id !== 'cat-health');
    expect(classify(txn({ merchant: 'Bright Smiles Orthodontics' }), STARTER, withoutHealth)).toBeNull();
  });
});

describe('suggestions from similar merchants', () => {
  const known = new Map([
    ['Fern & Finch Roasters', 'cat-dining'],
    ['Greenwood Auto Body', 'cat-transport'],
    ['Zelle Payment To J Nakamura', 'cat-kids'],
  ]);

  it('proposes the category of the closest merchant already settled', () => {
    expect(suggestFromSimilar('Fern & Finch Cafe', known)).toMatchObject({
      categoryId: 'cat-dining',
      similarTo: 'Fern & Finch Roasters',
    });
    expect(suggestFromSimilar('Greenwood Auto Repair', known)?.categoryId).toBe('cat-transport');
  });

  it('catches a misspelling', () => {
    expect(merchantSimilarity('Starbuks Coffee', 'Starbucks Coffee')).toBeGreaterThan(0.7);
  });

  it('offers nothing for an unrelated name', () => {
    expect(suggestFromSimilar('Mile High Diner', known)).toBeNull();
  });

  it('does not treat filler words as a resemblance', () => {
    // "Payment" and "Store" appear everywhere and prove nothing.
    expect(merchantSimilarity('Acme Payment Services', 'Bolt Payment Services')).toBeLessThan(0.55);
  });
});

describe('recurring charges', () => {
  const monthly = (merchant: string, cents: number, day = 5, months = 6) =>
    Array.from({ length: months }, (_, i) =>
      txn({ merchant, amountCents: -cents, date: `2025-${String(i + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` }),
    );

  it('finds a monthly subscription and prices it per year', () => {
    const [found] = detectRecurring(monthly('Netflix.com', 2299));
    expect(found).toMatchObject({ merchant: 'Netflix.com', cadence: 'monthly', typicalCents: 2299, fixedAmount: true, count: 6 });
    expect(found?.yearlyCents).toBe(2299 * 12);
  });

  it('needs three charges before calling something recurring', () => {
    expect(detectRecurring(monthly('Netflix.com', 2299, 5, 2))).toEqual([]);
  });

  it('separates two subscriptions billed by the same merchant', () => {
    const rows = [...monthly('Apple.com Bill', 299, 17), ...monthly('Apple.com Bill', 999, 22)];
    expect(detectRecurring(rows).map((r) => r.typicalCents).sort((a, b) => a - b)).toEqual([299, 999]);
  });

  it('accepts a bill whose amount moves, and says so', () => {
    const amounts = [21000, 18500, 14000, 9000, 7500, 8200];
    const rows = amounts.map((cents, i) =>
      txn({ merchant: 'Energy Co', amountCents: -cents, date: `2025-${String(i + 1).padStart(2, '0')}-22` }),
    );
    expect(detectRecurring(rows)[0]).toMatchObject({ cadence: 'monthly', fixedAmount: false });
  });

  it('does not mistake a habit for a subscription', () => {
    const dates = ['2025-01-03', '2025-01-04', '2025-01-11', '2025-01-29', '2025-02-02', '2025-02-20', '2025-03-01'];
    const rows = dates.map((date, i) => txn({ merchant: 'Coffee Place', amountCents: -(450 + i * 130), date }));
    expect(detectRecurring(rows)).toEqual([]);
  });

  it('forgives one skipped month', () => {
    const rows = monthly('Gym', 4500, 1, 8).filter((t) => !t.date.startsWith('2025-04'));
    expect(detectRecurring(rows)[0]?.cadence).toBe('monthly');
  });

  it('ignores transfers and money coming in', () => {
    const transfers = monthly('Transfer To Savings', 60000).map((t) => ({ ...t, categoryId: 'cat-transfer' }));
    const pay = monthly('Payroll', 300000).map((t) => ({ ...t, amountCents: 300000 }));
    expect(detectRecurring([...transfers, ...pay])).toEqual([]);
  });

  it('adds up what recurring charges cost per month', () => {
    const found = detectRecurring([...monthly('Netflix.com', 2299), ...monthly('Spotify', 1999, 9)]);
    expect(recurringMonthlyCents(found)).toBe(2299 + 1999);
  });
});
