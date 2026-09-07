/**
 * Amazon order-history content script.
 *
 * Deliberately thin. It runs the pure parser against the live document and
 * posts the rows back; all the reading logic lives in `adapters/amazon/parse`
 * where it can be tested against saved HTML. Parsing has to happen here rather
 * than in the service worker because MV3 workers have no DOM and therefore no
 * DOMParser.
 */

import { parseOrdersPage } from '@/adapters/amazon/parse';

export interface ParsePageRequest {
  type: 'amazon:parse';
}

const MARKER = '__expensePlannerAmazonReady';

declare global {
  interface Window {
    [MARKER]?: boolean;
  }
}

// The worker injects this file on every navigation; without a guard the
// listener would stack up and answer the same message several times.
if (!window[MARKER]) {
  window[MARKER] = true;

  chrome.runtime.onMessage.addListener((message: ParsePageRequest, _sender, sendResponse) => {
    if (message?.type !== 'amazon:parse') return false;
    try {
      sendResponse({ ok: true, result: parseOrdersPage(document) });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return false;
  });
}
