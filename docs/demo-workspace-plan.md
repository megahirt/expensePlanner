# Plan: switch between your data and the demo household

## Goal

Let one install of the extension hold two completely separate sets of data and
switch between them from inside the app:

- **Your data** — what you import yourself.
- **Demo household** — the made-up family of five and their 2025.

Nothing done in one may ever show up in the other: not transactions, rules,
categories, confirmed matches, saved CSV mappings or settings.

## Approach: two databases, one switch

Every screen already reads and writes through a single `getDb()` in
`src/lib/db.ts`. So the switch is made there, once, instead of filtering rows on
every query.

| Workspace | IndexedDB name | Notes |
|---|---|---|
| `real` | `expenseplanner` | The existing database. Untouched; no migration. |
| `demo` | `expenseplanner-demo` | Same schema. Created the first time demo is opened. |

The active workspace is remembered in `localStorage`
(`expenseplanner:workspace`), which belongs to the extension's own origin. It
defaults to `real`.

Rejected alternative: one database with a demo/real flag on each row. Every
query, export, rule run and link proposal would need the filter, and one missed
spot mixes the two.

## Steps

### 1. Database layer (`src/lib/db.ts`)

- Add `Workspace = 'real' | 'demo'` and the two database names.
- `getActiveWorkspace()` reads the saved choice.
- `setActiveWorkspace(ws)` saves the choice, closes the open connection and
  drops the cached one, so the next `getDb()` opens the other database.
- Everything else in the file is unchanged, because it all goes through
  `getDb()`.

### 2. Demo files ship with the extension

- Move the generated files from `tests/fixtures/demo/` to `public/demo/`, so the
  build copies them into `dist/demo/`. One copy serves the tests, the launcher
  and the extension.
- The generator also writes `public/demo/index.json` listing each bank file with
  its account label, plus the Amazon file, so the app does not hard-code them.
- Cost: about 190 KB added to the extension (five files).

### 3. Demo loader (`src/lib/demo.ts`)

- `loadDemoData(readFile)` reads `index.json`, then runs every file through the
  same code the Import screen uses: parse, detect the column mapping, save the
  source, `runImport`. The Amazon page goes through `parseOrdersPage`.
- It takes the file reader as an argument, so the app passes `fetch` and the
  tests pass a disk reader.
- Nothing in Review is confirmed for you; the demo starts where a real import
  would.

### 4. Store (`src/app/store.tsx`)

- State gains `workspace`.
- `switchWorkspace(ws)`: change the database, seed default categories and rules
  if it is empty, load the demo files if it is the demo and holds no
  transactions, then refresh.
- `resetDemo()`: wipe the demo database and load it again. Only available while
  the demo is active, and it can only ever touch the demo database.
- A second open tab of the app follows the switch (it listens for the
  `localStorage` change) rather than carrying on with the old database.

### 5. Interface

- **Banner** under the top bar whenever the demo is active: "Demo household —
  made-up data. Your own data is untouched." with a **Switch to your data**
  button.
- **Settings**: a "Which data" card with the two choices and **Reset demo
  data**.
- **Dashboard, when your data is empty**: a "Try the demo household" button
  next to the existing prompt to import.
- **Import screen in demo**: a warning that files imported now go into the demo,
  not into your data.
- Filters are cleared on a switch, so a filter made for one set is not applied
  to the other.

### 6. Amazon

All database writes happen in the app page; the service worker and the Amazon
content script only read the page and hand rows back. So an Amazon import lands
in whichever workspace is active, like any other import, and is covered by the
banner and the Import warning. No separate guard is needed.

### 7. Launcher (`scripts/open-chromium.mjs`)

- `npm run chromium:demo` opens `app.html?workspace=demo`, which switches to the
  demo on arrival. The script no longer drives the Import screen to load files.
- It keeps its own browser profile and port, so the demo window and the normal
  dev window can still be open at the same time.

### 8. Tests

- `tests/db.test.ts`: rows written in one workspace are absent from the other;
  clearing the demo leaves real data alone; the choice is remembered.
- `tests/demo.test.ts`: `loadDemoData` imports exactly the manifest's row count
  and is safe to run twice; `index.json` matches the generator.
- `scripts/smoke.mjs`: after the existing import, switch to demo in Settings,
  check the banner and the demo row count, switch back, and check your rows are
  exactly as they were.

### 9. Docs

- README: the demo section describes the in-app switch; file paths updated.

## Done when

- `npm run verify` passes (typecheck, lint, unit tests, build, browser checks).
- In a real browser window: import a file into your data, switch to demo, see
  the demo household, switch back, and the imported file's rows are unchanged.

## Out of scope

- More than two workspaces (for example one per family member).
- Copying data from one workspace to the other. Export and import already do
  this by hand.
