/**
 * Package the built extension for release.
 *
 * Produces two zips from the same `dist/`:
 *
 *   expenseplanner-<version>.zip           install via Load unpacked
 *   expenseplanner-<version>-webstore.zip  upload to the Chrome Web Store
 *
 * They are byte-identical in content today — the Web Store wants exactly this
 * zip — but they are emitted separately so the release page can label them for
 * their two very different audiences, and so store-only requirements can be
 * added later without changing what people download to install by hand.
 *
 * There is deliberately no .crx. Chrome has refused to install off-store CRX
 * files since 2015 (they are accepted and then auto-disabled with "can only be
 * added from the Chrome Web Store"), so shipping one would look like the right
 * artifact and fail on the user's machine.
 *
 * Usage: node scripts/package.mjs [--out release]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// A manifest version that disagrees with package.json is the classic way to
// ship a build that installs but never updates, so it is a hard error.
if (manifest.version !== pkg.version) {
  console.error(
    `Version mismatch: manifest.json says ${manifest.version}, package.json says ${pkg.version}.`,
  );
  process.exit(1);
}

// Source maps are useful in dist/ for debugging a local build, but they roughly
// triple the download and are not wanted in a release.
const args = ['-r', '-q', '-X', 'PLACEHOLDER', '.', '-x', '*.map'];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const suffix of ['', '-webstore']) {
  const zipPath = join(outDir, `expenseplanner-${manifest.version}${suffix}.zip`);
  execFileSync('zip', [...args.slice(0, 3), zipPath, '.', '-x', '*.map'], { cwd: dist, stdio: 'inherit' });
  console.log(`wrote ${zipPath}`);
}

console.log(`\nVersion ${manifest.version} packaged.`);
console.log('Install: unzip, then chrome://extensions → Developer mode → Load unpacked.');
