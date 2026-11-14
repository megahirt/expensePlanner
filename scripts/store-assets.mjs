#!/usr/bin/env node
/**
 * `npm run store:assets` — make the Chrome Web Store images in store/chrome/.
 *
 *   screenshot-1..5.png      1280×800 (the store's required size), taken from
 *                            the built extension showing the demo household
 *   store-icon-128.png       store icon: the logo at 96×96 inside 16px of
 *                            transparent padding (Chrome's icon guidelines)
 *   promo-small-440x280.png  small promo tile
 *
 * The screenshots are also copied to site/img/ for the website.
 *
 * Every screenshot shows the made-up demo household that ships with the
 * extension. Never use real financial data: these images are committed and
 * published.
 *
 * Run `npm run build` first.
 */
import { chromium } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'store', 'chrome');
// The site (site/, published by pages.yml) shows the same screenshots.
const SITE_IMG = join(ROOT, 'site', 'img');
if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('No dist/ build found — run `npm run build` first.');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
mkdirSync(SITE_IMG, { recursive: true });

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ep-store-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html?workspace=demo`);
  await page.waitForSelector('.topbar-right:has-text("transactions")', { timeout: 60_000 });

  const shot = async (n, what) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `screenshot-${n}.png`) });
    copyFileSync(join(OUT, `screenshot-${n}.png`), join(SITE_IMG, `screenshot-${n}.png`));
    console.log(`store/chrome/screenshot-${n}.png  ${what}`);
  };
  const go = (name) => page.click(`.nav button:has-text("${name}")`);

  await go('Dashboard');
  await shot(1, 'dashboard: the month, by category and merchant');

  await go('Categorize');
  await shot(2, 'categorize: uncategorized merchants, biggest first');

  await go('Review');
  await shot(3, 'review: an Amazon order matched to its card charge');

  await go('Transactions');
  await page.getByText('Petco', { exact: true }).first().click();
  await page.waitForSelector('.drawer-backdrop');
  await shot(4, 'a transaction, with why it got its category');
  await page.keyboard.press('Escape');

  await go('Dashboard');
  await page.locator('h2:has-text("Recurring")').scrollIntoViewIfNeeded();
  await shot(5, 'recurring charges found automatically');

  // ---- drawn images: a fresh page at the exact size for each
  const icon = `data:image/png;base64,${readFileSync(join(ROOT, 'public', 'icons', 'icon128.png')).toString('base64')}`;
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const render = async (name, w, h, body, css, transparent = false) => {
    const p = await context.newPage();
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; font-family: ${FONT}; }
      ${css}</style></head><body>${body}</body></html>`);
    await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    await p.screenshot({ path: join(OUT, name), omitBackground: transparent });
    await p.close();
    console.log(`store/chrome/${name}`);
  };

  await render(
    'store-icon-128.png',
    128,
    128,
    `<img src="${icon}" style="display:block;width:96px;height:96px;margin:16px;border-radius:20px">`,
    'body { background: transparent; }',
    true,
  );

  await render(
    'promo-small-440x280.png',
    440,
    280,
    `<div class="tile">
       <img src="${icon}">
       <div class="name">expense<span>Planner</span></div>
       <div class="line">Where the money went, in one place</div>
       <div class="small">Everything stays on your computer</div>
     </div>`,
    `body { background: #1f2024; color: #fff; }
     .tile { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
     img { width: 64px; height: 64px; border-radius: 14px; box-shadow: 0 0 0 2px rgba(255,255,255,0.25); }
     .name { font-size: 36px; font-weight: 700; margin-top: 18px; letter-spacing: -0.5px; }
     .name span { color: #6fcf97; }
     .line { font-size: 16px; opacity: 0.9; margin-top: 10px; }
     .small { font-size: 13px; opacity: 0.65; margin-top: 6px; }`,
  );
} finally {
  await context.close();
}
