#!/usr/bin/env node
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as cheerio from 'cheerio';
import { NodeHtmlMarkdown } from 'node-html-markdown';

const DIST = 'dist';
const nhm = new NodeHtmlMarkdown({
  bulletMarker: '-',
  codeBlockStyle: 'fenced',
});

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, files);
    else if (entry === 'index.html') files.push(p);
  }
  return files;
}

function htmlToMdPath(htmlPath) {
  const dir = dirname(htmlPath);
  if (dir === DIST) return `${DIST}/index.md`;
  return `${dir}.md`;
}

function quote(s) {
  return JSON.stringify(s);
}

let written = 0;
for (const htmlPath of walk(DIST)) {
  const html = readFileSync(htmlPath, 'utf-8');
  const $ = cheerio.load(html);

  const title = $('title').text().trim();
  const description = $('meta[name="description"]').attr('content')?.trim() ?? '';
  const canonical = $('link[rel="canonical"]').attr('href')?.trim() ?? '';

  $('nav, footer, script, style, link, noscript, svg').remove();

  const bodyHtml = $('body').html() ?? '';
  const md = nhm.translate(bodyHtml).trim();

  const frontmatter = [
    '---',
    title ? `title: ${quote(title)}` : null,
    description ? `description: ${quote(description)}` : null,
    canonical ? `canonical: ${canonical}` : null,
    '---',
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');

  const mdPath = htmlToMdPath(htmlPath);
  writeFileSync(mdPath, frontmatter + md + '\n', 'utf-8');
  written++;
}

console.log(`Generated ${written} .md files in ${DIST}/`);
