/**
 * Amazon order-history parser: Document in, transactions out.
 *
 * Pure by design. Everything about reading Amazon lives here and can be tested
 * against saved HTML with no browser, no network and no account — which matters
 * enormously for a scraper whose target redesigns without warning.
 *
 * The central correctness concern is that **an Amazon order list is not a list
 * of money spent**. Orders get cancelled before they are ever charged, items
 * come back, and refunds are frequently less than the purchase price. Treating
 * the list naively is the main way a tool like this quietly overstates what a
 * household spends.
 */

import { parseMoneyToCents } from '@/lib/money';
import { parseDate } from '@/lib/dates';
import type { ItemStatus, LineItem } from '@/types/models';
import type { RawTransaction, ScrapeResult } from '../types';
import {
  DATE_LABELS,
  ITEM_PRICE_SELECTORS,
  ITEM_SELECTORS,
  ITEM_TITLE_SELECTORS,
  ORDER_CARD_SELECTORS,
  ORDER_NUMBER,
  STATUS_SELECTORS,
  TOTAL_LABELS,
  normalizeStatus,
  queryAllFirstMatch,
  queryFirst,
} from './selectors';

const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * Find the order cards on a page.
 *
 * Tries the known containers first, then falls back to locating elements
 * containing an Amazon order number and walking up to a plausible card. The
 * fallback is what keeps a class rename from producing zero results.
 */
export function findOrderCards(doc: Document): Element[] {
  const direct = queryAllFirstMatch(doc, ORDER_CARD_SELECTORS);
  if (direct.length > 0) return direct;

  const cards = new Set<Element>();
  // Search every element, not just block-level ones: Amazon has put the order
  // number in a span, a div and a table cell across different layouts, and the
  // whole point of this fallback is not to assume the markup.
  for (const el of doc.querySelectorAll('*')) {
    if (el.children.length > 0) continue;
    if (!ORDER_NUMBER.test(text(el))) continue;

    // Walk up until we reach a container that plausibly holds a whole order:
    // it links to at least one product and carries enough text to include the
    // date, total and items.
    let node: Element | null = el;
    for (let depth = 0; node && depth < 8; depth++) {
      if (node.querySelectorAll('a').length >= 1 && text(node).length > 80) break;
      node = node.parentElement;
    }
    if (node && node !== doc.body && node !== doc.documentElement) cards.add(node);
  }

  // Drop any card that contains another: the walk-up can overshoot into a
  // wrapper holding several orders, which would merge them into one row.
  return [...cards].filter((card) => ![...cards].some((other) => other !== card && card.contains(other)));
}

/** Pull a value that sits under a label like "Order placed" or "Total". */
function findLabelledValue(card: Element, labels: readonly string[]): string | null {
  const candidates = card.querySelectorAll('div, span, td, th, dt, dd, p');
  for (const el of candidates) {
    const label = text(el).toLowerCase().replace(/[:.]$/, '');
    if (!labels.includes(label)) continue;

    // The value is usually the next sibling, or the next element inside a
    // shared parent — layouts differ, so try both.
    const sibling = el.nextElementSibling;
    if (sibling && text(sibling)) return text(sibling);

    const parentText = text(el.parentElement);
    const stripped = parentText.slice(text(el).length).trim();
    if (stripped) return stripped;
  }
  return null;
}

/** Extract an order number from a card. */
export function findOrderNumber(card: Element): string | null {
  const match = text(card).match(ORDER_NUMBER);
  return match ? match[0] : null;
}

