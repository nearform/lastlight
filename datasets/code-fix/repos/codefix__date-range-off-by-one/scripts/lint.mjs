#!/usr/bin/env node
// Tiny, dependency-free linter for src/ — runs offline (no install needed) and
// is intentionally UNRELATED to the date bug, so `npm run lint` is green before
// and after the fix. It just enforces a couple of house rules so the repo has a
// real, passing lint command (what the build workflow's guardrails phase looks
// for in a maintained project).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const problems = [];
for (const name of readdirSync(srcDir)) {
  if (!name.endsWith(".ts")) continue;
  const text = readFileSync(join(srcDir, name), "utf8");
  if (!text.endsWith("\n")) problems.push(`${name}: missing final newline`);
  if (/\bconsole\.log\(/.test(text)) problems.push(`${name}: stray console.log`);
  if (/[ \t]+$/m.test(text)) problems.push(`${name}: trailing whitespace`);
}

if (problems.length) {
  console.error(`lint failed (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("lint ok");
