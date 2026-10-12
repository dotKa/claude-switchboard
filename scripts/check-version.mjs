#!/usr/bin/env node
/**
 * check-version.mjs — assert that package.json and public/manifest.json
 * versions are in sync, and (optionally) that they match a release tag.
 *
 * Usage:
 *   node scripts/check-version.mjs          # package.json == manifest.json
 *   node scripts/check-version.mjs 1.2.3    # ...and both == 1.2.3 (tag without "v")
 *
 * Exits 0 on success, 1 with a message on mismatch. No dependencies.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8'));

let failed = false;

if (pkg.version !== manifest.version) {
  console.error(
    `Version mismatch: package.json is "${pkg.version}" but public/manifest.json is "${manifest.version}".`,
  );
  failed = true;
}

const expected = process.argv[2];
if (expected !== undefined && pkg.version !== expected) {
  console.error(
    `Version mismatch: expected "${expected}" (from release tag) but versions are "${pkg.version}".`,
  );
  failed = true;
}

if (failed) {
  console.error('Fix by bumping both package.json and public/manifest.json to the same version.');
  process.exit(1);
}

console.log(`Version OK: ${pkg.version}`);
