#!/usr/bin/env -S npx tsx
/**
 * The re-review delta, replayed for $0 (issue #429): which code each review
 * round of a real PR had ALREADY seen, and — given the comments a reviewer
 * actually posted — which of them were late discoveries.
 *
 * No model is called. For each head, in order, it runs the same code-facts CLI
 * pr-review's `facts` and `units` phases run (`all` over the merge base, then
 * `units`), in a throwaway worktree of `--repo`; from round 2 on, `units` gets
 * `--prior` = the previous round's units projected as `prior-review.json`
 * (each unit's `{key, contentSha}` plus per-file line hashes — what the PR's
 * review ledger carries). Per round it prints:
 *
 *   - units by delta (new / changed / affected / unchanged) — the SITE
 *     planner's scope: rows of `unchanged` units form no site;
 *   - the unchanged units;
 *   - with `--comments`, each of that round's comments judged as the
 *     convergence gate judges a finding — code-facts' `anchorDelta(prior,
 *     path, <the anchored lines at this head>, <its unit's delta>)`:
 *     `unchanged` = every non-trivial anchored line was already there at the
 *     previous round's head = a LATE discovery.
 *
 * Usage:
 *   npx tsx scripts/rereview-delta-replay.ts --repo <checkout> --base <ref|sha> \
 *       --heads <sha1>,<sha2>[,<sha3>…] [--comments <file.json>] \
 *       [--comment <round>:<path>:<line>[-<end>]]… [--json <out.json>] [--keep <dir>]
 *
 *   --repo      a git checkout (or mirror) that already HOLDS every head and the
 *               base — nothing is fetched. Left untouched: each head is cut in a
 *               `git worktree` that is removed afterwards.
 *   --base      the PR's base (branch or SHA); the merge base with each head is taken.
 *   --heads     the review rounds' heads, OLDEST first.
 *   --comments  JSON array of `{ "round": <1-based>, "path": "...", "line": N,
 *               "start_line"?: N }` — e.g. every inline comment a review posted,
 *               tagged with the round whose head it was posted on.
 *   --comment   one comment inline, repeatable: `2:src/a.ts:40` or `2:src/a.ts:38-40`.
 *   --json      also write the whole result as JSON.
 *   --keep      keep each round's facts.json / units.json under <dir>/round-<n>/.
 *
 * The facts binary is `LASTLIGHT_FACTS_BIN`, else `lastlight-facts` on PATH,
 * else the workspace build (`packages/code-facts/dist/cli.js`) — build it
 * first (`pnpm --filter lastlight-code-facts build`).
 *
 * Example (nearform/lastlight#1680-style chain):
 *   npx tsx scripts/rereview-delta-replay.ts --repo ~/work/target --base main \
 *       --heads 1d60d667…,fcfc6296…,557eb5bc… --comments comments.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveFactsBin } from "../src/paths.js";
import { deltaCounts } from "../src/rereview.js";
import { fileAt, judgeComments, UnitsOracle, type AnchoredComment, type CommentVerdict, type RoundUnit } from "../src/rereview-node.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flags = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));

function die(msg: string): never {
  console.error(`rereview-delta-replay: ${msg}`);
  process.exit(2);
}

/** `2:src/a.ts:38-40` → `{ round: 2, path, start_line: 38, line: 40 }`. */
function parseCommentArg(arg: string): AnchoredComment & { round: number } {
  const m = /^(\d+):(.+):(\d+)(?:-(\d+))?$/.exec(arg);
  if (!m) die(`--comment wants <round>:<path>:<line>[-<end>], got ${JSON.stringify(arg)}`);
  const a = Number(m[3]);
  const b = m[4] !== undefined ? Number(m[4]) : undefined;
  return { round: Number(m[1]), path: m[2]!, ...(b !== undefined ? { start_line: Math.min(a, b), line: Math.max(a, b) } : { line: a }) };
}

const repo = flag("--repo");
const base = flag("--base");
const headsArg = flag("--heads");
if (!repo || !base || !headsArg) die("--repo, --base and --heads are required (see the header for usage)");
const heads = headsArg.split(",").map((h) => h.trim()).filter(Boolean);
if (heads.length < 1) die("--heads needs at least one SHA");
const factsBin = resolveFactsBin();
if (!factsBin) die("no lastlight-facts binary (set LASTLIGHT_FACTS_BIN, or build packages/code-facts)");

