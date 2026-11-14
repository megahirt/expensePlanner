/**
 * Text normalization shared by everything that compares merchant names.
 *
 * Bank descriptions mangle names in predictable ways: "TRADER JOE S",
 * "MCDONALD'S F12345", "LOWES". Comparing on lowercase words with apostrophes
 * removed, and on those words run together, is what lets all of them meet the
 * same clean name.
 */

/** "Trader Joe's #130" -> ["trader", "joes", "130"]. */
export function words(input: string): string[] {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Find the best phrase from a table that appears, as whole words, in a list of
 * words. Longer phrases win, so "dog food" beats "food" and "food bank" beats
 * "food". Matching whole words is what stops "rent" firing on "Trent" or "inn"
 * on "Dinner".
 */
export function findPhrase<T>(
  haystack: readonly string[],
  table: ReadonlyArray<readonly [T, readonly string[]]>,
): { value: T; phrase: string } | null {
  let best: { value: T; phrase: string; size: number } | null = null;
  for (const [value, phrases] of table) {
    for (const phrase of phrases) {
      const needle = phrase.split(' ');
      if (best && needle.length < best.size) continue;
      if (best && needle.length === best.size && phrase.length <= best.phrase.length) continue;
      for (let i = 0; i + needle.length <= haystack.length; i++) {
        if (needle.every((word, j) => haystack[i + j] === word)) {
          best = { value, phrase, size: needle.length };
          break;
        }
      }
    }
  }
  return best ? { value: best.value, phrase: best.phrase } : null;
}
