/**
 * Loads the built extension in real Chromium and asserts the app page renders.
 *
 * This is the check that a unit test cannot make: that `dist/` is a valid MV3
 * extension Chrome will actually accept, that the manifest paths resolve, and
 * that the service worker registers without throwing.
 *
 * Usage: npm run build && node scripts/smoke.mjs
 *        node scripts/smoke.mjs path/to/unzipped-release   (verify a release)
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Defaults to the local build, but accepts a path so the packaged release zip
// can be verified after unzipping — the artifact people actually install.
const distPath = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist');

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
 * Find a full Chromium build on disk.
 *
 * This has to be a *full* Chromium: Playwright's default for a headless launch
 * is the headless shell, which cannot load extensions at all — it starts fine
 * and then never registers a service worker, which is exactly how this failed
 * on CI while passing locally.
 *
 * Directories named `chromium_headless_shell-*` are therefore excluded (the
 * `chromium-` prefix check does that, since they use an underscore).
 *
 * Two things vary by environment and both have to be handled, because getting
 * either wrong silently yields no service worker rather than a clear error:
 *
 *   - Location. This sandbox preinstalls to /opt/pw-browsers; `npx playwright
 *     install` on a CI runner writes to ~/.cache/ms-playwright.
 *   - Layout. Older revisions unpack to `chrome-linux/chrome`; the Chrome for
 *     Testing builds newer Playwright downloads use `chrome-linux64/chrome`.
 */
const CHROME_SUBPATHS = [
  ['chrome-linux64', 'chrome'],
  ['chrome-linux', 'chrome'],
];

function findChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    '/opt/pw-browsers',
    join(homedir(), '.cache', 'ms-playwright'),
  ].filter((dir) => dir && existsSync(dir));

  for (const base of roots) {
    for (const dir of readdirSync(base).filter((d) => d.startsWith('chromium-'))) {
      for (const parts of CHROME_SUBPATHS) {
        const candidate = join(base, dir, ...parts);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

const executablePath = findChromium();
console.log(
  executablePath
    ? `Using Chromium at ${executablePath}\n`
    : 'No full Chromium found on disk; falling back to the "chromium" channel.\n',
);

const userDataDir = mkdtempSync(join(tmpdir(), 'ep-smoke-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  // Extensions do work headless, but only in Chrome's new headless mode, which
  // means the full browser rather than the headless shell.
  headless: true,
  // Exactly one of these: passing both is an error. The `chromium` channel is
  // the fallback that still resolves to the full browser rather than the shell.
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
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

  // ---- Review: an Amazon order and its card charge are one expense ----
  // The Amazon fixture's first order is $78.42 on 2025-03-04. Import a card
  // statement containing the matching charge and confirm the two are not
  // counted twice.
  await page.click('.nav button:has-text("Import")');
  await page.waitForSelector('.dropzone');

  const cardCsv = join(userDataDir, 'visa.csv');
  writeFileSync(
    cardCsv,
    'Date,Description,Amount\n2025-03-05,AMZN Mktp US*RT4G82OI3,-78.42\n2025-03-06,SAFEWAY 1882,-31.10\n',
  );
  await page.setInputFiles('.dropzone input[type=file]', cardCsv);
  await page.waitForSelector('.wizard');
  await page.fill('.field input[placeholder*="Schwab"]', 'Visa 4242');
  await page.click('.actions button.primary');
  await page.waitForSelector('.callout.ok');

  await page.click('.nav button:has-text("Review")');
  await page.waitForSelector('.candidate', { timeout: 10_000 });
  const reason = (await page.textContent('.candidate-head')) ?? '';
  check('the duplicate purchase is proposed for review', /Same purchase/.test(reason), reason.replace(/\s+/g, ' ').trim());

  // Before confirming, the $78.42 is counted twice.
  await page.click('.nav button:has-text("Transactions")');
  await page.waitForSelector('.trow');
  // Isolate the two $78.42 rows by amount rather than by text: the card row and
  // the Amazon order describe themselves completely differently, which is the
  // whole reason the link is needed.
  const isolate = async () => {
    await page.fill('.field.inline.narrow input >> nth=0', '78.42');
    await page.fill('.field.inline.narrow input >> nth=1', '78.42');
    await page.click('.filterbar .search');
    await page.waitForTimeout(400);
  };
  const clearAmounts = async () => {
    await page.fill('.field.inline.narrow input >> nth=0', '');
    await page.fill('.field.inline.narrow input >> nth=1', '');
    await page.click('.filterbar .search');
    await page.waitForTimeout(400);
  };

  await isolate();
  const beforeLink = (await page.textContent('.page-head .subtitle')) ?? '';
  check(
    'unlinked, the purchase is counted twice',
    /\$156\.84/.test(beforeLink),
    beforeLink.replace(/\s+/g, ' ').trim(),
  );
  await clearAmounts();

  await page.click('.nav button:has-text("Review")');
  await page.waitForSelector('.candidate');
  await page.click('.candidate button.primary');
  await page.waitForSelector('.card:has-text("Matched")', { timeout: 10_000 });

  await page.click('.nav button:has-text("Transactions")');
  await page.waitForSelector('.trow');
  await isolate();
  const afterLink = (await page.textContent('.page-head .subtitle')) ?? '';
  check(
    'once linked, the purchase is counted once',
    /\$78\.42/.test(afterLink) && /1 matching row/.test(afterLink),
    afterLink.replace(/\s+/g, ' ').trim(),
  );
  await clearAmounts();

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

  // ---- Categorize: clear a whole merchant in one click ----
  // A paper check says nothing about what it was for, so no automatic step can
  // place it. Import a few and settle them from the Categorize screen.
  await page.click('.nav button:has-text("Import")');
  await page.waitForSelector('.dropzone');
  const checksCsv = join(userDataDir, 'checks.csv');
  writeFileSync(
    checksCsv,
    'Post Date,Payee,Amount\n2025-03-06,Check Paid #1041,-240.00\n2025-04-06,Check Paid #1042,-240.00\n2025-05-06,Check Paid #1043,-240.00\n',
  );
  await page.setInputFiles('.dropzone input[type=file]', checksCsv);
  await page.waitForSelector('.wizard');
  await page.fill('.field input[placeholder*="Schwab"]', 'Checking 0001');
  await page.click('.actions button.primary');
  await page.waitForSelector('.callout.ok');

  await page.click('.nav button:has-text("Categorize")');
  await page.waitForSelector('.merchant-group');
  const checkRow = page.locator('.merchant-group', { hasText: 'Check Paid' });
  check(
    'uncategorized rows are grouped by merchant',
    (await checkRow.count()) === 1 && ((await checkRow.locator('td >> nth=1').textContent()) ?? '').trim() === '3',
    ((await checkRow.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
  );
  check('a steady monthly charge is flagged as recurring', /monthly/.test((await checkRow.textContent()) ?? ''));

  await checkRow.locator('.category-picker').selectOption({ label: 'Kids & School' });
  await page.waitForSelector('.callout.ok', { timeout: 10_000 });
  const filed = ((await page.textContent('.callout.ok')) ?? '').trim();
  check('one choice files every row from that merchant', /3 rows from Check Paid/.test(filed), filed);
  check(
    'the merchant leaves the list once it is settled',
    (await page.locator('.merchant-group', { hasText: 'Check Paid' }).count()) === 0,
  );

  // ---- Dashboard ----
  await page.click('.nav button:has-text("Dashboard")');
  await page.waitForSelector('.stat-row');
  check(
    'dashboard shows headline figures',
    (await page.locator('.stat').count()) === 4,
    `${await page.locator('.stat').count()} tiles`,
  );

  const headline = (await page.textContent('.stat-value')) ?? '';
  check('headline figure is a real number, not zero', !/^-?\$0\.00$/.test(headline.trim()), headline.trim());

  check('spending chart renders bars', (await page.locator('.chart .bar').count()) > 0);
  check('category breakdown renders', (await page.locator('.ranked-row').count()) > 0);

  // Clicking a category must land on the transactions table already filtered.
  const firstCategory = (await page.textContent('.ranked-row .ranked-label')) ?? '';
  await page.click('.ranked-row');
  await page.waitForSelector('.trow', { timeout: 5_000 });
  const activeCategory = await page.inputValue('.filter-row select >> nth=1');
  check(
    'clicking a category drills through to its transactions',
    activeCategory !== '',
    `${firstCategory.trim()} -> ${activeCategory}`,
  );
  await page.click('button:has-text("Clear filters")');

  // ---- Export round trip through the real UI ----
  // Downloads are captured rather than written to disk, so this verifies the
  // actual file the user would get.
  await page.click('.nav button:has-text("Settings")');
  await page.waitForSelector('.transfer-grid');
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
  await page.click('button:has-text("Export")');
  const download = await downloadPromise;
  const csvPath = join(userDataDir, download.suggestedFilename());
  await download.saveAs(csvPath);

  const exported = readFileSync(csvPath, 'utf8');
  check('CSV export starts with a BOM for Excel', exported.charCodeAt(0) === 0xfeff);
  check(
    'CSV export carries categories and effective amounts',
    /effective_amount/.test(exported) && /Groceries|Shopping|Kids & School/.test(exported),
  );
  // Compare against what the app itself says it holds, so this check does not
  // go stale every time the fixtures change.
  const held = Number(((await page.textContent('.topbar-right')) ?? '').match(/([\d,]+) transactions/)?.[1]?.replace(/,/g, '') ?? '0');
  const exportedRows = exported.trim().split(/\r\n/).length - 1;
  check('CSV export contains every transaction', exportedRows === held, `${exportedRows} of ${held}`);

  // Merging the file we just exported must add nothing: same dedupe path.
  await page.setInputFiles('.transfer-grid input[type=file]', csvPath);
  await page.waitForSelector('.transfer-result', { timeout: 10_000 });
  const mergeMsg = (await page.textContent('.transfer-result')) ?? '';
  check(
    'merging our own export adds nothing',
    /0 added/.test(mergeMsg) && /already present/.test(mergeMsg),
    mergeMsg.trim(),
  );

  // ---- Demo household: a second database, switched to from Settings ----
  const heldNow = async () =>
    Number(((await page.textContent('.topbar-right')) ?? '').match(/([\d,]+) transactions/)?.[1]?.replace(/,/g, '') ?? '-1');
  const mine = await heldNow();

  check('no demo banner while showing your own data', (await page.locator('.demo-banner').count()) === 0);
  await page.click('.workspace-choice label:has-text("Demo household")');
  await page.waitForSelector('.demo-banner', { timeout: 10_000 });
  await page.waitForFunction(
    () => /[\d,]+ transactions/.test(document.querySelector('.topbar-right')?.textContent ?? ''),
    null,
    { timeout: 60_000 },
  );
  const demoIndex = JSON.parse(readFileSync(join(distPath, 'demo', 'index.json'), 'utf8'));
  check('demo files ship inside the extension', demoIndex.accounts.length === 4);
  const demoHeld = await heldNow();
  check('switching to the demo loads the made-up household', demoHeld > 1000 && demoHeld !== mine, `${demoHeld} transactions`);
  check('a banner says this is demo data', /Demo household/.test((await page.textContent('.demo-banner')) ?? ''));

  await page.click('.nav button:has-text("Import")');
  check(
    'Import warns that files would go into the demo',
    await page.isVisible('.callout.warn:has-text("demo household")'),
  );

  // The choice survives closing and reopening the app.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.demo-banner', { timeout: 10_000 });
  await page.waitForFunction(
    () => /[\d,]+ transactions/.test(document.querySelector('.topbar-right')?.textContent ?? ''),
    null,
    { timeout: 60_000 },
  );
  check('reopening stays in the demo without loading it twice', (await heldNow()) === demoHeld, `${await heldNow()}`);

  await page.click('.demo-banner button');
  await page.waitForSelector('.demo-banner', { state: 'detached', timeout: 10_000 });
  await page.waitForFunction(
    () => /[\d,]+ transactions/.test(document.querySelector('.topbar-right')?.textContent ?? ''),
    null,
    { timeout: 30_000 },
  );
  check('switching back shows your own data exactly as it was', (await heldNow()) === mine, `${await heldNow()} of ${mine}`);

  // ---- Delete all data: empties your side only ----
  await page.click('.nav button:has-text("Settings")');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.click('button.danger:has-text("Delete all my data")');
  check('cancelling the confirmation deletes nothing', (await heldNow()) === mine, `${await heldNow()}`);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.click('button.danger:has-text("Delete all my data")');
  await page.waitForSelector('.callout.notice:has-text("deleted")', { timeout: 10_000 });
  check('Delete all my data empties your data', (await heldNow()) === 0, `${await heldNow()} left`);
  check('starter categories come back after deleting', (await page.locator('.chips .chip').count()) > 5);

  await page.click('.workspace-choice label:has-text("Demo household")');
  await page.waitForSelector('.demo-banner', { timeout: 10_000 });
  await page.waitForFunction(
    () => /[\d,]+ transactions/.test(document.querySelector('.topbar-right')?.textContent ?? ''),
    null,
    { timeout: 60_000 },
  );
  check('the demo household is untouched by it', (await heldNow()) === demoHeld, `${await heldNow()} of ${demoHeld}`);
  check('the demo offers no way to delete your data', (await page.locator('button.danger').count()) === 0);
  check('no page errors after switching', pageErrors.length === 0, pageErrors.join(' | '));

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
