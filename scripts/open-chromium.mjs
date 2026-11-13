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
 * The demo uses a second profile, .chromium-profile-demo/, so made-up data and
 * real data can never end up in the same place. The first run imports the files
 * in tests/fixtures/demo/ through the real Import screen; later runs find the
 * data already there. Delete that folder to start the demo over.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

/**
 * Import the demo household through the real Import screen, exactly as a person
 * would: drop each bank file, name the account, confirm; then paste the Amazon
 * page. Skipped when the profile already holds data, so reopening the demo
 * keeps whatever categorizing and reviewing was done last time.
 */
async function loadDemoData(page) {
  const { DEMO_ACCOUNTS, DEMO_AMAZON_FILE, DEMO_DIR } = await import('./generate-demo-data.mjs');
  const held = async () =>
    Number(((await page.textContent('.topbar-right')) ?? '').match(/([\d,]+) transactions/)?.[1]?.replace(/,/g, '') ?? '0');

  await page.waitForSelector('.topbar-right:has-text("transactions")', { timeout: 15_000 });
  if ((await held()) > 0) {
    console.log(`Demo data already loaded (${await held()} transactions).`);
    return;
  }

  console.log('Loading the demo household...');
  await page.click('.nav button:has-text("Import")');
  for (const { file, label } of DEMO_ACCOUNTS) {
    await page.waitForSelector('.dropzone');
    await page.setInputFiles('.dropzone input[type=file]', join(DEMO_DIR, file));
    await page.waitForSelector('.wizard');
    await page.fill('.field input[placeholder*="Schwab"]', label);
    await page.click('.actions button.primary');
    await page.waitForSelector('.callout.ok', { timeout: 30_000 });
    console.log(`  ${label}: ${((await page.textContent('.callout.ok')) ?? '').replace(/\s+/g, ' ').trim()}`);
  }

  await page.click('button:has-text("Paste a saved page instead")');
  await page.fill('.card textarea', readFileSync(join(DEMO_DIR, DEMO_AMAZON_FILE), 'utf8'));
  await page.click('button:has-text("Read this page")');
  await page.waitForSelector('.card .callout.ok', { timeout: 30_000 });
  console.log(`  Amazon: ${((await page.textContent('.card .callout.ok')) ?? '').trim()}`);

  await page.click('.nav button:has-text("Dashboard")');
  console.log(`Demo ready: ${await held()} transactions. Nothing in Review has been confirmed yet.`);
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
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  console.log(`Dev Chromium is open with expensePlanner loaded (${extensionId}).`);
  if (DEMO) await loadDemoData(page);
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
