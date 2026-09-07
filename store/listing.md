# Chrome Web Store listing

Everything needed to publish this as an **Unlisted** listing. Unlisted means the
extension is not searchable and does not appear in the store's public catalogue —
only someone with the direct link can install it — while still giving one-click
installation and automatic updates.

## Before you start

- A Chrome Web Store developer account: one-time $5 registration at
  <https://chrome.google.com/webstore/devconsole>.
- The package: `release/expenseplanner-<version>-webstore.zip`, produced by
  `npm run package` (CI attaches it to every tagged release).
- A publicly reachable URL for the privacy policy. `store/privacy-policy.md`
  below is the text; GitHub Pages or a gist is sufficient.

## Store fields

**Name**

    expensePlanner

**Short description** (132 characters max)

    Browse your expenses across Amazon, bank and card exports in one place. All data stays on your computer.

**Category**

    Workflow & Planning

**Detailed description**

    expensePlanner brings your spending together from the places it actually
    lives — Amazon orders, bank CSV exports, credit card statements — and gives
    you one browsable, categorized view of where the money went.

    Everything stays on your computer. There is no account, no server, and no
    part of this extension sends your financial data anywhere.

    WHAT IT DOES

    • Import CSV exports from any bank or card. Map the columns once; future
      exports from the same bank import with no questions asked.
    • Re-import overlapping date ranges safely. Rows you already have are
      recognised and skipped, and every import can be undone.
    • Read your Amazon order history, which has no CSV export, including
      per-item detail.
    • Exclude money you did not spend: cancelled orders count as zero, returned
      items are subtracted, and a partial return subtracts only the item that
      came back.
    • Match an Amazon order to the card charge that paid for it, so one purchase
      is not counted twice.
    • Categorize by rules that run entirely on your machine. Set a category by
      hand and it is never overwritten.
    • See spending by month, category and merchant, and click any figure through
      to the transactions behind it.
    • Export everything to one CSV — with your categories and notes — or take a
      full backup, or merge another computer's data into a household view.

    PRIVACY

    All data is stored in your browser on this computer. Nothing is uploaded.
    Access to amazon.com is requested only when you press Import, and can be
    revoked at any time from chrome://extensions.

**Visibility**

    Unlisted

## Permission justifications

The review team asks for these individually. Answer each one plainly.

| Permission | Justification |
|---|---|
| `storage`, `unlimitedStorage` | Stores the user's imported transactions, categories and rules locally in the browser. A multi-year transaction history exceeds the default quota. No data leaves the device. |
| `scripting` | Injects the order-history reader into the user's own Amazon orders page, only when the user clicks "Import from Amazon", to extract their own order data into the extension. |
| `https://www.amazon.com/*` (optional) | Reads the user's own Amazon order history, which Amazon offers no export for. Declared as an *optional* host permission and requested at the moment the user clicks Import, so the extension has no site access until then. Only order dates, totals, item names, prices and return/cancellation status are read. |

**Are you using remote code?** No. All code is contained in the package.

**Data usage disclosures.** Declare that the extension collects *financial and
payment information* (the user's own transaction records), and tick:

- Not being sold to third parties
- Not being used or transferred for purposes unrelated to the item's core functionality
- Not being used or transferred to determine creditworthiness or for lending purposes

The extension has no network transmission of user data whatsoever.

## Assets needed

| Asset | Requirement | Status |
|---|---|---|
| Icon | 128×128 PNG | in `public/icons/icon128.png` |
| Screenshots | 1280×800 or 640×400, at least one | take from the Dashboard and Transactions screens |
| Small promo tile | 440×280 (optional) | optional for unlisted |

Screenshots can be captured from a real install; the Dashboard and the
Transactions table are the two worth showing.

## After publishing

Share the store link with whoever should have it. Updates: bump the version in
`package.json` and `public/manifest.json`, tag the release, and upload the new
`-webstore.zip` from the release page. Installed copies update themselves.
