# Chrome Web Store listing kit

Everything to paste into the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
for **expensePlanner**. The images are in this folder; regenerate them with
`npm run build && npm run store:assets`.

Upload the **`expenseplanner-<version>-chrome.zip`** from the GitHub Release,
not a local build. The one-time account and upload steps are in
[`docs/chrome-web-store-setup.md`](../../docs/chrome-web-store-setup.md).

---

## Package (from the zip)

| Field | Value |
|---|---|
| Name | expensePlanner (from the manifest) |
| Summary | Browse your expenses across Amazon, bank and credit card sources. All data stays on this computer. (manifest `description`, 100 of 132 characters) |

## Store listing tab

**Description** (plain text; paste as is):

```text
expensePlanner brings your spending together from the places it actually lives (Amazon orders, bank CSV exports, credit card statements) and gives you one browsable, categorized view of where the money went.

Everything stays on your computer. There is no account, no server, and no part of this extension sends your financial data anywhere.

WHAT IT DOES
• Import CSV exports from any bank or card. Map the columns once; later exports from the same bank import with no questions asked.
• Re-import overlapping date ranges safely. Rows you already have are recognised and skipped, and every import can be undone.
• Read your Amazon order history, which has no CSV export, including each item.
• Leave out money you did not spend: cancelled orders count as zero, returned items are subtracted, and paying off a card is not counted as spending twice.
• Match an Amazon order to the card charge that paid for it, so one purchase is not counted twice.
• Categorize automatically, on your machine: your own rules, what an Amazon order contained, a built-in list of well-known merchants, and your bank's own category. Every category says why it was chosen, and one you set by hand is never overwritten.
• Find subscriptions and regular bills on their own.
• See spending by month, category and merchant, and click any figure through to the transactions behind it.
• Export everything to one CSV with your categories and notes, take a full backup, or merge another computer's data into a household view.

TRY IT FIRST
A made-up household's year of spending is built in. Switch to it in Settings to look around before importing anything of your own. It is kept completely apart from your data.

PRIVATE BY DESIGN
• All data is stored in your browser on this computer. Nothing is uploaded.
• No account to create, no server, no analytics, no ads.
• Bank data only enters through files you download and choose to open. Your bank password is never asked for.
• Access to amazon.com is requested only when you press Import, and can be revoked at any time from chrome://extensions.
• One button in Settings deletes everything.

expensePlanner is an independent project. It is not made, endorsed or supported by Amazon or any bank.
```

| Field | Value |
|---|---|
| Category | Tools (closest fit; "Workflow & Planning" if offered) |
| Language | English (United States) |
| Store icon | `store-icon-128.png` (128×128: the logo at 96×96 with 16px of transparent padding, per Chrome's icon guidelines) |
| Screenshots | `screenshot-1.png` … `screenshot-5.png` (1280×800, in this order) |
| Small promo tile | `promo-small-440x280.png` |
| Marquee promo tile | none (optional) |
| Homepage URL | the repository, if it is public; otherwise leave empty |
| Support URL | the repository's Issues page if public; otherwise a support email in the Account tab |
| Mature content | No |

Screenshots (all the made-up demo household; no real data):

1. `screenshot-1.png`: the dashboard: this month, last month and the year.
2. `screenshot-2.png`: Categorize: merchants with no category, biggest first.
3. `screenshot-3.png`: Review: an Amazon order next to the card charge that paid for it.
4. `screenshot-4.png`: one transaction, with why it got its category.
5. `screenshot-5.png`: spending by category and merchant, and recurring charges.

## Privacy practices tab

**Single purpose:**

```text
Brings a person's own spending records together from bank and card CSV exports and their Amazon order history, and shows them as one categorized, browsable view on their own computer.
```

**Permission justifications** (one box each in the dashboard; paste the text):

storage:

```text
Stores the user's imported transactions, categories, rules and settings locally in the browser, so they are there the next time the extension is opened. Nothing is sent off the device; there is no server.
```

unlimitedStorage:

```text
A household's transaction history over several years, with per-item Amazon detail, can exceed the default local storage quota. This permission only lifts that limit for the extension's own local database. No data leaves the device.
```

scripting:

```text
Runs the extension's own order-history reader on the user's Amazon orders page, only when the user clicks "Import from Amazon", to read their own orders into the extension. The code is in the package; nothing is downloaded or run from elsewhere.
```

Host permission (`https://www.amazon.com/*`, optional):

```text
Reads the user's own Amazon order history, which Amazon offers no export for. It is declared as an optional host permission and requested at the moment the user clicks Import, so the extension has no access to any site until then, and the user can revoke it at any time. Only order dates, totals, item names, prices and return or cancellation status are read. All of it stays on the device.
```

**Remote code:** No, I am not using remote code. (All code is in the package; no external scripts, no `eval`.)

**Data usage:**

- What user data do you plan to collect: the extension sends nothing anywhere,
  so by the plain meaning of "collect" the answer is none. Read the dashboard's
  definition when you fill this in. If it counts data handled only on the
  device, tick **Financial and payment information** (the user's own
  transaction records) and **Website content** (the Amazon order pages it
  reads).
- Tick all three certifications:
  - I do not sell or transfer user data to third parties, outside of the approved use cases.
  - I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
  - I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** the public address chosen in
`docs/chrome-web-store-setup.md`, step 2. The text is
[`store/privacy-policy.md`](../privacy-policy.md).

## Distribution tab

| Field | Value |
|---|---|
| Payments | Free |
| Visibility | **Unlisted** to start: anyone with the link can install it and it updates itself, but it does not appear in search. Switch to **Public** when you want it found. (**Private** limits it to Google accounts you list as testers.) |
| Regions | All regions |

## Notes for review (Test instructions field)

```text
No account is needed. Open the extension from the toolbar button, go to Settings, and under "Which data" choose "Demo household". This loads a made-up family's year of bank, card and Amazon records that ships inside the extension, so every screen can be tried: Dashboard, Transactions, Categorize, Review and Import. The optional amazon.com permission is only requested if you press "Import from Amazon" on the Import screen.
```
