// Bump the manifest version, verify, and submit to AMO for signing.
//   npm run release            -> bump patch (0.1.0 -> 0.1.1), test, lint, sign
//   npm run release -- 0.2.0   -> set an explicit version instead
// Needs WEB_EXT_API_KEY / WEB_EXT_API_SECRET in the environment (AMO API credentials).
// The listing text (summary, description, reviewer notes) comes from amo/ and is sent with every submission.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url);
const MANIFEST = new URL('extension/manifest.json', ROOT);
const METADATA = 'web-ext-artifacts/amo-metadata.json';
const HOMEPAGE = 'https://firefox-spaces.github.io/firefox-spaces/';
const CATEGORIES = { firefox: ['tabs'] };

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  console.error('Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET first (https://addons.mozilla.org/developers/addon/api/key/).');
  process.exit(1);
}

const listing = (name) => readFileSync(new URL(`amo/${name}`, ROOT), 'utf8').trim();
const { license } = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
const summary = listing('summary.txt');
if (summary.length > 250) {
  console.error(`amo/summary.txt is ${summary.length} characters; AMO allows 250.`);
  process.exit(1);
}
mkdirSync(new URL('web-ext-artifacts/', ROOT), { recursive: true });
writeFileSync(new URL(METADATA, ROOT), `${JSON.stringify({
  summary: { 'en-US': summary },
  description: { 'en-US': listing('description.txt') },
  homepage: { 'en-US': HOMEPAGE },
  categories: CATEGORIES,
  version: { license, approval_notes: listing('reviewer-notes.txt') },
}, null, 2)}\n`);

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const old = manifest.version;
const wanted = process.argv[2];
if (wanted) {
  if (!/^\d+(\.\d+){1,3}$/.test(wanted)) {
    console.error(`"${wanted}" is not a valid version.`);
    process.exit(1);
  }
  manifest.version = wanted;
} else {
  const parts = old.split('.').map(Number);
  parts[parts.length - 1] += 1;
  manifest.version = parts.join('.');
}
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`version: ${old} -> ${manifest.version}`);

const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: ROOT });
try {
  run('npm test');
  run('npx web-ext lint --source-dir extension');
} catch {
  // Nothing reached AMO yet, so the version number is still unused: put it back.
  manifest.version = old;
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`\nChecks failed. Version rolled back to ${old}.`);
  process.exit(1);
}
try {
  run(`npx web-ext sign --source-dir extension --channel listed --amo-metadata ${METADATA}`);
} catch {
  // AMO may already have taken this version (e.g. upload succeeded, download timed out),
  // and it never signs a version twice, so keep the bump: the next run uses a fresh number.
  console.error(`\nSigning failed. Version left at ${manifest.version}. If AMO did accept it, the signed `
    + 'file can also be downloaded from your add-on\'s page on addons.mozilla.org.');
  process.exit(1);
}
console.log(`\nSigned ${manifest.version}. The .xpi is in web-ext-artifacts/.`);
