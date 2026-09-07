import { describe, expect, it } from 'vitest';
import { ADAPTERS, getAdapter, pickFileAdapter, pickScraperForUrl } from '@/adapters/registry';
import { isFileAdapter, isScraperAdapter, type FileAdapter } from '@/adapters/types';

describe('adapter registry', () => {
  it('registers both kinds of source', () => {
    expect(getAdapter('csv')).toBeDefined();
    expect(getAdapter('amazon')).toBeDefined();
    expect(ADAPTERS.filter(isFileAdapter).length).toBeGreaterThan(0);
    expect(ADAPTERS.filter(isScraperAdapter).length).toBeGreaterThan(0);
  });

  it('gives every adapter a unique id, since ids key stored sources', () => {
    const ids = ADAPTERS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back to the generic CSV adapter for an unknown bank', () => {
    expect(pickFileAdapter(['Date', 'Description', 'Amount'], [])?.id).toBe('csv');
  });

  it('lets a bank-specific adapter outrank the generic one', () => {
    // Proves the extension point works: a future adapter with higher confidence
    // takes precedence without any calling code changing.
    const specific: FileAdapter = {
      id: 'test-bank',
      label: 'Test Bank',
      kind: 'file',
      extensions: ['.csv'],
      sniff: (headers) => (headers.includes('TestBankRef') ? 0.9 : 0),
      parse: async () => [],
    };
    ADAPTERS.push(specific);
    try {
      expect(pickFileAdapter(['Date', 'TestBankRef', 'Amount'], [])?.id).toBe('test-bank');
      expect(pickFileAdapter(['Date', 'Description', 'Amount'], [])?.id).toBe('csv');
    } finally {
      ADAPTERS.pop();
    }
  });

  it('routes Amazon order pages to the Amazon scraper', () => {
    expect(pickScraperForUrl('https://www.amazon.com/your-orders/orders?timeFilter=year-2025')?.id).toBe(
      'amazon',
    );
    expect(pickScraperForUrl('https://www.amazon.com/gp/css/order-history')?.id).toBe('amazon');
    expect(pickScraperForUrl('https://www.amazon.com/dp/B08N5WRWNW')).toBeUndefined();
    expect(pickScraperForUrl('https://example.com/your-orders')).toBeUndefined();
  });
});
