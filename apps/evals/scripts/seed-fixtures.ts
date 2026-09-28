/**
 * Build pr-review FIXTURES from scratch — no agent run — for the replay
 * scripts (`unit-survey-replay`, and through its `--keep` copies
 * `micro-site-review` / `micro-falsify` / `cluster-screen`).
 *
 * Per instance, with the harness's OWN pr-review seeding (`seedWorkspacePrReview`
 * — the same clone + head checkout + offline origin `run-instance` does):
 *
 *   <out>/<instance_id>/sandboxes/<task>/<repo>/        the PR head, `.git` included
 *   <out>/<instance_id>/sandboxes/<task>/AGENTS.md      the composed workspace AGENTS.md (copied)
 *   <out>/<instance_id>/origins/<task>.git              the offline origin (base + head branches)
 *   <checkout>/.lastlight/pr-review/facts.json          a STUB: baseSha / headSha only
 *   <checkout>/.lastlight/pr-review/obligations.json    a STUB: contract / minting / maxObligations
 *   <out>/<instance_id>/seed-fixture.json               provenance
 *
 * The two stubs are exactly what `unit-survey-replay` reads from a fixture: it
 * regenerates facts → seed → spec → units itself, with the stubbed seed flags.
 * `maxObligations` is stamped because a fixture with no agent run has no seed
 * transcript to recover it from (`seedArgsOf`).
 *
 * `<task>` is `run-instance`'s own task id: `<repo name>-<pr>-pr-review-<slug(id)>`.
 * The AGENTS.md is copied, not composed: core composes it from agent-context
 * with nothing repo-specific in it (all 16 v7 skillspro fixtures carry the same
 * bytes), so a real run's copy IS the faithful one. Pass it with --agents-md.
 *
 * Network: the mirror cache must already hold every base/head commit — this
 * script checks first and REFUSES a miss (a fresh upstream fetch desyncs a
 * pinned dataset — Martian upstream is 173 gold, not 137). `--allow-fetch`
 * lets `ensurePrCommitsInCache` fetch. The cache root is `--cache`, else
 * `LASTLIGHT_EVALS_CACHE`, else `./.eval-cache` (seed.ts's `resolveCacheDir`).
 *
 * Idempotent: an instance whose fixture is complete is skipped; an incomplete
 * one is rebuilt; `--force` rebuilds everything selected. $0.
 *
 * Optional: `--anchors <anchors.json> --anchored-out <file>` also writes a copy
 * of --instances with each anchored gold's `file`/`line` projected from its
 * FIRST `anchoredLines` entry, so coverage and site audits can place gold. It is
 * DERIVED (a lexical anchor, not a human placement) — never commit it.
 *
 *   npx tsx apps/evals/scripts/seed-fixtures.ts \
 *     --instances ~/work/nearform-evals/evals/datasets/pr-review-martian/instances.json \
 *     --out ~/lastlight-micro-fixtures/martian-seed \
 *     --cache ~/work/lastlight-evals/.eval-cache \
 *     --agents-md <a v7 fixture>/sandboxes/<task>/AGENTS.md \
 *     --only cal-com-8330,grafana-79265        # short ids or full prreview__ ids; omit for all
 *
 * Seed flags default to the v7 skillspro arms': --contract minimal
 * --mint all-in-diff,registrations --max-obligations 40.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveCacheDir, seedWorkspacePrReview } from "../src/seed.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flags = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const has = (name: string) => argv.includes(name);

const instancesPath = flag("--instances");
const outRoot = flag("--out");
const anchorsPath = flag("--anchors");
const anchoredOut = flag("--anchored-out");
if (!instancesPath || (!outRoot && !anchoredOut)) {
  console.error(
    "usage: seed-fixtures.ts --instances <instances.json> --out <dir> [--only id[,id…]]… [--cache <dir>] [--agents-md <file>]\n" +
      "       [--contract minimal] [--mint all-in-diff,registrations] [--max-obligations 40] [--force] [--allow-fetch]\n" +
      "       [--anchors <anchors.json> --anchored-out <file>]",
  );
  process.exit(2);
}
const cacheRoot = flag("--cache");
const agentsMd = flag("--agents-md");
const contract = flag("--contract") ?? "minimal";
const mint = (flag("--mint") ?? "all-in-diff,registrations").split(",").map((s) => s.trim()).filter(Boolean);
const maxObligations = Number(flag("--max-obligations") ?? "40");
const force = has("--force");
const allowFetch = has("--allow-fetch");
const only = new Set(
  flags("--only")
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("prreview__") ? s : `prreview__${s}`)),
);

interface Instance {
  instance_id: string;
  repo: string;
  pr: { number: number | string; base_ref: string; head_ref: string; base_commit: string; head_commit: string };
  review_gold?: { file?: string; line?: number }[];
}
const all = JSON.parse(readFileSync(resolve(instancesPath), "utf8")) as Instance[];
for (const id of only) if (!all.some((i) => i.instance_id === id)) throw new Error(`--only ${id}: not in ${instancesPath}`);
const selected = only.size ? all.filter((i) => only.has(i.instance_id)) : all;

// ── Optional: the anchored instances copy ───────────────────────────────────

if (anchoredOut) {
  if (!anchorsPath) throw new Error("--anchored-out needs --anchors");
  const anchors = JSON.parse(readFileSync(resolve(anchorsPath), "utf8")) as {
    cases: { instanceId: string; gold: { goldIndex: number; anchoredLines?: string[] }[] }[];
  };
  const byCase = new Map(anchors.cases.map((c) => [c.instanceId, c]));
  let placed = 0;
  let total = 0;
  const projected = all.map((inst) => {
    const c = byCase.get(inst.instance_id);
    const gold = (inst.review_gold ?? []).map((g, i) => {
      total++;
      if (g.file) return g;
      const first = c?.gold.find((x) => x.goldIndex === i)?.anchoredLines?.[0];
      const m = first ? /^(.*):(\d+)$/.exec(first) : null;
      if (!m) return g;
      placed++;
      return { ...g, file: m[1], line: Number(m[2]) };
    });
    return { ...inst, review_gold: gold };
  });
  mkdirSync(resolve(anchoredOut, ".."), { recursive: true });
  writeFileSync(resolve(anchoredOut), JSON.stringify(projected, null, 1));
  console.log(`anchored instances: ${placed}/${total} gold placed (first anchored line) → ${resolve(anchoredOut)}`);
}

if (!outRoot) process.exit(0);

// ── Fixtures ────────────────────────────────────────────────────────────────

const mirrorsDir = resolveCacheDir(cacheRoot ? resolve(cacheRoot) : undefined);
/** `run-instance`'s `slug` (not imported: that module pulls in the whole runner). */
const slug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);

