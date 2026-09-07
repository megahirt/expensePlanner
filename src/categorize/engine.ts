/**
 * Rule-based categorization.
 *
 * Rules are ordered and the first whose matchers all pass wins. Everything is
 * deterministic and local: no network calls, no model, no surprises. A rule you
 * wrote last month behaves identically today, and you can always see exactly
 * why a transaction landed where it did.
 */

import type { Category, Rule, RuleMatcher, Transaction } from '@/types/models';

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

export interface RecategorizeResult {
  changed: Transaction[];
  /** Rows left alone because the user had categorized them by hand. */
  skippedManual: number;
}

/**
 * Re-run rules over existing transactions.
 *
 * Manual assignments are never touched. Editing your rules should fix the rows
 * you never got to, not silently undo the ones you already decided about.
 */
export function recategorizeAll(
  transactions: readonly Transaction[],
  rules: readonly Rule[],
  categories: readonly Category[],
): RecategorizeResult {
  const changed: Transaction[] = [];
  let skippedManual = 0;

  for (const t of transactions) {
    if (t.categorySource === 'manual') {
      skippedManual++;
      continue;
    }
    const match = categorize(t, rules, categories);
    const nextId = match?.categoryId ?? null;
    if (nextId !== t.categoryId) {
      changed.push({
        ...t,
        categoryId: nextId,
        categorySource: nextId ? 'rule' : 'default',
      });
    }
  }

  return { changed, skippedManual };
}

/**
 * Build the rule offered by "always categorize X as Y" after a manual edit.
 *
 * It matches on the normalized merchant, which is the field engineered to be
 * stable across store numbers, cities and processor prefixes — so one rule
 * covers every future visit rather than just this one receipt.
 */
export function proposeRuleFromTransaction(
  t: Transaction,
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
