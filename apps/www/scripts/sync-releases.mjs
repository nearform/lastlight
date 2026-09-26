#!/usr/bin/env node
// Pulls the published GitHub Releases for nearform/lastlight into
// src/content/releases/ so Astro's `releases` collection can render the
// /releases changelog. src/content/releases/ is GENERATED (gitignored) — this
// script populates it on `predev` and `prebuild`. It is deliberately NOT on
// `prepare`: an install must never need the network.
//
// The Release body IS the changelog entry — there is no second source to keep
// in step. deploy-www.yml fires on `release: published`, so each release
// redeploys the site with itself already in the list.
//
// Only `v*` tags are kept (the main release stream); `image-v*` and
// `agentic-pi-v*` streams are dropped, as are drafts. Prereleases are kept and
// flagged.
//
// Env:
//   GITHUB_TOKEN        optional bearer token (CI passes github.token); without
//                       it the unauthenticated 60 req/h limit is plenty.
//   GITHUB_API          API base URL (default https://api.github.com).
//   RELEASES_REPO       owner/repo (default nearform/lastlight).
//   RELEASES_REQUIRED=1 fail the build instead of warning when the fetch
//                       fails — the deploy sets this so it can never ship an
//                       empty changelog.
//
// On a failed fetch without RELEASES_REQUIRED the script exits 0 with a warning
// and leaves whatever is already in src/content/releases/ untouched, so an
// offline `pnpm dev` still works (with a stale or empty changelog).

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEST = resolve(__dirname, '..', 'src/content/releases');
const API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const REPO = process.env.RELEASES_REPO || 'nearform/lastlight';
const REQUIRED = process.env.RELEASES_REQUIRED === '1';
const MAX_PAGES = 20;

async function fetchAll() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'lastlight-www-sync-releases',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${API}/repos/${REPO}/releases?per_page=100&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GET releases page ${page}: HTTP ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error(`GET releases page ${page}: not an array`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error(`more than ${MAX_PAGES * 100} releases — raise MAX_PAGES`);
}

// Link bare `#123` references to the repo's issue/PR, leaving code spans,
// fenced blocks and existing links (`[#123](...)`, `/pull/123#...`) alone.
// GitHub renders these itself; a static site has to do it.
function linkRefs(body) {
  const out = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // Split on inline code spans and markdown links so only prose is rewritten.
    const parts = line.split(/(`[^`]*`|\[[^\]]*\]\([^)]*\))/);
    out.push(
      parts
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part.replace(
                /(^|[\s(])#(\d+)\b/g,
                (_, pre, n) => `${pre}[#${n}](https://github.com/${REPO}/issues/${n})`,
              ),
        )
        .join(''),
    );
  }
  return out.join('\n');
}

const yamlString = (s) => JSON.stringify(String(s)); // JSON strings are valid YAML

let releases;
try {
  releases = await fetchAll();
} catch (err) {
  const msg = `[sync-releases] could not fetch releases for ${REPO}: ${err.message}`;
  if (REQUIRED) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`${msg}; leaving src/content/releases as-is`);
  process.exit(0);
}

const kept = releases.filter((r) => !r.draft && /^v\d/.test(r.tag_name));
if (kept.length === 0 && REQUIRED) {
  console.error(`[sync-releases] ${REPO} returned no v* releases — refusing to publish an empty changelog`);
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });
// Clean stale files so a deleted release disappears from the site.
if (existsSync(DEST)) {
  for (const entry of readdirSync(DEST)) {
    if (entry.endsWith('.md')) rmSync(join(DEST, entry));
  }
}

for (const r of kept) {
  const frontmatter = [
    '---',
    `tag: ${yamlString(r.tag_name)}`,
    `title: ${yamlString(r.name || r.tag_name)}`,
    `date: ${yamlString(r.published_at || r.created_at)}`,
    `url: ${yamlString(r.html_url)}`,
    `prerelease: ${r.prerelease ? 'true' : 'false'}`,
    '---',
    '',
  ].join('\n');
  const body = linkRefs((r.body || '').replace(/\r\n/g, '\n').trim());
  writeFileSync(join(DEST, `${r.tag_name}.md`), `${frontmatter}${body}\n`);
}

console.log(`[sync-releases] wrote ${kept.length} releases from ${REPO} to src/content/releases`);
