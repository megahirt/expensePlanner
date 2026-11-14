/**
 * Rule-based categorization.
 *
 * Rules are ordered and the first whose matchers all pass wins. Everything is
 * deterministic and local: no network calls, no model, no surprises. A rule you
 * wrote last month behaves identically today, and you can always see exactly
 * why a transaction landed where it did.
 */

import type { Category, CategorySource, Rule, RuleMatcher, Transaction } from '@/types/models';
import { bankCategoryOf, mapBankCategory } from './bankCategory';
import { lookupMerchant } from './directory';
import { categoryFromItems, categoryFromMerchantName } from './lexicon';

export interface CategoryMatch {
  categoryId: string;
  ruleId: string;
}

/** Does one matcher accept this transaction? */
export function matcherMatches(matcher: RuleMatcher, t: Transaction): boolean {
  switch (matcher.kind) {
    case 'merchant_contains':
      return t.merchant.toLowerCase().includes(matcher.value.toLowerCase());
    case 'description_contains':
      return t.description.toLowerCase().includes(matcher.value.toLowerCase());
    case 'regex': {
      const field = matcher.field === 'merchant' ? t.merchant : t.description;
      try {
        return new RegExp(matcher.value, 'i').test(field);
      } catch {
        // A malformed regex must not take down an import. It simply never
        // matches, and the Settings page flags it as invalid.
        return false;
      }
    }
    case 'amount_between': {
      // Compare on magnitude so a rule reads naturally ("between $20 and $80")
      // without the user having to think about sign conventions.
      const magnitude = Math.abs(t.amountCents);
      return magnitude >= matcher.minCents && magnitude <= matcher.maxCents;
    }
    case 'source_is':
      return t.sourceId === matcher.value;
    default:
      return false;
  }
}

/** Find the first enabled rule that matches, if any. */
export function categorize(
  t: Transaction,
  rules: readonly Rule[],
  categories: readonly Category[],
): CategoryMatch | null {
  const valid = new Set(categories.map((c) => c.id));
  const ordered = [...rules].sort((a, b) => a.order - b.order);

  for (const rule of ordered) {
    if (!rule.enabled) continue;
    if (rule.matchers.length === 0) continue;
    // A rule pointing at a deleted category would otherwise assign a dangling id.
    if (!valid.has(rule.categoryId)) continue;
    if (rule.matchers.every((m) => matcherMatches(m, t))) {
      return { categoryId: rule.categoryId, ruleId: rule.id };
    }
  }
  return null;
}

/** A category, where it came from, and a sentence saying why. */
export interface Classification {
  categoryId: string;
  source: CategorySource;
  reason: string;
  ruleId?: string;
}

/** Starter rules ship with the app; everything else is a rule the user made. */
const isStarterRule = (rule: Rule): boolean => !rule.learned && rule.note === 'Starter rule';

/**
 * Work out a category for a transaction, trying the most trustworthy source
 * first and stopping at the first that has an answer:
 *
 *   1. A rule the user made. Their decision outranks everything automatic.
 *   2. What an Amazon order contained, so an order of dog food is not filed
 *      under Shopping just because it came from Amazon.
 *   3. A starter rule.
 *   4. The bundled directory of well-known merchants.
 *   5. The bank's own category column.
 *   6. A telling word in the merchant's name.
 *
 * Every step is a lookup in data that ships with the extension: no network, no
 * model. The same row always gets the same answer, and the answer comes with
 * the reason, which is stored and shown.
 */
