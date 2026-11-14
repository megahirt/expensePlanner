/**
 * The bundled directory of well-known merchants.
 *
 * A few thousand brand names, each tied to a category by what kind of business
 * it is. It is built ahead of time from the OpenStreetMap name-suggestion-index
 * (see scripts/build-merchant-directory.mjs) and shipped inside the extension,
 * so looking a merchant up never touches the network.
 *
 * The matching is deliberately cautious. A wrong automatic category is worse
 * than none, and many brand names are ordinary words ("Express", "Subway",
 * "Apple"), so a short name only matches when it is essentially the whole
 * merchant, while a long distinctive one may be the start of a longer name.
 */

import directory from './data/merchant-directory.json';
import { words } from './text';

interface Entry {
  categoryId: string;
  /** Multi-word brand names, which are safe to match as a prefix. */
  distinctive: boolean;
}

const INDEX: ReadonlyMap<string, Entry> = (() => {
  const index = new Map<string, Entry>();
  for (const [categoryId, keys] of Object.entries(directory.categories as Record<string, string[]>)) {
    for (const raw of keys) {
      const multiWord = raw.endsWith('+');
      const key = multiWord ? raw.slice(0, -1) : raw;
      index.set(key, { categoryId, distinctive: multiWord && key.length >= 8 });
    }
  }
  return index;
})();

/**
 * Words that may follow a brand name without changing who the merchant is:
 * "COSTCO WHSE", "SHELL OIL", "CVS PHARMACY", "OLD NAVY US".
 */
const FILLER = new Set([
  'store', 'stores', 'inc', 'llc', 'co', 'corp', 'company', 'usa', 'us', 'online', 'com', 'www', 'whse',
  'wholesale', 'market', 'markets', 'mkt', 'supercenter', 'super', 'center', 'oil', 'gas', 'fuel',
  'station', 'pharmacy', 'restaurant', 'restaurants', 'cafe', 'coffee', 'grill', 'hotel', 'hotels',
  'inn', 'shop', 'shops', 'outlet', 'mobile', 'app', 'pos', 'purchase', 'debit', 'card', 'foods',
  'food', 'grocery', 'tires', 'tire', 'rent', 'a', 'car', 'rental', 'airlines', 'air', 'express',
]);
const isFiller = (word: string): boolean => FILLER.has(word) || /\d/.test(word) || word.length === 1;

export interface DirectoryMatch {
  categoryId: string;
  /** The part of the merchant name that matched, for the explanation. */
  matched: string;
}

/** Look a merchant up in the directory. */
export function lookupMerchant(merchant: string): DirectoryMatch | null {
  let w = words(merchant);
  if (w[0] === 'the') w = w.slice(1);

  // Longest run of leading words first, so "home depot" is tried before "home".
  for (let count = Math.min(w.length, 5); count >= 1; count--) {
    const head = w.slice(0, count);
    const entry = INDEX.get(head.join(''));
    if (!entry) continue;
    if (entry.distinctive || w.slice(count).every(isFiller)) {
      return { categoryId: entry.categoryId, matched: head.join(' ') };
    }
  }
  return null;
}

/** How many names the directory holds, and where they came from. */
export const DIRECTORY_INFO = {
  count: directory.count as number,
  source: directory.source as string,
  version: directory.version as string,
};
