/**
 * MV3 service worker.
 *
 * Two jobs: open the app when the toolbar icon is clicked, and orchestrate
 * scraping runs (which need to outlive any single page). Scrape orchestration
 * lands in `background/scrape.ts` in a later phase; for now the worker owns the
 * action click and the message router.
 */

const APP_PAGE = 'app.html';

chrome.action.onClicked.addListener(() => {
  void openApp();
});

/** Focus an already-open app tab rather than piling up duplicates. */
async function openApp(): Promise<void> {
  const url = chrome.runtime.getURL(APP_PAGE);
  const existing = await chrome.tabs.query({ url });
  const first = existing[0];
  if (first?.id !== undefined) {
    await chrome.tabs.update(first.id, { active: true });
    if (first.windowId !== undefined) await chrome.windows.update(first.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void openApp();
});

export type WorkerRequest = { type: 'ping' };
export type WorkerResponse = { type: 'pong'; version: string };

chrome.runtime.onMessage.addListener((message: WorkerRequest, _sender, sendResponse) => {
  if (message?.type === 'ping') {
    sendResponse({ type: 'pong', version: chrome.runtime.getManifest().version } satisfies WorkerResponse);
    return false;
  }
  return false;
});
