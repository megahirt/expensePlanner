# expensePlanner privacy policy

_Last updated: 2026-09-07_

## The short version

expensePlanner does not collect, transmit, sell or share any of your data. There
is no server, no account and no analytics. Everything the extension reads stays
in your own browser, on your own computer.

## What the extension stores

When you import a file or run an Amazon import, the extension stores the
resulting records in your browser's local IndexedDB storage:

- transaction dates, descriptions, merchant names, amounts and currencies
- account labels you type in
- Amazon order numbers, item names, prices and return/cancellation status
- categories, rules, notes and tags you create
- a history of your imports, so they can be undone

This data is held in your Chrome profile on this computer. It is not synced to
any Google account, and it is not accessible to the author of this extension or
to anyone else.

## What the extension transmits

Nothing. The extension makes no network requests to any server operated by the
author or by any third party. It contains no analytics, no telemetry, no crash
reporting and no advertising code.

## Website access

The extension requests access to `https://www.amazon.com/*` as an **optional**
permission, meaning it holds no website access when installed. Access is
requested only at the moment you click "Import from Amazon", and is used solely
to read your own order history pages — which Amazon provides no export for — and
extract the order data into local storage. It does not read any other Amazon page
and does not interact with your Amazon account credentials, which the extension
never sees.

You can revoke this access at any time at `chrome://extensions`.

Bank and credit card data is never read from any website. It enters the extension
only through CSV files that you download from your institution and choose to
open.

## Data you export

Exported CSV and backup files are written directly to your computer's downloads
folder by your browser. They are not uploaded anywhere as part of producing them.
If you choose to send such a file to someone else, that is your own action and
outside the extension.

## Removing your data

Removing the extension from `chrome://extensions` deletes its local storage and
with it every record described above. Export a backup first if you want to keep
your data.

## Contact

Questions or concerns: open an issue on the project's GitHub repository.
