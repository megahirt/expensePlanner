# Chrome Web Store setup

How expensePlanner gets onto the Chrome Web Store, and how later versions
follow on their own. Steps 1 to 4 are done once, by the owner; after that a
release is one tag.

> Fees and listing requirements below come from Chrome Web Store developer
> documentation. Store requirements change, so check them in the dashboard when
> you submit.

## Where things stand

| Piece | State |
|---|---|
| Release workflow (`.github/workflows/release.yml`) | Ready. Builds, tests, zips, makes the GitHub Release. |
| Store upload (`scripts/publish-chrome.mjs`) | Ready. Skips until the three settings in step 4 exist. |
| Listing text and images (`store/chrome/`) | Ready to paste and upload. |
| Privacy policy text (`store/privacy-policy.md`) | Written. **Needs a public address** (see step 2). |
| Developer account, store item, service account | Not done. Steps 1, 3 and 4. |

## 1. Developer registration — $5 one-time

1. Sign in to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   with the Google account that will own the listing. If you already
   registered for another extension, the same account works and there is no
   second fee.
2. Otherwise pay the **$5 one-time registration fee** and complete the identity
   check the dashboard asks for.
3. Turn on **2-step verification** for that Google account. The store requires
   it to publish.

## 2. Give the privacy policy a public address

The store needs a link to a privacy policy that anyone can open. This
repository is **private**, so a link to `store/privacy-policy.md` on GitHub
will not work for a reviewer. Pick one:

- **Make the repository public.** Then the policy is
  `https://github.com/megahirt/expensePlanner/blob/main/store/privacy-policy.md`,
  and the listing can also link to the code and to Issues for support.
- **Keep it private** and publish the policy text somewhere public, such as a
  public gist or a page on a site you own. Use that address in the listing, and
  give a support email instead of the Issues link.

## 3. Create the store item (first upload is by hand)

The store's API can only update an item that already exists, so the first
version is uploaded in the dashboard.

1. Make the first release so there is a zip to upload:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
   Download `expenseplanner-0.1.0-chrome.zip` from the GitHub Release. Upload
   that file, not a local build.
2. Developer Dashboard → **New item** → upload the zip.
3. Fill in the listing from [`store/chrome/README.md`](../store/chrome/README.md):
   description, images, category, the privacy tab and the privacy policy
   address from step 2.
4. Choose the visibility (the listing kit explains the choices) and submit for
   review. Review usually takes a few days. The first review of an extension
   that handles financial data can take longer.

After the upload, the dashboard shows the item's 32-letter ID. That is
`CWS_EXTENSION_ID` below.

## 4. Let releases upload themselves (service account, API v2)

On every `vX.Y.Z` tag, the release workflow's `chrome` job runs after the
GitHub Release is made, in the `release` environment, so it waits for the
owner's approval. It runs `scripts/publish-chrome.mjs`, which:

1. signs in as a Google **service account**;
2. uploads the release's `…-chrome.zip` (Chrome Web Store API v2);
3. submits it for review as **`STAGED_PUBLISH`**: once review passes, the
   update waits for the owner's **Publish** click in the Developer Dashboard.
   Nothing goes live on its own.

Until all three settings below exist, the job prints `SKIPPED` and the release
still succeeds.

| Name | Kind | Value |
|---|---|---|
| `CWS_EXTENSION_ID` | repository **variable** | the item's 32-letter ID (step 3) |
| `CWS_PUBLISHER_ID` | repository **variable** | Developer Dashboard → **Publisher → Settings** |
| `CWS_SERVICE_ACCOUNT_JSON_B64` | **secret** in the `release` environment | the service account's JSON key, base64-encoded |

**One-time setup:**

1. Create the `release` environment: GitHub → repository **Settings →
   Environments → New environment** → `release`. Add yourself as a **required
   reviewer**, and under **Deployment branches and tags** allow tags matching
   `v*`. Without the tag rule the `chrome` job cannot start.
2. [Google Cloud Console](https://console.cloud.google.com/): create a project
   (any name; an existing one is fine), then **APIs & Services → Enable APIs** →
   enable the **Chrome Web Store API**.
3. **IAM & Admin → Service Accounts → Create service account** (no roles
   needed). Open it → **Keys → Add key → JSON**. A `.json` file downloads.
4. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) →
   **Account**: add the service account's email (it ends in
   `iam.gserviceaccount.com`). A publisher can have only one service account,
   so if another extension of yours already uses one, reuse that account and
   its key here.
5. Store the key as a secret in the `release` environment, then delete the
   downloaded file:
   ```bash
   base64 -i ~/Downloads/<key>.json | gh secret set CWS_SERVICE_ACCOUNT_JSON_B64 --env release
   ```
6. Set the two IDs:
   ```bash
   gh variable set CWS_EXTENSION_ID --body <32-letter-id>
   ```
   ```bash
   gh variable set CWS_PUBLISHER_ID --body <publisher-id>
   ```

**Gotchas:**

- The upload fails unless the tag's version is higher than the store's.
- If you change visibility (Unlisted, Public) in the dashboard, publish once by
  hand there before the API can publish again.
- The API cannot change the listing text or images. Edit those in the
  dashboard.

## 5. Releasing an update

```bash
git checkout main && git pull
```

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The version comes only from the tag; there is nothing to bump in the code. The
workflow tests and builds, publishes the GitHub Release, then (after you approve
the `release` environment) uploads to the store. When review passes, press
**Publish** in the dashboard. Installed copies then update themselves.

To refresh the store images after the interface changes:

```bash
npm run build && npm run store:assets
```