export function classify(
  t: Transaction,
  rules: readonly Rule[],
  categories: readonly Category[],
): Classification | null {
  const valid = new Set(categories.map((c) => c.id));
  const ordered = [...rules].sort((a, b) => a.order - b.order);

  const fromRules = (subset: Rule[], label: string): Classification | null => {
    const match = categorize(t, subset, categories);
    if (!match) return null;
    const rule = subset.find((r) => r.id === match.ruleId)!;
    return {
      categoryId: match.categoryId,
      source: 'rule',
      reason: `${label}: ${rule.matchers.map(describeMatcher).join(' and ')}`,
      ruleId: match.ruleId,
    };
  };

  const own = fromRules(ordered.filter((r) => !isStarterRule(r)), 'Your rule');
  if (own) return own;

  if (t.items && t.items.length > 0) {
    const items = categoryFromItems(t.items);
    if (items && valid.has(items.categoryId)) {
      const others = t.items.length - 1;
      return {
        categoryId: items.categoryId,
        source: 'items',
        reason: `The order was mostly "${items.itemName}"${others > 0 ? ` (${t.items.length} items)` : ''}`,
      };
    }
  }

  const starter = fromRules(ordered.filter(isStarterRule), 'Starter rule');
  if (starter) return starter;

  const known = lookupMerchant(t.merchant);
  if (known && valid.has(known.categoryId)) {
    return { categoryId: known.categoryId, source: 'directory', reason: `Well-known merchant "${known.matched}"` };
  }

  const bankLabel = bankCategoryOf(t);
  const fromBank = bankLabel ? mapBankCategory(bankLabel) : null;
  if (fromBank && valid.has(fromBank)) {
    return { categoryId: fromBank, source: 'bank', reason: `Your bank files this under "${bankLabel}"` };
  }

  const word = categoryFromMerchantName(t.merchant, t.amountCents);
  if (word && valid.has(word.categoryId)) {
    return { categoryId: word.categoryId, source: 'keyword', reason: `The name contains "${word.word}"` };
  }

  return null;
}

export interface RecategorizeResult {
  changed: Transaction[];
  /** How many of `changed` moved to a different category (the rest only gained
   *  an explanation). */
  categoryChanges: number;
  /** Rows left alone because the user had categorized them by hand. */
  skippedManual: number;
}

/**
 * Re-run categorization over existing transactions.
 *
 * Manual assignments are never touched, and neither are categories taken from
 * a matched Amazon order in Review. Editing your rules should fix the rows you
 * never got to, not silently undo the ones you already decided about.
 */
export function recategorizeAll(
  transactions: readonly Transaction[],
  rules: readonly Rule[],
  categories: readonly Category[],
): RecategorizeResult {
  const changed: Transaction[] = [];
  let categoryChanges = 0;
  let skippedManual = 0;

  for (const t of transactions) {
    if (t.categorySource === 'manual') {
      skippedManual++;
      continue;
    }
    if (t.categorySource === 'linked') continue;

    const match = classify(t, rules, categories);
    const nextId = match?.categoryId ?? null;
    const nextSource: CategorySource = match?.source ?? 'default';
    if (nextId === t.categoryId && nextSource === t.categorySource && match?.reason === t.categoryReason) continue;

    const next: Transaction = { ...t, categoryId: nextId, categorySource: nextSource };
    if (match) next.categoryReason = match.reason;
    else delete next.categoryReason;
    if (nextId !== t.categoryId) categoryChanges++;
    changed.push(next);
  }

  return { changed, categoryChanges, skippedManual };
}

/**
 * Build the rule offered by "always categorize X as Y" after a manual edit.
 *
 * It matches on the normalized merchant, which is the field engineered to be
 * stable across store numbers, cities and processor prefixes — so one rule
 * covers every future visit rather than just this one receipt.
 */
export function proposeRuleFromTransaction(
  t: Pick<Transaction, 'merchant'>,
  categoryId: string,
  order: number,
  id: string,
): Rule {
  return {
    id,
    order,
    matchers: [{ kind: 'merchant_contains', value: t.merchant }],
    categoryId,
    enabled: true,
    learned: true,
    createdAt: Date.now(),
  };
}

/** Human-readable description of a rule, for the Settings list. */
export function describeRule(rule: Rule, categories: readonly Category[]): string {
  const category = categories.find((c) => c.id === rule.categoryId)?.name ?? 'Unknown category';
  const conditions = rule.matchers.map(describeMatcher).join(' and ');
  return `${conditions} → ${category}`;
}

function describeMatcher(m: RuleMatcher): string {
  switch (m.kind) {
    case 'merchant_contains':
      return `merchant contains "${m.value}"`;
    case 'description_contains':
      return `description contains "${m.value}"`;
    case 'regex':
      return `${m.field} matches /${m.value}/`;
    case 'amount_between':
      return `amount between ${(m.minCents / 100).toFixed(2)} and ${(m.maxCents / 100).toFixed(2)}`;
    case 'source_is':
      return `source is ${m.value}`;
    default:
      return 'unknown condition';
  }
}
