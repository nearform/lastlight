#!/usr/bin/env node
// Copies lastlight/spec/*.md into src/content/spec/ so Astro's content
// collection can render them. Run before astro build (and on `astro dev`
// startup, via the package.json predev hook).
//
// Resolution order for the source directory:
//   1. SPEC_SRC env var (absolute path)
//   2. ../lastlight/spec relative to this repo (the common local checkout
//      layout: ~/work/lastlight and ~/work/lastlight-www side by side)
//
// If no source is found the script exits 0 with a warning — the previously
// synced files in src/content/spec/ stay in place, so CI builds without a
// sibling checkout still work as long as those files have been committed.

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEST = join(REPO_ROOT, 'src/content/spec');

function resolveSource() {
  if (process.env.SPEC_SRC) {
    const p = resolve(process.env.SPEC_SRC);
    if (existsSync(p)) return p;
    console.warn(`[sync-spec] SPEC_SRC=${p} not found, ignoring`);
  }
  const sibling = resolve(REPO_ROOT, '..', 'lastlight', 'spec');
  if (existsSync(sibling)) return sibling;
  return null;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, files);
    else if (entry.endsWith('.md')) files.push(p);
  }
  return files;
}

const src = resolveSource();
if (!src) {
  console.warn('[sync-spec] no spec source found; leaving src/content/spec as-is');
  process.exit(0);
}

mkdirSync(DEST, { recursive: true });

// Clean stale destination files so deletes in source propagate.
for (const entry of readdirSync(DEST)) {
  if (entry.endsWith('.md')) rmSync(join(DEST, entry));
}

let copied = 0;
let skipped = 0;
for (const file of walk(src)) {
  const name = file.slice(src.length + 1).replaceAll('/', '__');
  // README.md is the GitHub-facing index for the spec directory. It is not a
  // numbered component page and is not rendered on the website (the website's
  // /spec/ landing page replaces it). Skip it.
  if (name === 'README.md') {
    skipped++;
    continue;
  }
  copyFileSync(file, join(DEST, name));
  copied++;
}

console.log(`[sync-spec] copied ${copied} markdown file(s) from ${src} → src/content/spec/ (skipped ${skipped})`);