const comments: (AnchoredComment & { round: number })[] = [];
const commentsFile = flag("--comments");
if (commentsFile) {
  const raw = JSON.parse(readFileSync(resolve(commentsFile), "utf8")) as unknown;
  if (!Array.isArray(raw)) die("--comments must be a JSON array");
  for (const c of raw as Record<string, unknown>[]) {
    if (typeof c.round !== "number" || typeof c.path !== "string" || typeof c.line !== "number") die(`bad comment ${JSON.stringify(c)}: needs round, path, line`);
    comments.push({ round: c.round, path: c.path, line: c.line, ...(typeof c.start_line === "number" ? { start_line: c.start_line } : {}) });
  }
}
for (const a of flags("--comment")) comments.push(parseCommentArg(a));
for (const c of comments) if (c.round < 1 || c.round > heads.length) die(`comment round ${c.round} is outside 1..${heads.length}`);

const repoDir = resolve(repo);
const keep = flag("--keep");
const oracle = new UnitsOracle({ repoDir, base, factsBin, ...(keep ? { root: resolve(keep) } : {}) });

interface RoundOut {
  round: number;
  head: string;
  units: number;
  coverage: string | null;
  degraded: string[];
  delta: ReturnType<typeof deltaCounts> | null;
  unchanged: { key: string | null; file: string | null; lines: [number, number] | null }[];
  comments: CommentVerdict[];
}
const out: RoundOut[] = [];
const short = (sha: string) => sha.slice(0, 10);

for (let i = 0; i < heads.length; i++) {
  const head = heads[i]!;
  const started = Date.now();
  const cut = oracle.at(heads, i);
  const prior = oracle.priorFor(heads, i);
  const units: RoundUnit[] = cut.units;
  const parents = new Map<string, RoundUnit>();
  for (const u of units) if (!parents.has(u.splitOf ?? u.id)) parents.set(u.splitOf ?? u.id, u);
  const unchanged = [...parents.values()].filter((u) => u.delta === "unchanged").map((u) => ({ key: u.key ?? null, file: u.file, lines: u.lines }));
  const roundComments = comments.filter((c) => c.round === i + 1);
  const verdicts = judgeComments({ comments: roundComments, prior, units, fileText: (p) => fileAt(repoDir, head, p) });
  const delta = deltaCounts([...parents.values()]) ?? null;
  out.push({ round: i + 1, head, units: parents.size, coverage: cut.coverage, degraded: cut.degraded, delta, unchanged, comments: verdicts });

  console.log(`\nround ${i + 1} @ ${short(head)}${i ? ` (vs ${short(heads[i - 1]!)})` : " (first review)"} — ${parents.size} unit(s), ${((Date.now() - started) / 1000).toFixed(1)}s`);
  // The replay skips `seed` and core's spec obligations on purpose (an
  // obligation never changes a unit's identity or delta), so those two
  // degradations are expected; anything else is worth reading.
  const unexpected = cut.degraded.filter((d) => !/(spec-)?obligations\.json not found/.test(d));
  if (unexpected.length) console.log(`  degraded: ${unexpected.slice(0, 3).join("; ")}`);
  if (delta) {
    console.log(`  delta: new ${delta.new ?? 0} · changed ${delta.changed ?? 0} · affected ${delta.affected ?? 0} · unchanged ${delta.unchanged ?? 0}`);
    for (const u of unchanged) console.log(`    unchanged  ${u.key ?? "?"}${u.lines ? `  (${u.file}:${u.lines[0]}-${u.lines[1]})` : ""}`);
  }
  if (verdicts.length) {
    const late = verdicts.filter((v) => v.verdict === "unchanged").length;
    const judged = verdicts.filter((v) => v.verdict !== null).length;
    console.log(`  comments: ${verdicts.length}${i ? ` — late discoveries ${late}/${judged}` : " (first review: nothing is late)"}`);
    for (const v of verdicts) {
      const loc = `${v.path}:${v.start_line !== undefined ? `${v.start_line}-` : ""}${v.line ?? "?"}`;
      const unit = v.unit ? ` unit ${v.unit.key ?? "?"}${v.unit.delta ? ` [${v.unit.delta}]` : ""}` : " (no unit)";
      const first = v.anchor.find((l) => l.trim())?.trim().slice(0, 70) ?? "";
      console.log(`    ${(v.verdict ?? "n/a").padEnd(9)} ${loc}${unit}${first ? `  — ${first}` : ""}`);
    }
  }
}

const later = out.filter((r) => r.round >= 2).flatMap((r) => r.comments);
if (later.length) {
  const late = later.filter((v) => v.verdict === "unchanged").length;
  const judged = later.filter((v) => v.verdict !== null).length;
  console.log(`\nrounds ≥ 2: ${late}/${judged} comment(s) on lines unchanged since the previous round (late discoveries)`);
}
const jsonOut = flag("--json");
if (jsonOut) {
  writeFileSync(resolve(jsonOut), `${JSON.stringify({ repo: repoDir, base, heads, rounds: out }, null, 2)}\n`);
  console.log(`wrote ${jsonOut}`);
}