const MINT_KEYS: Record<string, string> = { "all-in-diff": "allInDiff", registrations: "registrations" };

function hasCommit(mirror: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", mirror, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The task dir and checkout a fixture for `inst` lives at. */
function paths(inst: Instance) {
  const name = inst.repo.split("/")[1];
  const task = `${name}-${inst.pr.number}-pr-review-${slug(inst.instance_id)}`;
  const dir = join(resolve(outRoot!), inst.instance_id);
  const taskDir = join(dir, "sandboxes", task);
  const checkout = join(taskDir, name);
  return { name, task, dir, taskDir, checkout, prDir: join(checkout, ".lastlight", "pr-review") };
}

const complete = (p: ReturnType<typeof paths>) =>
  existsSync(join(p.checkout, ".git")) &&
  existsSync(join(p.prDir, "facts.json")) &&
  existsSync(join(p.prDir, "obligations.json")) &&
  existsSync(join(p.dir, "seed-fixture.json"));

let built = 0;
let skipped = 0;
const failed: string[] = [];
for (const inst of selected) {
  const p = paths(inst);
  if (!force && complete(p)) {
    console.log(`${inst.instance_id} … skip (complete)`);
    skipped++;
    continue;
  }
  process.stdout.write(`${inst.instance_id} … `);
  try {
    const mirror = join(mirrorsDir, `${inst.repo.replace("/", "__")}.git`);
    if (!allowFetch) {
      const missing = [inst.pr.base_commit, inst.pr.head_commit].filter((s) => !existsSync(mirror) || !hasCommit(mirror, s));
      if (missing.length) throw new Error(`mirror ${mirror} lacks ${missing.join(", ")} — refusing to fetch (pass --allow-fetch)`);
    }
    rmSync(p.dir, { recursive: true, force: true });
    const t0 = Date.now();
    seedWorkspacePrReview({
      stateDir: p.dir,
      taskId: p.task,
      repo: inst.repo,
      pullNumber: Number(inst.pr.number),
      baseRef: inst.pr.base_ref,
      headRef: inst.pr.head_ref,
      baseCommit: inst.pr.base_commit,
      headCommit: inst.pr.head_commit,
      ...(cacheRoot ? { cacheDir: resolve(cacheRoot) } : {}),
      repoSubdir: p.name,
    });
    // The pipeline's `.lastlight/` scratch is never part of the repo's tree.
    appendFileSync(join(p.checkout, ".git", "info", "exclude"), ".lastlight/\n");
    if (agentsMd) copyFileSync(resolve(agentsMd), join(p.taskDir, "AGENTS.md"));

    mkdirSync(p.prDir, { recursive: true });
    const stub = { version: 1, generatedAt: new Date().toISOString(), repo: ".", baseSha: inst.pr.base_commit, headSha: inst.pr.head_commit };
    writeFileSync(join(p.prDir, "facts.json"), JSON.stringify({ ...stub, stub: "seed-fixtures: regenerated by unit-survey-replay" }, null, 2));
    const minting = Object.fromEntries(Object.values(MINT_KEYS).map((k) => [k, false]));
    for (const m of mint) {
      if (!MINT_KEYS[m]) throw new Error(`--mint ${m}: unknown (known: ${Object.keys(MINT_KEYS).join(", ")})`);
      minting[MINT_KEYS[m]] = true;
    }
    writeFileSync(join(p.prDir, "obligations.json"), JSON.stringify({ ...stub, contract, minting, maxObligations }, null, 2));
    writeFileSync(
      join(p.dir, "seed-fixture.json"),
      JSON.stringify(
        {
          instanceId: inst.instance_id,
          repo: inst.repo,
          pr: inst.pr,
          task: p.task,
          mirror,
          agentsMd: agentsMd ? resolve(agentsMd) : null,
          seed: { contract, mint, maxObligations },
          builtAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    built++;
  } catch (err) {
    console.log(`ERROR ${(err as Error).message}`);
    failed.push(inst.instance_id);
  }
}
console.log(`\n${built} built, ${skipped} skipped, ${failed.length} failed${failed.length ? `: ${failed.join(", ")}` : ""} → ${resolve(outRoot)}`);
if (failed.length) process.exit(1);
