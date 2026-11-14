#!/usr/bin/env node
/**
 * Write the release version into the built manifest (dist/manifest.json).
 *
 * The release tag is the only source of the version number. package.json and
 * public/manifest.json say 0.0.0 on purpose, so there is nothing to bump and
 * nothing that can disagree with the tag. The last step of `npm run build`
 * picks the version, in this order:
 *
 *   1. RELEASE_VERSION (the release workflow sets it from the vX.Y.Z tag; a
 *      leading "v" is fine), else
 *   2. the newest vX.Y.Z git tag reachable from HEAD (local builds), else
 *   3. 0.0.0 (no tags yet, or a shallow checkout such as CI).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// X.Y.Z with no leading zeros, each part 0-65535: Chrome's rule for manifest
// versions.
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Turn a tag or version string into a manifest version, or throw. */
export function parseVersion(raw) {
  const v = String(raw || '0.0.0').trim().replace(/^v/, '');
  if (!VERSION_RE.test(v) || v.split('.').some((n) => Number(n) > 65535)) {
    throw new Error(`Version "${v}" is not X.Y.Z (no leading zeros, each part 0-65535).`);
  }
  return v;
}

export function releaseVersion(env = process.env) {
  let v = env.RELEASE_VERSION || '';
  if (!v) {
    try {
      v = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      v = '';
    }
  }
  return parseVersion(v);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = join(root, 'dist', 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.version = releaseVersion();
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`dist/manifest.json version ${manifest.version}`);
}
