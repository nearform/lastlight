#!/usr/bin/env -S npx tsx
/**
 * Import Martian's Code Review Bench offline set into a `pr-review` eval tier.
 *
 * Source of truth is the benchmark's `offline/results/benchmark_data.json` — a
 * map keyed by upstream PR (or discourse commit) URL, with the human-verified
 * `golden_comments` inlined. For each entry this resolves the base/head commits
 * (via `gh`) and emits a {@link SweBenchInstance} with a `pr` fixture + a
 * `review_gold` set, pinned by SHA so the dataset is reproducible. The heavy repo
 * clone happens later, at run time (run.ts's prefetch).
 *
 * Two source shapes are handled:
 *   - a real PR   (`.../pull/N`)   → `gh pr view` for refs + oids.
 *   - a commit    (`.../commit/SHA`, discourse) → head = SHA, base = its parent.
 * Anything else (e.g. a benchmark fork with no upstream) is SKIPPED and logged —
 * never silently dropped.
 *
 * Usage:
 *   npx tsx scripts/import-martian.ts [--repo <clone>] [--out <datasetsDir>]
 *                                     [--tier <name>] [--limit N] [--dry-run]
 * Needs `gh` (authenticated) + network. With no --repo it shallow-clones
 * withmartian/code-review-benchmark into .eval-cache/.
 *
 * `--tier <name>` (default `pr-review`) picks the tier DIRECTORY the import
 * lands in (`<out>/<name>/`) and the `name` stamped into a freshly-written
 * `tier.json`, so e.g. a held-out split can live beside the main tier and be
 * addressed by its own name (`discovery.ts` keys tiers on `tier.json`'s
 * `name`, falling back to the dir name). The tier's `defaultWorkflow` stays
 * `pr-review` regardless — every import runs the pr-review workflow.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { SweBenchInstance, PullSeed, GoldComment } from "../src/schema.js";

const BENCH_REPO = "https://github.com/withmartian/code-review-benchmark.git";

function sh(bin: string, args: string[], cwd?: string): string {
  return execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 });
}
function ghJson<T>(args: string[]): T {
  return JSON.parse(sh("gh", args)) as T;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

interface BenchEntry {
  pr_title?: string;
  original_url?: string | null;
  source_repo?: string;
  golden_comments?: { comment: string; severity: string }[];
}

const SEVERITY = new Set(["low", "medium", "high", "critical"]);
function severity(s: string): GoldComment["severity"] {
  const v = (s || "").toLowerCase();
  return (SEVERITY.has(v) ? v : "medium") as GoldComment["severity"];
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
function truncate(s: string | undefined, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? t.slice(0, n) + "\n\n[…truncated]" : t;
}

function goldOf(entry: BenchEntry): GoldComment[] {
  return (entry.golden_comments ?? [])
    .filter((c) => c.comment?.trim())
    .map((c) => ({ severity: severity(c.severity), description: c.comment.trim() }));
}

/** Resolve a real PR URL → a PullSeed (refs + oids from `gh pr view`). */
function pullFromPr(url: string): { repo: string; pr: PullSeed } {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`not a PR url: ${url}`);
  const [, owner, name, num] = m;
  const view = ghJson<{
    number: number;
    title: string;
    body?: string;
    baseRefName: string;
    headRefName: string;
    baseRefOid: string;
    headRefOid: string;
    author?: { login?: string };
  }>(["pr", "view", url, "--json", "number,title,body,baseRefName,headRefName,baseRefOid,headRefOid,author"]);
  return {
    repo: `${owner}/${name}`,
    pr: {
      number: view.number ?? Number(num),
      title: view.title ?? "",
      body: truncate(view.body, 6000),
      base_ref: view.baseRefName,
      head_ref: view.headRefName,
      base_commit: view.baseRefOid,
      head_commit: view.headRefOid,
      user: view.author?.login,
    },
  };
}

/** Resolve a commit URL (discourse) → a PullSeed: head = SHA, base = its parent,
 * base_ref = the repo's default branch, head_ref synthesized. `fallbackNumber`
 * comes from the benchmark fork's PR number so the fake PR id is stable. */
