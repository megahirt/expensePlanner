/**
 * Drives an Amazon order-history scrape from the service worker.
 *
 * The worker owns this because a scrape outlives any single page: it walks a
 * year of orders one page at a time, and the tab it drives is navigating
 * underneath it the whole while.
 *
 * Three deliberate constraints:
 *   - a delay between page loads, because hammering someone's order history is
 *     both rude and a good way to get rate-limited;
 *   - a hard page cap, so a pagination bug cannot loop forever;
 *   - stale-selector detection surfaced immediately, because a scraper that
 *     silently returns nothing is worse than one that fails loudly.
 */

import type { RawTransaction, ScrapeResult } from '@/adapters/types';

export const AMAZON_ORIGIN = 'https://www.amazon.com';
export const AMAZON_HOST_PERMISSION = `${AMAZON_ORIGIN}/*`;
const ORDERS_URL = `${AMAZON_ORIGIN}/your-orders/orders`;

/** Orders per page in Amazon's own pagination. */
const PAGE_SIZE = 10;
const MAX_PAGES_PER_YEAR = 40;
const DELAY_BETWEEN_PAGES_MS = 1200;
const PAGE_LOAD_TIMEOUT_MS = 30_000;

export interface ScrapeProgress {
  type: 'amazon:progress';
  year: number;
  page: number;
  ordersSoFar: number;
  message: string;
}

export interface ScrapeRunResult {
  rows: RawTransaction[];
  warnings: string[];
  /** True if any page looked like an order list but yielded nothing. */
  staleSelectors: boolean;
  pagesRead: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pageUrl(year: number, startIndex: number): string {
  return `${ORDERS_URL}?timeFilter=year-${year}&startIndex=${startIndex}`;
}

/** Wait for a tab to finish loading, or give up rather than hang forever. */
async function waitForTabLoad(tabId: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    if (Date.now() - started > PAGE_LOAD_TIMEOUT_MS) {
      throw new Error('Amazon page took too long to load');
    }
    await wait(250);
  }
}

/** Inject the parser and ask it to read the current page. */
async function parseTab(tabId: number): Promise<ScrapeResult> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-amazon.js'] });

  const response = (await chrome.tabs.sendMessage(tabId, { type: 'amazon:parse' })) as
    | { ok: true; result: ScrapeResult }
    | { ok: false; error: string }
    | undefined;

  if (!response) throw new Error('No response from the Amazon page');
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

/**
 * Scrape the given years of order history.
 *
 * Runs in a tab the user can watch. If Amazon asks them to sign in, the scrape
 * simply finds no orders and reports stale selectors, which is the honest
 * outcome — we cannot and should not handle their credentials.
 */
export async function scrapeAmazonYears(
  years: readonly number[],
  onProgress?: (p: ScrapeProgress) => void,
): Promise<ScrapeRunResult> {
  const rows: RawTransaction[] = [];
  const warnings: string[] = [];
  let staleSelectors = false;
  let pagesRead = 0;

  const tab = await chrome.tabs.create({ url: pageUrl(years[0] ?? new Date().getFullYear(), 0), active: true });
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('Could not open a tab for Amazon');

  try {
    for (const year of years) {
      let sawAnyOrderThisYear = false;

      for (let page = 0; page < MAX_PAGES_PER_YEAR; page++) {
        const url = pageUrl(year, page * PAGE_SIZE);
        await chrome.tabs.update(tabId, { url });
        await waitForTabLoad(tabId);
        // Amazon renders parts of the list after load; give it a moment.
        await wait(600);

        const result = await parseTab(tabId);
        pagesRead++;

        if (result.warnings) warnings.push(...result.warnings);
        if (result.rows.length > 0) sawAnyOrderThisYear = true;
        rows.push(...result.rows);

        onProgress?.({
          type: 'amazon:progress',
          year,
          page: page + 1,
          ordersSoFar: rows.length,
          message: `${year}: read page ${page + 1}, ${rows.length} orders so far`,
        });

        // A page that looks like an order list but yields nothing means the
        // markup moved. Say so instead of quietly finishing with no data.
        if (result.staleSelectors && !sawAnyOrderThisYear && page === 0) {
          staleSelectors = true;
          break;
        }

        if (!result.hasMore || result.rows.length === 0) break;
        await wait(DELAY_BETWEEN_PAGES_MS);
      }
    }
  } finally {
    // Leave the user's browser as we found it.
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* the user may have closed it themselves */
    }
  }

  return { rows, warnings, staleSelectors, pagesRead };
}

/** Years offered in the UI, newest first. */
export function selectableYears(now = new Date()): number[] {
  const current = now.getFullYear();
  return Array.from({ length: 6 }, (_, i) => current - i);
}
