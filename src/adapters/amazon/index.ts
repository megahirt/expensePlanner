/**
 * Amazon adapter registration.
 *
 * The reading logic lives in `parse.ts` as a pure Document-to-rows function;
 * this is only the registry entry that names it and says which pages it claims.
 */

import { AMAZON_HOST_PERMISSION } from '@/background/amazon';
import type { ScraperAdapter } from '../types';
import { parseOrdersPage } from './parse';

export const amazonAdapter: ScraperAdapter = {
  id: 'amazon',
  label: 'Amazon orders',
  kind: 'scraper',
  hostPermission: AMAZON_HOST_PERMISSION,
  matchesUrl: (url) => /^https:\/\/www\.amazon\.com\/(your-orders|gp\/css\/order-history)/.test(url),
  scrape: parseOrdersPage,
};

export { parseOrdersPage };