const MONTH_DATE = /\b([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(\d{4})\b/;

/** Parse an Amazon date string ("March 4, 2025") into ISO. */
export function parseAmazonDate(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(MONTH_DATE);
  if (!match) return null;
  try {
    return parseDate(`${match[1]} ${match[2]}, ${match[3]}`, 'MMM D, YYYY');
  } catch {
    return null;
  }
}

/** Parse the first currency amount in a string. */
function parseFirstAmount(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/[-(]?\s*[$£€]\s?[\d,.]+\)?/);
  if (!match) return null;
  try {
    return Math.abs(parseMoneyToCents(match[0]));
  } catch {
    return null;
  }
}

/**
 * How much of an item was refunded.
 *
 * Amazon shows a refund amount when it knows one. When an item is marked
 * returned but no amount is shown, we do NOT assume the full price came back:
 * restocking fees and unrefunded outbound shipping routinely make the refund
 * smaller. The item is marked `refundPending` instead, so the card's refund
 * credit can settle the true figure during cross-source review.
 */
function readRefund(itemText: string, status: ItemStatus, amountCents: number): {
  refundedCents: number;
  refundPending: boolean;
} {
  const explicit = itemText.match(/refund(?:ed)?[^$£€]{0,24}([$£€]\s?[\d,.]+)/i);
  if (explicit?.[1]) {
    const cents = parseFirstAmount(explicit[1]);
    if (cents !== null) return { refundedCents: Math.min(cents, amountCents), refundPending: false };
  }

  if (status === 'returned' || status === 'refunded') {
    return { refundedCents: 0, refundPending: true };
  }
  return { refundedCents: 0, refundPending: false };
}

/** Read the items inside an order card. */
export function parseItems(card: Element, orderStatus: ItemStatus): LineItem[] {
  const elements = queryAllFirstMatch(card, ITEM_SELECTORS);
  const items: LineItem[] = [];

  for (const el of elements) {
    const titleEl = queryFirst(el, ITEM_TITLE_SELECTORS);
    const name = text(titleEl) || text(el).slice(0, 120);
    if (!name) continue;

    const priceText = text(queryFirst(el, ITEM_PRICE_SELECTORS));
    const amountCents = parseFirstAmount(priceText) ?? 0;

    const elText = text(el);
    const quantityMatch = elText.match(/\bqty:?\s*(\d+)\b/i);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : 1;

    // An item's own status wins over the order's: one item of three can come
    // back while the rest are kept, and that is the common case.
    const itemStatusText = text(queryFirst(el, STATUS_SELECTORS)) || elText;
    const detected = normalizeStatus(itemStatusText);
    const status: ItemStatus = detected === 'unknown' ? orderStatus : detected;

    const { refundedCents, refundPending } = readRefund(elText, status, amountCents);

    const item: LineItem = {
      name,
      quantity,
      amountCents: amountCents * (quantity > 1 && amountCents > 0 ? 1 : 1),
      status,
      refundedCents,
    };
    if (refundPending) item.refundPending = true;
    if (itemStatusText && detected !== 'unknown') item.statusRaw = itemStatusText.slice(0, 120);

    const href = titleEl?.getAttribute('href');
    if (href) {
      item.productUrl = href;
      const asin = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
      if (asin?.[1]) item.asin = asin[1];
    }

    items.push(item);
  }

  return items;
}

/** Parse a single order card into a transaction, or null if unreadable. */
export function parseOrderCard(card: Element): RawTransaction | null {
  const orderNumber = findOrderNumber(card);
  const cardText = text(card);

  const date = parseAmazonDate(findLabelledValue(card, DATE_LABELS)) ?? parseAmazonDate(cardText);
  if (!date) return null;

  const totalCents = parseFirstAmount(findLabelledValue(card, TOTAL_LABELS));

  const statusText = text(queryFirst(card, STATUS_SELECTORS)) || cardText;
  const orderStatus = normalizeStatus(statusText) as ItemStatus;

  const items = parseItems(card, orderStatus === 'unknown' ? 'delivered' : orderStatus);

  // Order-level status: an explicit cancellation on the card wins, because a
  // cancelled order was never charged no matter what its items say.
  const cancelled = /\bcancell?ed\b/i.test(cardText);
  const status: ItemStatus = cancelled ? 'cancelled' : orderStatus === 'unknown' ? 'delivered' : orderStatus;

  const amountCents = totalCents ?? items.reduce((sum, i) => sum + i.amountCents, 0);
  if (amountCents === 0 && items.length === 0) return null;

  const refundedCents = computeOrderRefund(status, amountCents, items);

  const row: RawTransaction = {
    date,
    description: buildDescription(items, orderNumber),
    merchant: 'Amazon',
    // Amazon orders are money out.
    amountCents: -amountCents,
    currency: 'USD',
    accountLabel: 'Amazon',
    status,
    statusRaw: statusText.slice(0, 160),
    refundedCents,
    items,
  };
  if (orderNumber) row.externalId = orderNumber;
  return row;
}

/**
 * How much of an order came back.
 *
 * A cancelled order is handled by `effectiveCents` (it counts as zero), so no
 * refund is recorded for it. Otherwise the refund is the sum of the items that
 * actually came back — which is what makes a partial return subtract only the
 * returned item rather than writing off the whole order.
 */
function computeOrderRefund(status: ItemStatus, amountCents: number, items: readonly LineItem[]): number {
  if (status === 'cancelled') return 0;

  const itemRefunds = items.reduce((sum, i) => sum + i.refundedCents, 0);
  if (itemRefunds > 0) return Math.min(itemRefunds, amountCents);

  // Whole order returned with no amount shown: the refund is not yet known.
  // Recording the full total here would be a guess, and one that quietly
  // erases a restocking fee the household really did pay.
  const returnedItems = items.filter((i) => i.status === 'returned' || i.status === 'refunded');
  if (returnedItems.length > 0 && returnedItems.length === items.length) {
    return 0;
  }
  return 0;
}

function buildDescription(items: readonly LineItem[], orderNumber: string | null): string {
  if (items.length === 0) return orderNumber ? `Amazon order ${orderNumber}` : 'Amazon order';
  const first = items[0]!.name;
  const rest = items.length - 1;
  const summary = rest > 0 ? `${first} and ${rest} more ${rest === 1 ? 'item' : 'items'}` : first;
  return summary.length > 180 ? `${summary.slice(0, 177)}…` : summary;
}

/**
 * Parse a whole order-history page.
 *
 * Reports `staleSelectors` when the page looks like an order list but yielded
 * nothing. Silently importing zero rows would leave the user believing they
 * simply had no orders that year — the single worst failure mode a scraper can
 * have, because it is invisible.
 */
export function parseOrdersPage(doc: Document): ScrapeResult {
  const warnings: string[] = [];
  const cards = findOrderCards(doc);
  const rows: RawTransaction[] = [];

  for (const card of cards) {
    try {
      const row = parseOrderCard(card);
      if (row) rows.push(row);
    } catch (err) {
      warnings.push(`Could not read an order: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const pageText = doc.body?.textContent ?? '';
  const looksLikeOrdersPage = /your orders|order placed|orders placed in|no orders/i.test(pageText);
  const explicitlyEmpty = /no orders (found|placed)/i.test(pageText);

  const result: ScrapeResult = { rows, hasMore: hasNextPage(doc) };
  if (warnings.length > 0) result.warnings = warnings;

  if (rows.length === 0 && looksLikeOrdersPage && !explicitlyEmpty) {
    result.staleSelectors = true;
  }
  return result;
}

/** Is there another page of results? */
export function hasNextPage(doc: Document): boolean {
  const next = doc.querySelector('.a-pagination .a-last:not(.a-disabled) a, a.a-last');
  if (next) return true;
  const nextByText = [...doc.querySelectorAll('a')].some((a) => /^next(\s|$)/i.test(text(a)));
  return nextByText;
}
