/**
 * Every Amazon DOM assumption, in one file.
 *
 * Amazon redesigns its order history without notice and runs several layouts
 * concurrently across A/B tests and regions. Isolating the selectors means
 * repairing a break is editing this file, not hunting through parsing logic —
 * and each entry is a fallback chain rather than a single brittle string.
 *
 * The strongest anchor is not a CSS class at all: Amazon order numbers have the
 * fixed shape 123-4567890-1234567, which has survived every redesign. Where the
 * markup is uncertain we look for that pattern and work outward, so a class
 * rename degrades the parse rather than breaking it.
 */

/** Amazon order number, e.g. 114-8765432-1234567. */
export const ORDER_NUMBER = /\b\d{3}-\d{7}-\d{7}\b/;

/** Containers that have held a single order across Amazon's layouts. */
export const ORDER_CARD_SELECTORS = [
  '.order-card',
  '.js-order-card',
  '[data-order-id]',
  '.order',
  '.a-box-group.order',
  '[class*="order-card"]',
];

/** Elements holding a single purchased item within an order. */
export const ITEM_SELECTORS = [
  '.yohtmlc-item',
  '[data-component="itemTitle"]',
  '.a-fixed-left-grid-inner .a-col-right',
  '.item-box',
  '.shipment .a-fixed-left-grid',
];

/** The item's product title link. */
export const ITEM_TITLE_SELECTORS = [
  '.yohtmlc-product-title',
  '[data-component="itemTitle"] a',
  'a.a-link-normal[href*="/dp/"]',
  'a.a-link-normal[href*="/gp/product/"]',
  '.a-link-normal',
];

/** Per-item price. */
export const ITEM_PRICE_SELECTORS = [
  '.yohtmlc-item-price',
  '[data-component="unitPrice"]',
  '.a-color-price',
  '.a-price .a-offscreen',
];

/** Shipment or item status text ("Delivered", "Return complete", …). */
export const STATUS_SELECTORS = [
  '.delivery-box__primary-text',
  '.js-shipment-info-container .a-text-bold',
  '[data-component="shipmentStatus"]',
  '.shipment-top-row .a-text-bold',
  '.a-color-success',
];

/** Labels Amazon puts above the order total, across layouts and locales. */
export const TOTAL_LABELS = ['total', 'order total', 'grand total'];

/** Labels above the order date. */
export const DATE_LABELS = ['order placed', 'ordered on', 'order date', 'placed on'];

/**
 * Status text to normalized status.
 *
 * Ordered most specific first: "Return complete" must be recognised before a
 * looser "return" check, and "refund" must not be mistaken for a plain
 * delivery. Anything unrecognised becomes 'unknown' and keeps its original
 * wording, so a new Amazon phrase shows up in the UI instead of being silently
 * treated as a normal delivered purchase.
 */
export const STATUS_PATTERNS: Array<{ pattern: RegExp; status: AmazonStatus }> = [
  { pattern: /\bcancell?ed\b/i, status: 'cancelled' },
  { pattern: /return\s+complete/i, status: 'returned' },
  { pattern: /\brefund(ed)?\s+(complete|issued|to)\b/i, status: 'refunded' },
  { pattern: /\breturned\b/i, status: 'returned' },
  { pattern: /return\s+(started|initiated|in\s+progress|received)/i, status: 'return_started' },
  { pattern: /\brefund\s+(pending|processing|on the way)\b/i, status: 'return_started' },
  { pattern: /\brefunded\b/i, status: 'refunded' },
  { pattern: /\bdelivered\b/i, status: 'delivered' },
  { pattern: /\b(shipped|out for delivery|arriving|on the way)\b/i, status: 'shipped' },
  { pattern: /\b(ordered|preparing for shipment|not yet shipped)\b/i, status: 'ordered' },
];

export type AmazonStatus =
  | 'ordered'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'return_started'
  | 'returned'
  | 'refunded'
  | 'unknown';

/** Match a status string to a normalized status. */
export function normalizeStatus(text: string | null | undefined): AmazonStatus {
  if (!text) return 'unknown';
  for (const { pattern, status } of STATUS_PATTERNS) {
    if (pattern.test(text)) return status;
  }
  return 'unknown';
}

/** Find the first element matching any selector in a chain. */
export function queryFirst(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    try {
      const found = root.querySelector(selector);
      if (found) return found;
    } catch {
      /* an invalid selector should never break the whole parse */
    }
  }
  return null;
}

/** Find all elements matching the first selector in a chain that matches anything. */
export function queryAllFirstMatch(root: ParentNode, selectors: readonly string[]): Element[] {
  for (const selector of selectors) {
    try {
      const found = root.querySelectorAll(selector);
      if (found.length > 0) return [...found];
    } catch {
      /* skip invalid selector */
    }
  }
  return [];
}
