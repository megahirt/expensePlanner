/**
 * Seed categories and starter rules.
 *
 * The starter rules exist so the first import is not a wall of uncategorized
 * rows. They are ordinary rules with no special status: visible in Settings,
 * editable, reorderable and deletable like any rule the user writes.
 */

import type { Category, Rule } from '@/types/models';

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'cat-groceries', name: 'Groceries', color: '#4c9a70', builtin: true },
  { id: 'cat-dining', name: 'Restaurants & Coffee', color: '#c98a3c', builtin: true },
  { id: 'cat-household', name: 'Household & Supplies', color: '#6b8cc4', builtin: true },
  { id: 'cat-transport', name: 'Transport & Fuel', color: '#7a6bc4', builtin: true },
  { id: 'cat-utilities', name: 'Utilities & Bills', color: '#5b9ec4', builtin: true },
  { id: 'cat-health', name: 'Health & Pharmacy', color: '#c46b8c', builtin: true },
  { id: 'cat-entertainment', name: 'Entertainment', color: '#b06bc4', builtin: true },
  { id: 'cat-subscriptions', name: 'Subscriptions', color: '#8c8c9e', builtin: true },
  { id: 'cat-travel', name: 'Travel', color: '#3c9ac9', builtin: true },
  { id: 'cat-shopping', name: 'Shopping', color: '#c4926b', builtin: true },
  { id: 'cat-kids', name: 'Kids & School', color: '#9ac43c', builtin: true },
  { id: 'cat-gifts', name: 'Gifts & Donations', color: '#c45b5b', builtin: true },
  { id: 'cat-home', name: 'Home & Rent', color: '#6bc4a8', builtin: true },
  { id: 'cat-income', name: 'Income', color: '#2f6f4f', builtin: true },
  { id: 'cat-transfer', name: 'Transfers & Payments', color: '#8c8c86', builtin: true },
  { id: 'cat-fees', name: 'Fees & Interest', color: '#a33a2c', builtin: true },
  { id: 'cat-uncategorized', name: 'Uncategorized', color: '#93938d', builtin: true },
];

interface Seed {
  category: string;
  merchants: string[];
}

/**
 * Merchant fragments matched against the normalized merchant name. Kept short
 * and distinctive: a fragment that is too generic ("market") would swallow
 * unrelated merchants, and a wrong auto-category is worse than none.
 */
const SEEDS: Seed[] = [
  {
    category: 'cat-groceries',
    merchants: ['trader joe', 'safeway', 'kroger', 'whole foods', 'aldi', 'publix', 'wegmans',
      'costco', 'sprouts', 'food lion', 'giant eagle', 'h-e-b', 'heb ', 'winco', 'fred meyer'],
  },
  {
    category: 'cat-dining',
    merchants: ['starbucks', 'chipotle', 'mcdonald', 'subway', 'panera', 'dunkin', 'pizza',
      'taco bell', 'wendy', 'chick-fil-a', 'doordash', 'grubhub', 'uber eats', 'coffee', 'cafe',
      'restaurant', 'brewing', 'bakery'],
  },
  {
    category: 'cat-household',
    merchants: ['target', 'walmart', 'home depot', 'lowe', 'ace hardware', 'ikea', 'bed bath'],
  },
  {
    category: 'cat-transport',
    merchants: ['shell', 'chevron', 'exxon', 'bp ', 'arco', 'texaco', 'uber', 'lyft', '76 ',
      'speedway', 'circle k', 'parking', 'transit', 'dmv'],
  },
  {
    category: 'cat-utilities',
    merchants: ['comcast', 'xfinity', 'verizon', 'at&t', 't-mobile', 'centurylink', 'puget sound energy',
      'water district', 'electric', 'waste management', 'city of'],
  },
  {
    category: 'cat-health',
    merchants: ['cvs', 'walgreens', 'rite aid', 'pharmacy', 'dental', 'clinic', 'medical', 'kaiser',
      'optical', 'vision'],
  },
  {
    category: 'cat-entertainment',
    merchants: ['amc', 'regal', 'cinemark', 'steam', 'nintendo', 'playstation', 'xbox', 'ticketmaster'],
  },
  {
    category: 'cat-subscriptions',
    merchants: ['netflix', 'spotify', 'hulu', 'disney plus', 'disney+', 'youtube premium', 'apple.com/bill',
      'icloud', 'dropbox', 'adobe', 'patreon', 'new york times', 'amazon prime video', 'audible'],
  },
  {
    category: 'cat-travel',
    merchants: ['airlines', 'alaska air', 'delta', 'united air', 'southwest', 'marriott', 'hilton',
      'airbnb', 'expedia', 'hotel', 'hertz', 'enterprise rent'],
  },
  { category: 'cat-shopping', merchants: ['amazon', 'etsy', 'ebay', 'rei', 'nordstrom', 'macy'] },
  {
    category: 'cat-fees',
    merchants: ['overdraft', 'atm fee', 'service charge', 'interest charge', 'annual fee', 'late fee',
      'foreign transaction'],
  },
  {
    category: 'cat-transfer',
    merchants: ['venmo', 'zelle', 'paypal', 'cash app', 'transfer', 'payment thank you',
      'online payment', 'autopay'],
  },
];

/** Build the starter rule set. Order follows SEEDS, most specific first. */
export function defaultRules(now = Date.now()): Rule[] {
  const rules: Rule[] = [];
  let order = 0;

  for (const seed of SEEDS) {
    for (const merchant of seed.merchants) {
      rules.push({
        id: `rule-seed-${order}`,
        order: order++,
        matchers: [{ kind: 'merchant_contains', value: merchant.trim() }],
        categoryId: seed.category,
        enabled: true,
        createdAt: now,
        note: 'Starter rule',
      });
    }
  }

  return rules;
}

/**
 * Seed an empty database. Runs only when there are no categories at all, so a
 * user who deleted a builtin category does not get it back on next launch.
 */
export function needsSeeding(categories: readonly Category[]): boolean {
  return categories.length === 0;
}
