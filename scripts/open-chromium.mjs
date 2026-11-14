#!/usr/bin/env node
/**
 * `npm run chromium` — build the extension and open a visible Chromium window
 * with it loaded, for hands-on testing without the "Load unpacked" steps.
 *
 * - Its own browser profile in .chromium-profile/ (gitignored). Sign in to
 *   Amazon there once and it stays signed in; imported data persists between
 *   runs. Your everyday Chrome and its accounts are never touched.
 * - Rerun the command after a code change: it rebuilds and reopens.
 * - Chromium's DevTools protocol listens on 127.0.0.1:9334 (this machine only)
 *   so a coding assistant can attach to this window to see what you see.
 *   Close the window, or press Ctrl-C here, to stop.
 *
 *   npm run chromium               # rebuild, then open
 *   npm run chromium -- --no-build # skip the rebuild
 *   npm run chromium:demo          # open with a made-up household loaded
 *
 * The demo household ships inside the extension, in its own database, and the
 * app can switch to it from Settings in any window. `chromium:demo` just opens
 * straight into it. It keeps a second profile, .chromium-profile-demo/, only so
 * the demo window and the normal one can be open at the same time.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const DEMO = process.argv.includes('--demo');
const PROFILE = join(ROOT, DEMO ? '.chromium-profile-demo' : '.chromium-profile');
// 9333 is used by the same script in another project; stay clear of it. The
// demo gets its own port so both windows can be open at once.
const DEBUG_PORT = DEMO ? 9335 : 9334;

if (!process.argv.includes('--no-build')) {
  const built = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status || 1);
}
if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('No dist/ build found — run `npm run build` first.');
  process.exit(1);
}

mkdirSync(PROFILE, { recursive: true });
// Chromium caches an extension's service worker in the profile and can keep
// running a stale copy after dist/ is rebuilt. Clear that cache on every launch
// so the window always runs the build just made. Sign-ins live in cookies and
// the app's data in IndexedDB, neither of which this touches.
rmSync(join(PROFILE, 'Default', 'Service Worker'), { recursive: true, force: true });

/** Wait for the demo household, which the app loads itself on first opening. */
async function waitForDemo(page) {
  await page.waitForSelector('.demo-banner', { timeout: 15_000 });
  await page.waitForSelector('.topbar-right:has-text("transactions")', { timeout: 60_000 });
  const held = ((await page.textContent('.topbar-right')) ?? '').match(/([\d,]+) transactions/)?.[1] ?? '0';
  console.log(`Demo household is showing: ${held} transactions. Your own data is a switch away in Settings.`);
}

let context;
try {
  context = await chromium.launchPersistentContext(PROFILE, {
    // The full browser, not the headless shell, which cannot load extensions.
    channel: 'chromium',
    headless: false,
    viewport: null, // use the real window size
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      '--window-size=1400,900',
    ],
  });
} catch (err) {
  if (/ProcessSingleton|already in use/i.test(String(err))) {
    console.error('The dev Chromium window is already open. Close it first, then rerun.');
    process.exit(1);
  }
  throw err;
}

try {
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`chrome-extension://${extensionId}/app.html${DEMO ? '?workspace=demo' : ''}`);
  console.log(`Dev Chromium is open with expensePlanner loaded (${extensionId}).`);
  if (DEMO) await waitForDemo(page);
} catch (err) {
  console.log(`Chromium is open, but setup did not finish: ${err instanceof Error ? err.message : err}`);
}
console.log(`DevTools protocol: http://127.0.0.1:${DEBUG_PORT} (this machine only).`);
console.log('Close the window or press Ctrl-C to stop.');

const stop = async () => {
  await context.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
context.on('close', () => process.exit(0));
