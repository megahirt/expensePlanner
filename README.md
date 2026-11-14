# expensePlanner

A Chrome extension that pulls your expenses out of several places — Amazon, bank
and credit-card exports — and gives you one browsable, categorized view of where
the money actually went.

**Everything stays on your computer.** There is no account, no server, and no
part of this extension sends your financial data anywhere. It reads Amazon by
looking at the pages you are already signed in to, and reads banks from CSV files
you download yourself.

---

## Installing this (no developer knowledge needed)

You need to do this once. It takes about a minute.

1. **Download the extension.** Go to the
   [Releases page](../../releases/latest) and download the file named
   `expenseplanner-<version>.zip`.
2. **Unzip it.** Double-click the downloaded file. You will get a folder — put it
   somewhere you will not accidentally delete, like your Documents folder. *(Chrome
   reads the extension from this folder every time it starts, so if you move or
   delete it later the extension stops working.)*
3. **Open Chrome's extensions page.** Type `chrome://extensions` into the address
   bar and press Enter.
4. **Turn on Developer mode** using the switch in the top-right corner.
5. **Click "Load unpacked"** (top-left) and choose the folder you unzipped.
6. Done. The expensePlanner icon appears in your toolbar — click it to open.

> **Why the extra steps?** Chrome only allows one-click installs from its Web
> Store. Since 2015 it has refused to install extensions distributed as `.crx`
> files, so a download that installs by double-clicking is not something anyone
> can offer outside the store. The steps above are the supported way to install
> an extension you have the files for.

**On Windows**, Chrome may show a "Disable developer mode extensions" bubble each
time it starts. You can dismiss it; the extension keeps working.

### Updating

Download the new zip, unzip it over the old folder, then go to
`chrome://extensions` and click the reload (↻) icon on the expensePlanner card.
Your data is untouched by an update — it lives in the browser, not in the folder.

### Want one-click installs and automatic updates instead?

Publishing to the Chrome Web Store as an **Unlisted** listing gives exactly that:
a private link that installs in one click and updates itself, without the
extension being searchable or public. It costs a one-time $5 developer
registration. Everything needed for that is prepared in [`store/`](store/) —
listing text, privacy policy and permission justifications — and the build
already emits the store-ready package (`-webstore.zip`), so no code changes are
needed.

---

## Using it

### Bank and credit card

Download a CSV from your bank, then drag it onto the **Import** screen. The first
time, you confirm which columns are the date, description and amount — the
preview shows your own rows so you can see it is reading them correctly. That
mapping is remembered, so future exports from the same bank import with no
questions asked.

**Re-importing overlapping dates is safe and expected.** Most banks make it
tedious to narrow a date range, so download whatever is easy — 90 days every
month is fine. Rows you already have are recognised and skipped, and the import
summary tells you plainly: *"142 rows read → 31 added, 109 already present."*

Every import can be undone from the import history, which removes only the rows
that import created.

### Amazon

Amazon has no CSV export, which is why this reads the pages directly. On the
**Import** screen, pick the years and click **Import from Amazon**. Chrome asks
for permission to read `amazon.com` at that moment — until you click, the
extension has no access to any website at all.

Cancelled orders and returned items do not count as spending:

- A **cancelled** order was never charged, so it counts as zero.
- A **returned** item is subtracted from its order — and only that item, so
  returning one thing from a three-item order leaves the rest counted.
- Where Amazon states a refund amount, that amount is used. An $89 item refunded
  at $82 leaves $7 of real spending, because the restocking fee was really paid.
- Where Amazon says an item came back but not how much was refunded, nothing is
  guessed. The credit that later appears on your card settles the real figure —
  see **Review** below.

Returns and cancellations stay visible (tick *Show returned & cancelled* on the
Transactions screen) so you can audit them; they just do not inflate totals.

### Review

If you import both your Amazon orders and the card they were paid with, the same
purchase appears twice, and summing both would double your spending. The
**Review** screen proposes matches — same amount, within a few days — and you
confirm them. Nothing is ever merged automatically. It also matches refund
credits back to returns, and lists returns where no refund ever arrived, which is
money worth chasing.

### Categories

Every transaction is categorized on your machine, with no network calls and no
AI model. Each source of knowledge is tried in turn, most trustworthy first, and
the first with an answer wins:

1. **Your own rules.** Created when you categorize something and choose to
   remember it.
2. **What an Amazon order contained.** An order of dog food is household, not
   "Shopping" just because it came from Amazon. Once you match an order to its
   card charge in **Review**, the charge takes the order's category too.
3. **Starter rules.** About a hundred, for common merchants.
4. **A built-in directory of well-known merchants.** About 3,800 US brand names.
5. **Your bank's own category**, where the export has one (Chase and Amex do).
6. **A telling word in the name**: "orthodontics", "mortgage", "auto repair".

The same row always gets the same answer, and the answer comes with its reason:
open any transaction to see why it landed where it did. **A category you set by
hand is never overwritten**, not by a re-import and not by re-running rules.

