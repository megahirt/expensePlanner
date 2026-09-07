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
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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

  // ---- End-to-end import through the real UI ----
  // A unit test can prove the parser works; only this can prove the wired-up
  // app does. Drive the actual file input, mapping wizard and import button.
  await page.click('.nav button:has-text("Import")');
  await page.waitForSelector('.dropzone');

  const fixture = join(root, 'tests', 'fixtures', 'schwab-checking.csv');
  await page.setInputFiles('.dropzone input[type=file]', fixture);

  await page.waitForSelector('.wizard', { timeout: 10_000 });
  check(
    'mapping wizard detects the columns',
    (await page.locator('.preview tbody tr').count()) > 0,
    `${await page.locator('.preview tbody tr').count()} preview rows`,
  );

  await page.click('.actions button.primary');
  await page.waitForSelector('.callout.ok', { timeout: 10_000 });
  const summary = (await page.textContent('.callout.ok')) ?? '';
  check('import reports rows added', /5 added/.test(summary), summary.replace(/\s+/g, ' ').trim());

  // Re-importing the identical file must add nothing. This is the property the
  // monthly refresh workflow depends on, verified against the real database.
  await page.setInputFiles('.dropzone input[type=file]', fixture);
  await page.waitForSelector('.wizard', { timeout: 10_000 });

  const notes = (await page.textContent('.notes')) ?? '';
  check('saved mapping is reused on the second import', /saved mapping/i.test(notes), notes.trim());

  await page.click('.actions button.primary');
  await page.waitForSelector('.callout.ok', { timeout: 10_000 });
  const second = (await page.textContent('.callout.ok')) ?? '';
  check(
    're-importing the same file adds nothing',
    /0 added/.test(second) && /5 already present/.test(second),
    second.replace(/\s+/g, ' ').trim(),
  );

  // ---- Transactions browser ----
  await page.click('.nav button:has-text("Transactions")');
  await page.waitForSelector('.trow', { timeout: 10_000 });

  const rowCount = await page.locator('.trow').count();
  check('table lists the imported rows', rowCount === 5, `${rowCount} rows`);

  // Starter rules should have categorized the obvious merchants on import.
  const categorized = await page.locator('.trow .cat').count();
  check('starter rules categorized rows on import', categorized >= 3, `${categorized} categorized`);

  await page.fill('.filterbar .search', 'trader');
  await page.waitForFunction(() => document.querySelectorAll('.trow').length === 1, null, {
    timeout: 5_000,
  });
  check('search filters the table', (await page.locator('.trow').count()) === 1);
  await page.fill('.filterbar .search', '');
  await page.waitForFunction(() => document.querySelectorAll('.trow').length === 5, null, {
    timeout: 5_000,
  });

  // A deposit is money in and must not be counted as spending.
  await page.selectOption('.filter-row select >> nth=2', { label: 'Money in' });
  await page.waitForFunction(() => document.querySelectorAll('.trow').length === 1, null, {
    timeout: 5_000,
  });
  check(
    'direction filter separates money in from money out',
    (await page.locator('.trow').count()) === 1,
    `${await page.locator('.trow').count()} money-in rows`,
  );
  await page.selectOption('.filter-row select >> nth=2', { label: 'Everything' });

  // Open a row and set a category by hand; it must persist across a reload.
  await page.click('.trow .cell.merchant >> nth=0');
  await page.waitForSelector('.drawer');
  await page.selectOption('.drawer .category-picker', { label: 'Kids & School' });
  await page.waitForSelector('.drawer .callout.ok', { timeout: 5_000 });
  check(
    'manual categorization offers to become a rule',
    await page.isVisible('.drawer .callout.ok'),
    (await page.textContent('.drawer .callout.ok'))?.replace(/\s+/g, ' ').trim() ?? '',
  );
  await page.click('.drawer .callout.ok button.link'); // "Just this one"
  await page.click('.drawer header button.link');

  await page.reload({ waitUntil: 'load' });
  await page.click('.nav button:has-text("Transactions")');
  await page.waitForSelector('.trow');
  const persisted = await page.locator('.trow .cat', { hasText: 'Kids & School' }).count();
  check('manual category persists across a reload', persisted === 1, `${persisted} found`);

  // ---- Amazon: parse a saved orders page through the real UI ----
  // The live scrape cannot be exercised here (it needs a signed-in Amazon
  // account), but the paste path runs the identical parser and import pipeline,
  // so the returns and cancellations handling is verified in a real browser.
  await page.click('.nav button:has-text("Import")');
  await page.waitForSelector('.year-picker');
  await page.click('button:has-text("Paste a saved page instead")');

  const amazonHtml = readFileSync(join(root, 'tests', 'fixtures', 'amazon', 'orders-mixed.html'), 'utf8');
  await page.fill('.card textarea', amazonHtml);
  await page.click('button:has-text("Read this page")');
  await page.waitForSelector('.card .callout.ok', { timeout: 10_000 });
  const amazonSummary = (await page.textContent('.card .callout.ok')) ?? '';
  check('Amazon page imports its orders', /5 added/.test(amazonSummary), amazonSummary.trim());

  // The five orders total $462.91 at face value. Cancelled, returned and
  // partially-returned money must not be counted: only $180.92 was spent.
  await page.click('.nav button:has-text("Transactions")');
  await page.waitForSelector('.trow');
  await page.selectOption('.filter-row select >> nth=0', { label: 'Amazon' });
  await page.waitForFunction(
    () => (document.querySelector('.page-head .subtitle')?.textContent ?? '').includes('out'),
    null,
    { timeout: 5_000 },
  );
  const amazonTotal = (await page.textContent('.page-head .subtitle')) ?? '';
  check(
    'returned and cancelled Amazon money is excluded from the total',
    amazonTotal.includes('$180.92'),
    amazonTotal.replace(/\s+/g, ' ').trim(),
  );

  await page.check('.checkbox:has-text("Show returned") input');
  await page.waitForFunction(() => document.querySelectorAll('.trow').length === 5, null, { timeout: 5_000 });
  check(
    'cancelled and returned orders stay visible when asked for',
    (await page.locator('.trow').count()) === 5,
    `${await page.locator('.trow').count()} rows shown`,
  );

  // Only the cancelled order is worth nothing, so only it is struck through.
  // The returned and partly-returned orders still carry real spend and stay
  // legible, flagged with a status badge rather than crossed out.
  const struck = await page.locator('.trow.muted').count();
  check('only worthless rows are struck through', struck === 1, `${struck} struck through`);

  const flagged = await page.locator('.trow .pill.warn').count();
  check('return activity is badged', flagged >= 3, `${flagged} badged rows`);
  await page.uncheck('.checkbox:has-text("Show returned") input');
  await page.selectOption('.filter-row select >> nth=0', { label: 'All accounts' });

  // ---- Settings: rules and categories ----
  await page.click('.nav button:has-text("Settings")');
  await page.waitForSelector('.chips .chip');
  check(
    'seeded categories are listed',
    (await page.locator('.chips .chip').count()) >= 10,
    `${await page.locator('.chips .chip').count()} categories`,
  );

  await page.click('button:has-text("Re-run rules on all transactions")');
  await page.waitForSelector('.card .callout.ok', { timeout: 5_000 });
  const rerun = (await page.textContent('.card .callout.ok')) ?? '';
  // The row categorized by hand earlier must be reported as left alone.
  check('re-running rules leaves hand-categorized rows alone', /left alone/.test(rerun), rerun.trim());

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
