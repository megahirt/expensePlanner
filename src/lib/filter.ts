/**
 * Transaction filtering, sorting and aggregation.
 *
 * Kept as pure functions over an array rather than as database queries: a
 * household's history is small enough to filter in memory instantly, and pure
 * functions can be tested exhaustively without a browser. Every screen —
 * table, dashboard, export — runs through this same code, so what a chart
 * totals and what the table lists can never disagree.
 */

import { effectiveCents, isNonSpend, type Transaction } from '@/types/models';

export interface Filters {
  /** Free text over merchant, description, notes and item names. */
  search: string;
  from: string | null;
  to: string | null;
  sourceIds: string[];
  categoryIds: string[];
  /** Magnitude range in cents; ignores sign so the UI reads naturally. */
  minCents: number | null;
  maxCents: number | null;
  /** Show returned, cancelled and superseded rows. Off by default. */
  showNonSpend: boolean;
  /** 'all' | 'out' | 'in' */
  direction: 'all' | 'out' | 'in';
  /** Only rows with no category assigned. */
  uncategorizedOnly: boolean;
}

export function emptyFilters(): Filters {
  return {
    search: '',
    from: null,
    to: null,
    sourceIds: [],
    categoryIds: [],
    minCents: null,
    maxCents: null,
    showNonSpend: false,
    direction: 'all',
    uncategorizedOnly: false,
  };
}

export function hasActiveFilters(f: Filters): boolean {
  const base = emptyFilters();
  return (
    f.search !== base.search ||
    f.from !== base.from ||
    f.to !== base.to ||
    f.sourceIds.length > 0 ||
    f.categoryIds.length > 0 ||
    f.minCents !== null ||
    f.maxCents !== null ||
    f.showNonSpend !== base.showNonSpend ||
    f.direction !== base.direction ||
    f.uncategorizedOnly
  );
}

export type SortKey = 'date' | 'amount' | 'merchant' | 'category' | 'source';
export interface Sort {
  key: SortKey;
  direction: 'asc' | 'desc';
}

/** Does a transaction match the free-text query? */
function matchesSearch(t: Transaction, query: string): boolean {
  const q = query.toLowerCase();
  if (t.merchant.toLowerCase().includes(q)) return true;
  if (t.description.toLowerCase().includes(q)) return true;
  if (t.accountLabel.toLowerCase().includes(q)) return true;
  if (t.notes?.toLowerCase().includes(q)) return true;
  if (t.tags?.some((tag) => tag.toLowerCase().includes(q))) return true;
  // Amazon item names are the reason per-item detail is worth keeping: searching
  // "headphones" should find the order that contained them.
  if (t.items?.some((item) => item.name.toLowerCase().includes(q))) return true;
  return false;
}

export function applyFilters(transactions: readonly Transaction[], f: Filters): Transaction[] {
  const search = f.search.trim().toLowerCase();
  const sourceSet = f.sourceIds.length > 0 ? new Set(f.sourceIds) : null;
  const categorySet = f.categoryIds.length > 0 ? new Set(f.categoryIds) : null;

  return transactions.filter((t) => {
    if (!f.showNonSpend && isNonSpend(t)) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (sourceSet && !sourceSet.has(t.sourceId)) return false;
    if (categorySet && !categorySet.has(t.categoryId ?? '')) return false;
    if (f.uncategorizedOnly && t.categoryId) return false;

    if (f.direction === 'out' && t.amountCents >= 0) return false;
    if (f.direction === 'in' && t.amountCents <= 0) return false;

    const magnitude = Math.abs(t.amountCents);
    if (f.minCents !== null && magnitude < f.minCents) return false;
    if (f.maxCents !== null && magnitude > f.maxCents) return false;

    if (search && !matchesSearch(t, search)) return false;
    return true;
  });
}

export function sortTransactions(
  transactions: readonly Transaction[],
  sort: Sort,
  categoryNames: ReadonlyMap<string, string> = new Map(),
): Transaction[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  const compare = (a: Transaction, b: Transaction): number => {
    switch (sort.key) {
      case 'amount':
        return (Math.abs(a.amountCents) - Math.abs(b.amountCents)) * dir;
      case 'merchant':
        return a.merchant.localeCompare(b.merchant) * dir;
      case 'category':
        return (
          (categoryNames.get(a.categoryId ?? '') ?? '').localeCompare(
            categoryNames.get(b.categoryId ?? '') ?? '',
          ) * dir
        );
      case 'source':
        return a.accountLabel.localeCompare(b.accountLabel) * dir;
      case 'date':
      default:
        // Stable secondary ordering so equal dates don't shuffle between renders.
        return (a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) * dir;
    }
  };
  return [...transactions].sort(compare);
}

export interface Totals {
  spentCents: number;
  receivedCents: number;
  netCents: number;
  count: number;
}

/**
 * Total a set of transactions.
 *
 * Uses `effectiveCents`, so cancelled orders, returned items and the
 * non-canonical half of a linked pair contribute nothing. Every number the app
 * shows comes from here, which is why a returned Amazon order can never quietly
 * inflate a monthly total.
 */
export function totals(transactions: readonly Transaction[]): Totals {
  let spentCents = 0;
  let receivedCents = 0;
  for (const t of transactions) {
    const cents = effectiveCents(t);
    if (cents < 0) spentCents += -cents;
    else receivedCents += cents;
  }
  return {
    spentCents,
    receivedCents,
    netCents: receivedCents - spentCents,
    count: transactions.length,
  };
}

export interface Bucket {
  key: string;
  label: string;
  spentCents: number;
  count: number;
}

/** Group spending by category id. Income and zero-effect rows are excluded. */
export function spendByCategory(
  transactions: readonly Transaction[],
  categoryNames: ReadonlyMap<string, string>,
): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const t of transactions) {
    const cents = effectiveCents(t);
    if (cents >= 0) continue;
    const key = t.categoryId ?? '';
    const label = categoryNames.get(key) ?? 'Uncategorized';
    const bucket = buckets.get(key) ?? { key, label, spentCents: 0, count: 0 };
    bucket.spentCents += -cents;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => b.spentCents - a.spentCents);
}

/** Group spending by `YYYY-MM`, ascending. */
export function spendByMonth(transactions: readonly Transaction[]): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const t of transactions) {
    const cents = effectiveCents(t);
    if (cents >= 0) continue;
    const key = t.date.slice(0, 7);
    const bucket = buckets.get(key) ?? { key, label: key, spentCents: 0, count: 0 };
    bucket.spentCents += -cents;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Top merchants by spend. */
export function spendByMerchant(transactions: readonly Transaction[], limit = 10): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const t of transactions) {
    const cents = effectiveCents(t);
    if (cents >= 0) continue;
    const bucket = buckets.get(t.merchant) ?? {
      key: t.merchant,
      label: t.merchant,
      spentCents: 0,
      count: 0,
    };
    bucket.spentCents += -cents;
    bucket.count += 1;
    buckets.set(t.merchant, bucket);
  }
  return [...buckets.values()].sort((a, b) => b.spentCents - a.spentCents).slice(0, limit);
}
