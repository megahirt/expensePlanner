/**
 * Using the category the bank already worked out.
 *
 * Card issuers know what kind of business each merchant is (from the merchant
 * category code attached to the charge) and several put it in their CSV: Chase
 * and Capital One have a "Category" column, Amex an extended one. It is coarse,
 * and every issuer words it differently, but it is right far more often than
 * not and covers merchants no list could ever enumerate, like a local diner.
 *
 * Patterns are matched in order against the bank's wording, most specific
 * first. Vague labels ("Personal", "Services", "Other", "Payments and Credits")
 * deliberately map to nothing.
 */

import type { Transaction } from '@/types/models';

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/grocer|supermarket|warehouse club/, 'cat-groceries'],
  [/restaurant|dining|food\s*(&|and)\s*drink|fast food|coffee|bars?\b/, 'cat-dining'],
  [/airline|airfare|lodging|hotel|car rental|travel|vacation/, 'cat-travel'],
  [/\bgas|fuel|automotive|\bauto\b|transport|parking|toll|taxi|rideshare/, 'cat-transport'],
  [/health|medical|pharmac|drug\s?store|wellness|doctor|dental|fitness/, 'cat-health'],
  [/entertainment|recreation|movies|music/, 'cat-entertainment'],
  [/utilit|phone|cable|internet|\bbills\b|telecom|insurance/, 'cat-utilities'],
  [/home improvement|\bhome\b|garden|pets?\b/, 'cat-household'],
  [/education|child|kids|tuition|school/, 'cat-kids'],
  [/gift|donat|charit/, 'cat-gifts'],
  [/\bfees?\b|interest/, 'cat-fees'],
  [/shopping|merchandise|department|retail|clothing|electronics|sporting/, 'cat-shopping'],
];

/** Translate a bank's category wording into one of ours, if it says anything useful. */
export function mapBankCategory(label: string): string | null {
  const text = label.trim().toLowerCase();
  if (!text) return null;
  for (const [pattern, categoryId] of PATTERNS) {
    if (pattern.test(text)) return categoryId;
  }
  return null;
}

/**
 * The bank's category for a row, read from the original CSV record.
 *
 * Read from the stored raw row rather than a mapped column, so it works for
 * files imported before this existed and needs no extra step in the wizard.
 */
export function bankCategoryOf(t: Pick<Transaction, 'raw'>): string | null {
  if (!t.raw) return null;
  for (const [key, value] of Object.entries(t.raw)) {
    if (/^(transaction )?category$/i.test(key.trim()) && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
