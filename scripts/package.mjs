/**
 * Package the built extension for release.
 *
 * Produces, from `dist/`:
 *
 *   release/expenseplanner-<version>-chrome.zip   the Chrome Web Store upload,
 *                                                 and what "Load unpacked" uses
 *   release/SHA256SUMS.txt                        its checksum
 *
 * The version is whatever the build stamped into dist/manifest.json (see
 * scripts/stamp-version.mjs): the release tag in CI, the newest tag locally.
 *
 * There is deliberately no .crx. Chrome has refused to install off-store CRX
 * files since 2015 (they are accepted and then auto-disabled with "can only be
 * added from the Chrome Web Store"), so shipping one would look like the right
 * artifact and fail on the user's machine.
 *
 * Usage: node scripts/package.mjs [--out release]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const outIndex = process.argv.indexOf('--out');
const outDir = join(root, outIndex > -1 ? (process.argv[outIndex + 1] ?? 'release') : 'release');

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json is missing — run `npm run build` first.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));

// The store rejects anything that can reach a development server, and a
// manifest that mentions one means this is not a release build.
if (/localhost|127\.0\.0\.1/.test(JSON.stringify(manifest))) {
  console.error('dist/manifest.json mentions localhost: not a release build.');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Source maps are useful in dist/ for debugging a local build, but they roughly
// triple the download and are not wanted in a release.
const zipName = `expenseplanner-${manifest.version}-chrome.zip`;
const zipPath = join(outDir, zipName);
execFileSync('zip', ['-r', '-q', '-X', zipPath, '.', '-x', '*.map'], { cwd: dist, stdio: 'inherit' });

const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
writeFileSync(join(outDir, 'SHA256SUMS.txt'), `${sha}  ${zipName}\n`);

console.log(`wrote ${zipPath}`);
console.log(`sha256 ${sha}`);
if (manifest.version === '0.0.0') {
  console.log('\nVersion is 0.0.0: no release tag was found. Fine for a local look, not for the store.');
}
console.log('\nInstall by hand: unzip, then chrome://extensions → Developer mode → Load unpacked.');
