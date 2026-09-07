import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { parseOrdersPage } from '@/adapters/amazon/parse';
import { normalizeStatus } from '@/adapters/amazon/selectors';
import { toTransactions } from '@/lib/import';
import { totals } from '@/lib/filter';
import { DEFAULT_CATEGORIES, defaultRules } from '@/categorize/defaults';

const load = (name: string): Document =>
  new JSDOM(readFileSync(join(__dirname, 'fixtures', 'amazon', name), 'utf8')).window.document;

const mixed = () => parseOrdersPage(load('orders-mixed.html'));
const byOrder = (id: string) => mixed().rows.find((r) => r.externalId === id);

describe('normalizeStatus', () => {
  it('recognises the wording Amazon actually uses', () => {
    expect(normalizeStatus('Delivered March 6')).toBe('delivered');
    expect(normalizeStatus('Cancelled')).toBe('cancelled');
    expect(normalizeStatus('Return complete')).toBe('returned');
    expect(normalizeStatus('Return started')).toBe('return_started');
    expect(normalizeStatus('Refund issued to your Visa')).toBe('refunded');
    expect(normalizeStatus('Arriving tomorrow')).toBe('shipped');
  });

  it('reports unfamiliar wording rather than assuming a normal purchase', () => {
    // A new Amazon phrase must surface as unknown, not silently count as spend.
    expect(normalizeStatus('Held at customs pending inspection')).toBe('unknown');
    expect(normalizeStatus('')).toBe('unknown');
  });
});

describe('parseOrdersPage', () => {
  it('finds every order on the page', () => {
    expect(mixed().rows).toHaveLength(5);
    expect(mixed().hasMore).toBe(true);
  });

  it('reads a normal order with its items', () => {
    const order = byOrder('114-8765432-1234567');
    expect(order).toMatchObject({ date: '2025-03-04', amountCents: -7842, status: 'delivered' });
    expect(order?.items).toHaveLength(2);
    expect(order?.items?.[0]).toMatchObject({ name: 'Echo Dot (4th Gen)', amountCents: 4999, asin: 'B08N5WRWNW' });
    expect(order?.items?.[1]?.quantity).toBe(2);
  });

  it('marks a cancelled order and records no refund for it', () => {
    // A cancelled order was never charged, so there is nothing to refund; it
    // simply must not count. Recording a refund would be inventing a credit.
    const order = byOrder('114-1111111-2222222');
    expect(order?.status).toBe('cancelled');
    expect(order?.refundedCents).toBe(0);
  });

  it('uses the refund amount Amazon states, not the purchase price', () => {
    // $89.00 keyboard, $82.00 refunded: the $7 restocking fee was really spent.
    const order = byOrder('114-3333333-4444444');
    expect(order?.status).toBe('returned');
    expect(order?.refundedCents).toBe(8200);
  });

  it('subtracts only the returned item from a partial return', () => {
    // The order stays delivered; one $70 item of a $120 order came back. This
    // is the case that per-item parsing exists for.
    const order = byOrder('114-5555555-6666666');
    expect(order?.amountCents).toBe(-12000);
    expect(order?.refundedCents).toBe(7000);
    expect(order?.items?.filter((i) => i.status === 'returned')).toHaveLength(1);
    expect(order?.items?.filter((i) => i.status === 'delivered')).toHaveLength(2);
  });

  it('does not guess a refund amount that Amazon has not stated', () => {
    // Return started, no amount shown. Assuming the full price would erase a
    // restocking fee the household may still end up paying; the card credit
    // settles the real figure during review instead.
    const order = byOrder('114-7777777-8888888');
    expect(order?.status).toBe('return_started');
    expect(order?.refundedCents).toBe(0);
    expect(order?.items?.[0]?.refundPending).toBeUndefined();
  });

  it('keeps the original status wording for inspection', () => {
    expect(byOrder('114-3333333-4444444')?.statusRaw).toContain('Return complete');
  });
});

describe('resilience', () => {
  it('still finds orders when every known class name has changed', () => {
    // The order-number pattern has survived every Amazon redesign, so it is
    // the anchor of last resort when the CSS classes are gone.
    const result = parseOrdersPage(load('orders-redesigned.html'));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ date: '2026-01-08', externalId: '114-9999999-0000000' });
    expect(result.staleSelectors).toBeFalsy();
  });

  it('treats a genuinely empty year as empty, not broken', () => {
    const result = parseOrdersPage(load('orders-empty.html'));
    expect(result.rows).toHaveLength(0);
    expect(result.staleSelectors).toBeFalsy();
  });

  it('reports stale selectors when an orders page yields nothing', () => {
    // The worst failure a scraper can have is the invisible one: importing zero
    // rows and letting the user believe they had no orders.
    const result = parseOrdersPage(load('orders-broken.html'));
    expect(result.rows).toHaveLength(0);
    expect(result.staleSelectors).toBe(true);
  });
});

describe('what the parsed orders actually total', () => {
  it('counts only money genuinely spent', () => {
    const transactions = toTransactions(mixed().rows, {
      sourceId: 'amazon',
      batchId: 'b',
      rules: defaultRules(),
      categories: DEFAULT_CATEGORIES,
    });

    // Face value of all five orders: 78.42 + 129.99 + 89.00 + 120.00 + 45.50 = 462.91
    // What was really spent:
    //   78.42  delivered in full
    //    0.00  cancelled, never charged
    //    7.00  89.00 charged less 82.00 refunded
    //   50.00  120.00 less the 70.00 returned item
    //   45.50  return started, nothing refunded yet
    //  ------
    //  180.92
    expect(totals(transactions).spentCents).toBe(18092);
  });

  it('is categorized as Amazon shopping', () => {
    const transactions = toTransactions(mixed().rows, {
      sourceId: 'amazon',
      batchId: 'b',
      rules: defaultRules(),
      categories: DEFAULT_CATEGORIES,
    });
    expect(transactions[0]?.merchant).toBe('Amazon');
    expect(transactions[0]?.categoryId).toBe('cat-shopping');
  });
});