Whatever is left (cash, paper checks, payments to people) shows up on the
**Categorize** screen grouped by merchant, biggest first. Pick a category once
and every row from that merchant follows, now and on future imports. Where a
merchant resembles one you have already categorized, the likely category is
offered as a one-click suggestion; nothing is applied until you click.

The **Dashboard** also lists recurring charges (subscriptions and bills), found
by looking for the same merchant charging at a steady rhythm.

If you imported data before these existed, press **Re-run rules on all
transactions** in Settings to apply them to what you already have.

The merchant directory is derived from the OpenStreetMap
[name-suggestion-index](https://github.com/osmlab/name-suggestion-index); see
[THIRD_PARTY_NOTICES.md](public/THIRD_PARTY_NOTICES.md). `npm run directory:build`
regenerates it.

### Exporting and sharing between two computers

From **Settings**:

- **One CSV of everything** — every source in one file, with your categories,
  notes and what each row is worth after refunds, so a spreadsheet sees the work
  you did rather than raw descriptions. Opens cleanly in Excel and Sheets.
- **Full backup (JSON)** — the real backup, including your rules and categories,
  which a CSV cannot carry. Worth downloading before resetting a Chrome profile.
- **Merge another install** — feed in a CSV or backup exported from another
  computer. It goes through the same duplicate checking as any import, so two
  people can combine into one household view without a server or an account.

---

## Building from source

```bash
npm install
npm run build      # writes an unpacked extension to dist/
```

Then load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.

| Command | What it does |
|---|---|
| `npm run build` | Two Vite passes: app + service worker, then the content script |
| `npm test` | Unit tests (parsers, dedupe, rules, exports) |
| `npm run smoke` | Loads the built extension in real Chromium and drives the UI |
| `npm run verify` | Typecheck, lint, tests, build and smoke test |
| `npm run package` | Builds the release zips into `release/` |
| `npm run chromium` | Builds, then opens a Chromium window with the extension loaded |
| `npm run chromium:demo` | The same, with a made-up household's year of data loaded |
| `npm run demo:data` | Regenerates the demo files in `tests/fixtures/demo/` |

The build is two passes because Chrome content scripts have no module loader — a
code-split chunk would fail at runtime with no visible error — so the content
script is bundled separately as a self-contained IIFE.

### Trying it without your own data

```bash
npm run chromium:demo
```

This opens the extension with a year (2025) of transactions for a fictional
family of five already imported: a checking account, two credit cards, a savings
account and an Amazon order history, about 1,650 rows in all. Nothing in it
describes a real person or account. It runs in its own browser profile
(`.chromium-profile-demo/`), separate from the one `npm run chromium` uses, so
demo data and real data never mix. Delete that folder to start over.

The data is built to show the parts that matter: every non-cancelled Amazon order
has a matching card charge waiting in **Review**, some orders were cancelled,
returned or partly returned, a few refunds only show up as card credits, and two
returns never got a refund at all. A handful of merchants (checks, cash, payments
to people) cannot be categorized automatically, so the **Categorize** screen has
something to do.

The files live in `tests/fixtures/demo/` and can also be dragged onto the
**Import** screen by hand (paste `amazon-orders.html` into *Paste a saved page
instead*). They are generated by `scripts/generate-demo-data.mjs` from a fixed
seed, and `tests/demo.test.ts` checks both that the committed files match the
generator and that the app reads them back as intended.

### Cutting a release

Bump the version in **both** `package.json` and `public/manifest.json`, then tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

CI verifies the tag matches both files, runs everything, packages the zips,
unzips the release and runs the browser test against *that* — the artifact people
actually download — then publishes it.

---

## Adding another source

Sources implement one interface (`src/adapters/types.ts`) in two flavours, so
dedupe, batching, categorization and undo are written once and inherited.

- **A bank whose CSV needs no special handling** needs no code at all — map its
  columns once in the wizard.
- **A bank needing special handling** is a `FileAdapter`: implement `sniff` and
  `parse`, and register it in `src/adapters/registry.ts`.
- **A site to scrape** is a `ScraperAdapter`: implement `matchesUrl` and a
  `scrape(doc)` that is *pure* — Document in, rows out. Keeping it pure is what
  lets it be tested against a saved HTML page with no browser and no account,
  which matters a great deal for scrapers, since sites redesign without warning.

If Amazon changes its layout, the import says so instead of silently importing
nothing. All the DOM assumptions live in `src/adapters/amazon/selectors.ts`, and
the **Paste a saved page** box on the Import screen shows exactly what the parser
makes of a real page, so the selectors can be repaired without anyone handling
your Amazon credentials.

---

## What it does with your data

| | |
|---|---|
| Where data is stored | IndexedDB, in your Chrome profile, on your computer |
| What is sent anywhere | Nothing |
| Website access | Only `amazon.com`, only after you click Import, revocable any time from `chrome://extensions` |
| Accounts / sign-in | None |
| Analytics | None |

Amounts are stored as whole cents rather than decimals, so totals agree with your
bank to the penny.

## Licence

MIT — see [LICENSE](LICENSE).
