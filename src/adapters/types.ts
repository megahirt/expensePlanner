/**
 * The adapter interface every data source implements.
 *
 * Two kinds share one interface so that adding a bank later is a single file
 * plus a line in the registry, and so the import pipeline (dedupe, batching,
 * categorization, undo) is written once rather than per source.
 *
 * `scrape` takes a Document and returns rows — deliberately pure. That is what
 * lets a scraper be unit-tested against saved HTML with no browser, no network
 * and no account, which matters enormously for a scraper whose target site
 * redesigns without warning.
 */

import type { ColumnMapping, ItemStatus, LineItem } from '@/types/models';

/** A transaction as an adapter produces it, before ids and categories. */
export interface RawTransaction {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  description: string;
  /** Signed cents. Negative = money out. */
  amountCents: number;
  currency?: string;
  accountLabel?: string;
  externalId?: string;
  status?: ItemStatus;
  statusRaw?: string;
  refundedCents?: number;
  items?: LineItem[];
  /** Merchant override; otherwise derived from `description`. */
  merchant?: string;
  raw?: Record<string, unknown>;
}

/** What a scrape run produced, plus enough context to report honest failures. */
export interface ScrapeResult {
  rows: RawTransaction[];
  /**
   * Set when the page loaded but produced nothing recognisable — almost always
   * a sign the site changed its markup. Surfacing this is the difference
   * between "Amazon selectors need updating" and silently importing zero rows
   * and letting the user believe they had no orders.
   */
  staleSelectors?: boolean;
  /** True when another page of results is available. */
  hasMore?: boolean;
  warnings?: string[];
}

export interface FileAdapter {
  id: string;
  label: string;
  kind: 'file';
  /** Extensions this adapter can handle, e.g. ['.csv', '.tsv']. */
  extensions: string[];
  /**
   * Confidence (0-1) that this adapter should handle the file, given its
   * headers. Lets a bank-specific adapter outrank the generic CSV one.
   */
  sniff(headers: readonly string[], sample: readonly string[][]): number;
  parse(input: ParseInput): Promise<RawTransaction[]>;
}

export interface ParseInput {
  text: string;
  fileName: string;
  mapping: ColumnMapping;
}

export interface ScraperAdapter {
  id: string;
  label: string;
  kind: 'scraper';
  /** Host permission this adapter needs, requested at the moment it is used. */
  hostPermission: string;
  matchesUrl(url: string): boolean;
  scrape(doc: Document): ScrapeResult;
}

export type SourceAdapter = FileAdapter | ScraperAdapter;

export function isFileAdapter(a: SourceAdapter): a is FileAdapter {
  return a.kind === 'file';
}

export function isScraperAdapter(a: SourceAdapter): a is ScraperAdapter {
  return a.kind === 'scraper';
}