function pullFromCommit(url: string, fallbackNumber: number): { repo: string; pr: PullSeed } {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]+)/i);
  if (!m) throw new Error(`not a commit url: ${url}`);
  const [, owner, name, sha] = m;
  const repo = `${owner}/${name}`;
  const commit = ghJson<{ sha: string; parents: { sha: string }[]; commit: { message: string } }>([
    "api",
    `repos/${owner}/${name}/commits/${sha}`,
  ]);
  const parent = commit.parents?.[0]?.sha;
  if (!parent) throw new Error(`commit ${sha} has no parent (root commit) — can't diff`);
  const meta = ghJson<{ default_branch: string }>(["api", `repos/${owner}/${name}`]);
  const message = commit.commit?.message ?? "";
  const title = message.split("\n")[0].slice(0, 120);
  return {
    repo,
    pr: {
      number: fallbackNumber,
      title,
      body: truncate(message, 6000),
      base_ref: meta.default_branch || "main",
      head_ref: `crb-${slug(name)}-${fallbackNumber}`,
      base_commit: parent,
      head_commit: commit.sha,
    },
  };
}

function forkNumber(key: string): number {
  const m = key.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const limit = flag("limit") ? Number(flag("limit")) : Infinity;
  const outRoot = resolve(flag("out") ?? "datasets");
  const tier = flag("tier") ?? "pr-review";

  // Locate (or clone) the benchmark repo.
  let repoPath = flag("repo");
  if (!repoPath) {
    const cache = resolve(process.env.LASTLIGHT_EVALS_CACHE ?? ".eval-cache");
    repoPath = join(cache, "code-review-benchmark");
    if (!existsSync(repoPath)) {
      mkdirSync(cache, { recursive: true });
      console.log(`Cloning ${BENCH_REPO} → ${repoPath} …`);
      sh("git", ["clone", "--depth", "1", "--quiet", BENCH_REPO, repoPath]);
    }
  }
  const dataPath = join(repoPath, "offline", "results", "benchmark_data.json");
  if (!existsSync(dataPath)) {
    console.error(`benchmark_data.json not found at ${dataPath} — is --repo a code-review-benchmark checkout?`);
    return 1;
  }

  const data = JSON.parse(readFileSync(dataPath, "utf8")) as Record<string, BenchEntry>;
  const entries = Object.entries(data).slice(0, limit);
  console.log(`Resolving ${entries.length} PR(s) via gh …`);

  const instances: SweBenchInstance[] = [];
  const skipped: { key: string; reason: string }[] = [];

  for (const [key, entry] of entries) {
    const upstream = entry.original_url || key;
    const gold = goldOf(entry);
    if (!gold.length) {
      skipped.push({ key, reason: "no golden_comments" });
      continue;
    }
    try {
      let resolved: { repo: string; pr: PullSeed };
      if (/\/pull\/\d+/.test(upstream)) {
        resolved = pullFromPr(upstream);
      } else if (/\/commit\/[0-9a-f]+/i.test(upstream)) {
        resolved = pullFromCommit(upstream, forkNumber(key));
      } else {
        skipped.push({ key, reason: `unrecognized source url: ${upstream}` });
        continue;
      }
      const src = entry.source_repo || resolved.repo.split("/")[1];
      const inst: SweBenchInstance = {
        instance_id: `prreview__${slug(src)}-${resolved.pr.number}`,
        repo: resolved.repo,
        workflow: "pr-review",
        problem_statement: entry.pr_title || resolved.pr.title,
        pr: resolved.pr,
        review_gold: gold,
        expect_github: { review_submitted: {} },
      };
      instances.push(inst);
      console.log(`  ✓ ${inst.instance_id}  (${gold.length} gold, ${resolved.repo})`);
    } catch (err) {
      skipped.push({ key, reason: (err as Error).message.split("\n")[0].slice(0, 160) });
      console.log(`  ✗ ${key} — ${(err as Error).message.split("\n")[0].slice(0, 120)}`);
    }
  }

  console.log(`\nResolved ${instances.length} instance(s); skipped ${skipped.length}.`);
  for (const s of skipped) console.log(`  skip ${s.key}: ${s.reason}`);

  if (dryRun) {
    console.log("\n--dry-run: not writing. First instance:\n");
    console.log(JSON.stringify(instances[0], null, 2));
    return 0;
  }

  const tierDir = join(outRoot, tier);
  mkdirSync(tierDir, { recursive: true });
  const tierJson = join(tierDir, "tier.json");
  if (!existsSync(tierJson)) {
    // `name` follows --tier so the tier is discoverable under the chosen name;
    // `defaultWorkflow` is ALWAYS pr-review — the workflow the cases exercise
    // doesn't change with the directory they live in.
    writeFileSync(
      tierJson,
      JSON.stringify(
        { name: tier, defaultWorkflow: "pr-review", description: "Martian Code Review Bench — pr-review precision (F0.5)." },
        null,
        2,
      ) + "\n",
    );
  }
  const outPath = join(tierDir, "instances.json");
  writeFileSync(outPath, JSON.stringify(instances, null, 2) + "\n");
  console.log(`\nWrote ${instances.length} instance(s) → ${outPath}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
