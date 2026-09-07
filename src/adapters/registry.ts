/**
 * The adapter registry.
 *
 * Adding a source is a file plus a line here. Everything downstream — content
 * addressing, duplicate detection, batching, undo, categorization, export —
 * is written once against the interface in `types.ts` and inherited.
 *
 * Note that most banks need no adapter at all: the generic CSV adapter plus a
 * saved column mapping covers them, because what differs between institutions
 * is data, not behaviour. Write an adapter only when a source needs handling
 * the mapping wizard cannot express.
 */

import { csvAdapter } from './csv';
import { amazonAdapter } from './amazon';
import type { FileAdapter, ScraperAdapter, SourceAdapter } from './types';
import { isFileAdapter, isScraperAdapter } from './types';

export const ADAPTERS: SourceAdapter[] = [csvAdapter, amazonAdapter];

export function fileAdapters(): FileAdapter[] {
  return ADAPTERS.filter(isFileAdapter);
}

export function scraperAdapters(): ScraperAdapter[] {
  return ADAPTERS.filter(isScraperAdapter);
}

export function getAdapter(id: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

/**
 * Choose the adapter best suited to a file.
 *
 * Bank-specific adapters return a higher confidence than the generic CSV one,
 * so adding a specialised adapter later automatically takes precedence for the
 * files it recognises without changing any calling code.
 */
export function pickFileAdapter(
  headers: readonly string[],
  sample: readonly string[][],
): FileAdapter | undefined {
  let best: { adapter: FileAdapter; score: number } | undefined;
  for (const adapter of fileAdapters()) {
    const score = adapter.sniff(headers, sample);
    if (score > 0 && (!best || score > best.score)) best = { adapter, score };
  }
  return best?.adapter;
}

/** The scraper that handles a given URL, if any. */
export function pickScraperForUrl(url: string): ScraperAdapter | undefined {
  return scraperAdapters().find((a) => a.matchesUrl(url));
}
