/**
 * Suggesting a category from merchants already categorized.
 *
 * When a merchant is new, the household has often already dealt with something
 * very like it: "Fern & Finch Cafe" when "Fern & Finch Roasters" is filed, or
 * "Greenwood Auto Repair" next to "Greenwood Auto Body". This finds the closest
 * known merchant by name and proposes its category.
 *
 * It only ever *suggests*. Name similarity is a guess (two "Greenwood"
 * businesses can be a vet and a mechanic), so nothing here is applied without
 * a click.
 */

import { words } from './text';

/** Words too common in merchant names to count as evidence of similarity. */
const COMMON = new Set([
  'the', 'of', 'and', 'inc', 'llc', 'co', 'corp', 'company', 'store', 'stores', 'shop', 'online', 'com',
  'www', 'payment', 'payments', 'pmt', 'ach', 'bill', 'billpay', 'usa', 'us', 'north', 'south', 'east',
  'west', 'city', 'county', 'st', 'new', 'services', 'service', 'group', 'center', 'market',
]);

const signature = (merchant: string): string[] => words(merchant).filter((w) => w.length > 2 && !COMMON.has(w) && !/\d/.test(w));

const trigrams = (s: string): Set<string> => {
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) grams.add(s.slice(i, i + 3));
  return grams;
};

/** 0 to 1. Shared whole words count most; shared letter runs catch misspellings. */
export function merchantSimilarity(a: string, b: string): number {
  const wa = signature(a);
  const wb = signature(b);
  if (wa.length === 0 || wb.length === 0) return 0;

  const setB = new Set(wb);
  const shared = wa.filter((w) => setB.has(w)).length;
  const wordScore = shared / (new Set([...wa, ...wb]).size || 1);
  // Sharing the leading word is a strong sign: it is nearly always the brand.
  const lead = wa[0] === wb[0] && wa[0]!.length >= 4 ? 0.25 : 0;

  const ga = trigrams(wa.join(''));
  const gb = trigrams(wb.join(''));
  let overlap = 0;
  for (const g of ga) if (gb.has(g)) overlap++;
  const letterScore = ga.size + gb.size === 0 ? 0 : (2 * overlap) / (ga.size + gb.size);

  return Math.min(1, Math.max(wordScore + lead, letterScore * 0.9));
}

export interface SimilarSuggestion {
  categoryId: string;
  /** The already-categorized merchant this one resembles. */
  similarTo: string;
  score: number;
}

/** How alike two names must be before a suggestion is worth showing. */
const THRESHOLD = 0.55;

/**
 * Suggest a category for a merchant from the ones already categorized.
 * @param known merchant name -> category id, for merchants the household has settled.
 */
export function suggestFromSimilar(
  merchant: string,
  known: ReadonlyMap<string, string>,
): SimilarSuggestion | null {
  let best: SimilarSuggestion | null = null;
  for (const [other, categoryId] of known) {
    if (other === merchant) continue;
    const score = merchantSimilarity(merchant, other);
    if (score >= THRESHOLD && (!best || score > best.score)) best = { categoryId, similarTo: other, score };
  }
  return best;
}
