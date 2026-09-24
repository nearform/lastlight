#!/usr/bin/env -S npx tsx
/**
 * The seeder's QUESTION, not its location: of the gold a human reviewer wrote,
 * did any seeded obligation ask a question whose honest answer IS that defect?
 *
 * ## Why this exists
 *
 * `facts-obligations.ts` measures whether an obligation ever NAMED the gold's
 * file (or line window) — and says of itself that naming is necessary, never
 * sufficient. Measured on the 2026-09-24 micro-survey screens, the gap between
 * the two is the whole story on some fixtures: on `1587-r3` the seed put a row
 * within 15 lines of G2 (a dual roster) and G4 (a new hard domain gate), every
 * model and every full Haiku arm stood there, and none of them ever reported
 * either — because the obligation asked "quote the line that enforces
 * `ALLOWED_EMAIL_DOMAIN`", and "it is enforced" is a complete, correct answer
 * to that question that says nothing about who it now locks out.
 *
 * So this asks a judge, per gold, to sort the fixture's obligations into:
 *
 *   surfaces   answered honestly and in full, the question REPORTS this
 *              defect — the gold is the answer, or a direct consequence of it
 *   adjacent   points at the right code, but can be answered completely
 *              ("it is enforced", "it matches") without the defect coming up
 *
 * and reports it beside the deterministic location match, so the three states
 * a gold can be in are visible: not seeded, seeded-but-asked-wrong, seeded and
 * asked right.
 *
 * ## What this is NOT
 *
 * A judge call, not a measurement of any survey run, and a single pass at
 * temperature 0 — which the micro-survey baseline showed can still flip on a
 * borderline pair. Read it as a map of where the seed's framing fails, per
 * fixture, not as a rate to three decimals. `--votes 3` takes a majority.
 *
 * Usage (from an evals workspace, e.g. ~/work/nearform-evals):
 *   npx tsx <lastlight>/apps/evals/scripts/seed-questions.ts \
 *     --fixtures ~/lastlight-micro-fixtures/arm2 \
 *     --instances evals/datasets/pr-review/instances.json [--votes 3] [--out f.json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { defaultJudgeModel, judge, parseJudgeJson } from "../src/judge.js";
import type { GoldComment } from "../src/schema.js";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fixturesDir = flag("--fixtures");
const instancesPath = flag("--instances");
const votes = Math.max(1, Number(flag("--votes") ?? "1"));
const outPath = flag("--out");
const WINDOW = 15;
if (!fixturesDir || !instancesPath) {
  console.error("usage: seed-questions.ts --fixtures <dir> --instances <instances.json> [--votes n] [--out f.json]");
  process.exit(2);
}

interface Obligation {
  id: string;
  family: string;
  mechanism?: string;
  question?: string;
  introducedAt?: { path?: string; line?: number };
  enforcedAt?: { candidates?: string[] };
}

const SYSTEM =
  "You audit the QUESTIONS a code-review pipeline asked, not its answers. For each GOLD (a defect a human reviewer " +
  "confirmed in this pull request) you are given every OBLIGATION the pipeline seeded — a question a reviewer pass " +
  "was required to answer. Sort the obligations for that gold into two lists:\n" +
  '  "surfaces": answered honestly and in full, this question REPORTS the gold\'s defect — the defect is the answer, ' +
  "or follows directly from answering it. \n" +
  '  "adjacent": it points at the same code, constant or mechanism, but can be answered completely and correctly ' +
  '("it is enforced", "the line exists", "the signature matches") WITHOUT the defect ever coming up.\n' +
  "Leave out obligations unrelated to the gold. Being about the same file is NOT enough for either list. Judge the " +
  "question as written, not what a diligent reviewer might go on to notice. It is normal for a gold to have nothing " +
  'in "surfaces". Output ONLY JSON: {"golds":[{"gold":<index>,"surfaces":[<obligation id>],"adjacent":[<obligation id>],' +
  '"why":"<one sentence>"}]}';

type Verdict = { gold: number; surfaces?: string[]; adjacent?: string[]; why?: string };

function samePath(a: string, b: string) {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
function obligationSites(o: Obligation): { path: string; line: number | null }[] {
  const out: { path: string; line: number | null }[] = [];
  if (o.introducedAt?.path) out.push({ path: o.introducedAt.path, line: o.introducedAt.line ?? null });
  for (const c of o.enforcedAt?.candidates ?? []) {
    const m = /^(.+):(\d+)/.exec(c);
    if (m) out.push({ path: m[1], line: Number(m[2]) });
  }
  return out;
}
function locatedNear(o: Obligation, g: GoldComment): boolean {
  if (!g.file) return false;
  return obligationSites(o).some(
    (s) => samePath(s.path, g.file!) && (g.line == null || (s.line !== null && Math.abs(s.line - g.line) <= WINDOW)),
  );
}

const instances = JSON.parse(readFileSync(instancesPath, "utf8")) as { instance_id: string; review_gold?: GoldComment[] }[];
const model = defaultJudgeModel();
const report: unknown[] = [];
let totalGold = 0, located = 0, surfaced = 0, adjacentOnly = 0;

for (const iid of readdirSync(fixturesDir).sort()) {
  const gold = instances.find((i) => i.instance_id === iid)?.review_gold ?? [];
  if (!gold.length) continue;
  const sandboxes = join(fixturesDir, iid, "sandboxes");
  if (!existsSync(sandboxes)) continue;
  const task = join(sandboxes, readdirSync(sandboxes)[0]);
  const repo = readdirSync(task).find((e) => existsSync(join(task, e, ".git")));
  const ojPath = repo ? join(task, repo, ".lastlight/pr-review/obligations.json") : "";
  if (!ojPath || !existsSync(ojPath)) continue;
  const obligations = (JSON.parse(readFileSync(ojPath, "utf8")) as { obligations: Obligation[] }).obligations;

  const user = JSON.stringify({
    gold: gold.map((g, i) => ({ index: i, file: g.file ?? null, line: g.line ?? null, description: g.description })),
    obligations: obligations.map((o) => ({
      id: o.id,
      family: o.family,
      at: o.introducedAt?.path ? `${o.introducedAt.path}:${o.introducedAt.line}` : null,
      mechanism: o.mechanism,
      question: o.question,
    })),
  });
  // Majority over `votes` passes: an id is in a list when more than half put it there.
  const passes = (await Promise.all(Array.from({ length: votes }, () => judge(model, SYSTEM, user))))
    .map((raw) => parseJudgeJson<{ golds?: Verdict[] }>(raw)?.golds)
    .filter((g): g is Verdict[] => Array.isArray(g));
  if (!passes.length) {
    console.log(`\n${iid}: judge reply unparseable — skipped`);
    continue;
  }
  const majority = (j: number, key: "surfaces" | "adjacent") => {
    const n = new Map<string, number>();
    for (const p of passes) for (const id of p.find((v) => v.gold === j)?.[key] ?? []) n.set(id, (n.get(id) ?? 0) + 1);
    return [...n].filter(([, c]) => c * 2 > passes.length).map(([id]) => id);
  };

  const byId = new Map(obligations.map((o) => [o.id, o]));
  const fam = (ids: string[]) => [...new Set(ids.map((id) => byId.get(id)?.family ?? "?"))].join(",");
  console.log(`\n${iid.replace(/^prreview__/, "")}  (${obligations.length} obligations, ${passes.length} judge pass${passes.length > 1 ? "es" : ""})`);
  gold.forEach((g, j) => {
    totalGold++;
    const near = obligations.filter((o) => locatedNear(o, g)).map((o) => o.id);
    const s = majority(j, "surfaces");
    const a = majority(j, "adjacent").filter((id) => !s.includes(id));
    if (near.length) located++;
    if (s.length) surfaced++;
    else if (a.length || near.length) adjacentOnly++;
    const state = s.length ? `ASKED RIGHT  ${s.join(" ")} (${fam(s)})` : a.length || near.length ? `asked wrong  ${[...new Set([...a, ...near])].slice(0, 6).join(" ")}` : "not seeded";
    const why = passes[0].find((v) => v.gold === j)?.why ?? "";
    const label = `  G${j + 1} ${(g.file ?? "(no file)").split("/").pop()}${g.line ? `:${g.line}` : ""}`;
    console.log(`${label.padEnd(42)} located ${near.length ? "yes" : "no "}  ${state}`);
    if (why) console.log(`      ${why.slice(0, 200)}`);
    report.push({ instance: iid, gold: j, file: g.file, line: g.line, locatedNear: near, surfaces: s, adjacent: a, why });
  });
}

console.log(
  `\n== ${totalGold} gold · located near a seeded obligation ${located} · a question that SURFACES it ${surfaced} · ` +
    `seeded-but-asked-wrong ${adjacentOnly} · not seeded ${totalGold - surfaced - adjacentOnly}   (judge ${model}, votes ${votes})`,
);
if (outPath) {
  writeFileSync(outPath, JSON.stringify({ judge: model, votes, window: WINDOW, report }, null, 2));
  console.log(`   written → ${outPath}`);
}
