/**
 * Amazon order-history content script.
 *
 * Deliberately thin: it hands the page's DOM to a pure parser and posts the
 * result back. Keeping the parsing pure (Document in, rows out) is what lets the
 * whole scraper be unit-tested against saved HTML with no browser and no
 * account — see `adapters/amazon/`. Filled in during phase 6.
 */

export {};
