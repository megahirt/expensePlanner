/**
 * Loads the built extension in real Chromium and asserts the app page renders.
 *
 * This is the check that a unit test cannot make: that `dist/` is a valid MV3
 * extension Chrome will actually accept, that the manifest paths resolve, and
 * that the service worker registers without throwing.
 *
 * Usage: npm run build && node scripts/smoke.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = join(root, 'dist');

if (!existsSync(join(distPath, 'manifest.json'))) {
  console.error('dist/manifest.json missing — run `npm run build` first.');
  process.exit(1);
}

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/**
 * Find a Chromium that is actually on disk.
 *
 * The preinstalled browser and the npm `playwright` package can disagree about
 * the expected revision, and extensions cannot be loaded into the headless
 * shell, so we locate a full `chrome` binary rather than trusting the default.
 */
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  const candidates = readdirSync(base)
    .filter((d) => d.startsWith('chromium-'))
    .map((d) => join(base, d, 'chrome-linux', 'chrome'))
    .filter((p) => existsSync(p));
  return candidates[0];
}

const executablePath = findChromium();
if (executablePath) console.log(`Using Chromium at ${executablePath}\n`);

const userDataDir = mkdtempSync(join(tmpdir(), 'ep-smoke-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  // Extensions require a headed context; the new headless mode supports them.
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: [
    `--disable-extensions-except=${distPath}`,
    `--load-extension=${distPath}`,
    '--no-sandbox',
  ],
});

try {
  // Chrome assigns an extension id only if it accepted the manifest at all.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  check('extension loads and service worker registers', Boolean(extensionId), extensionId);

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  await page.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: 'load' });
  await page.waitForSelector('.app', { timeout: 10_000 });

  check('app page renders React root', await page.isVisible('.brand'));
  check(
    'navigation is present',
    (await page.locator('.nav button').count()) >= 3,
    `${await page.locator('.nav button').count()} tabs`,
  );
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // IndexedDB must be usable from the extension origin — everything depends on it.
  const idbOk = await page.evaluate(async () => {
    return await new Promise((res) => {
      const req = indexedDB.open('smoke-probe', 1);
      req.onsuccess = () => {
        req.result.close();
        indexedDB.deleteDatabase('smoke-probe');
        res(true);
      };
      req.onerror = () => res(false);
    });
  });
  check('IndexedDB available on the extension origin', idbOk === true);
} finally {
  await context.close();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
