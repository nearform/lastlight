/**
 * One-off audit: print WHICH finding the internal-recall judge credits for each
 * gold, with its tier — over preserved artifact dirs. Read-only; spends one
 * MATCH call per dir (~$0.01). Written for the 2026-08-24 §2f re-audit (journal
 * in git history; `docs/plans/deterministic-pr-levers.md` §"The instrument
 * (WP8)"): the counts alone cannot distinguish "withheld defect claim"
 * (H-A1) from "posted but uncredited by the review judge" (H-A4).
 *
 * Usage: npx tsx scripts/audit-internal-pairs.ts [--dry-run] [--no-confirm] \\
 *          <instances.json> <instance_id> <dir> [...]
 *
 * A `<dir>` may be any of three things, and the script works out which:
 *
 *   1. a `pr-review` directory itself;
 *   2. a hand-copied ARCHIVE run — `<dir>/<instance_id>/pr-review`, the layout
 *      `~/lastlight-run-artifacts/` uses and the only one this script spoke
 *      until 2026-09-21;
 *   3. an EVAL RUN directory — since `persistPipelineArtifacts` landed, a run
 *      records its own artifacts at `results[].pipelineArtifactRel`
 *      (`sessions/<case>__<arm>/trial-N/pr-review`). That pointer is read out
 *      of `scorecard.json` rather than reconstructed, because the run already
 *      wrote down where it put them and guessing the path is how a reader ends
 *      up auditing the wrong arm. One run dir can hold SEVERAL arms and
 *      repeats, so every matching result is audited and labelled with its arm.
 *
 * Getting this wrong is not loud on its own — the old code built one path and
 * printed "no artifacts" for anything else, which reads identically to a run
 * that genuinely produced none. So a dir that matches no layout now prints the
 * paths it tried.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gradeInternalRecall } from "../src/grade.js";
import { internalJudgeInputs, readPipelineArtifacts } from "../src/review-pipeline-stats.js";
import type { GoldComment } from "../src/schema.js";

const argv = process.argv.slice(2);
/** Resolve and price the work, spend nothing. The siblings that spend
 * (`backfill-pipeline`, `finding-calibration`) all estimate before they buy;
 * this one silently bought one MATCH call per dir on plain invocation. It is
 * also the only way to check the layout resolution without paying for it. */
const dryRun = argv.includes("--dry-run");
/** Reproduce the pre-2026-09-21 grader (MATCH only). The audit that motivated
 * the CONFIRM pass was run this way, so this is how its numbers are re-derived
 * — and how CONFIRM's effect on an archived run is measured as a difference
 * rather than asserted. */
const noConfirm = argv.includes("--no-confirm");
const [instancesPath, instanceId, ...dirs] = argv.filter((a) => a !== "--dry-run" && a !== "--no-confirm");
if (!instancesPath || !instanceId || !dirs.length) {
  console.error("usage: audit-internal-pairs.ts [--dry-run] [--no-confirm] <instances.json> <instance_id> <artifactDir> [...]");
  process.exit(2);
}
const instances = JSON.parse(readFileSync(instancesPath, "utf8")) as { instance_id: string; review_gold?: GoldComment[] }[];
const gold = instances.find((i) => i.instance_id === instanceId)?.review_gold;
if (!gold?.length) {
  console.error(`no review_gold for ${instanceId}`);
  process.exit(2);
}

/** Every `pr-review` directory in `dir` belonging to `instanceId`, labelled.
 * Exported for the layout check — the three-way branch is the part worth
 * testing, and it is pure apart from `existsSync`. */
export function resolveArtifactDirs(dir: string, id: string): { label: string; path: string }[] {
  // 1. already a pr-review dir
  if (existsSync(join(dir, "findings.json"))) return [{ label: dir, path: dir }];

  // 2. the archive layout
  const archive = join(dir, id, "pr-review");
  if (existsSync(join(archive, "findings.json"))) return [{ label: `${dir} [archive]`, path: archive }];

  // 3. an eval run — ask the scorecard where it put them.
  const card = join(dir, "scorecard.json");
  if (existsSync(card)) {
    try {
      const doc = JSON.parse(readFileSync(card, "utf8")) as {
        results?: { instance_id?: string; model?: string; pipelineArtifactRel?: string }[];
      };
      return (doc.results ?? [])
        .filter((r) => r.instance_id === id && r.pipelineArtifactRel)
        .map((r) => ({ label: `${dir} [${r.model ?? "?"}]`, path: join(dir, r.pipelineArtifactRel!) }))
        .filter((c) => existsSync(join(c.path, "findings.json")));
    } catch {
      // fall through to the refusal below — a malformed scorecard is not an
      // absence of artifacts and must not read as one.
    }
  }
  return [];
}

const targets = dirs.flatMap((d) => {
  const found = resolveArtifactDirs(d, instanceId);
  if (!found.length) {
    console.log(
      `${d}: no artifacts for ${instanceId} — tried the dir itself, ` +
        `${join(d, instanceId, "pr-review")}, and scorecard.json's pipelineArtifactRel`,
    );
  }
  return found;
});

/** ~$0.01 per judge call: MATCH, plus CONFIRM unless it is switched off. */
const ESTIMATE_USD_PER_CALL = 0.01;
const callsPerDir = noConfirm ? 1 : 2;
console.log(
  `\n${targets.length} target(s) for ${instanceId} · ${noConfirm ? "MATCH only" : "MATCH + CONFIRM"} ` +
    `· ~$${(targets.length * callsPerDir * ESTIMATE_USD_PER_CALL).toFixed(2)}`,
);
for (const t of targets) console.log(`  ${t.label}\n    ${t.path}`);
if (dryRun) {
  console.log(`\n--dry-run: resolved only, nothing spent.`);
  process.exit(0);
}

for (const { label: dir, path } of targets) {
  const readout = readPipelineArtifacts(path);
  if (!readout) {
    console.log(`${dir}: unreadable at ${path}`);
    continue;
  }
  const grade = await gradeInternalRecall({
    gold,
    findings: internalJudgeInputs(readout.findings),
    ...(noConfirm ? { confirm: false } : {}),
  });
  const pre = grade?.matchedPreConfirm;
  console.log(
    `\n== ${dir} (matched ${grade?.matched ?? "?"}${pre !== undefined ? ` — CONFIRM dropped ${pre - (grade?.matched ?? 0)} of ${pre}` : ""})`,
  );
  if (grade?.error) {
    console.log(`  JUDGE ERROR — every row below is the all-null placeholder: ${grade.error}`);
    continue;
  }
  if (grade?.confirmUngraded) console.log(`  CONFIRM DID NOT RUN — the count is raw MATCH: ${grade.confirmUngraded}`);
  // Print what CONFIRM threw out, not just what survived. A rejection is the
  // half of this audit that is new, and an unreviewable correction is its own
  // kind of unreliable instrument.
  for (const r of grade?.confirmRejected ?? []) {
    const f = readout.findings[r.finding];
    console.log(`  gold[${r.gold}] REJECTED by CONFIRM <- [${f?.tier ?? "?"}] "${f?.title.slice(0, 90)}"`);
  }
  grade?.goldToFinding.forEach((f, g) => {
    const goldDesc = (gold[g].description ?? "").replace(/\s+/g, " ").slice(0, 90);
    if (f === null) {
      console.log(`  gold[${g}] MISS   | ${goldDesc}`);
    } else {
      const fin = readout.findings[f];
      console.log(`  gold[${g}] -> [${fin?.tier ?? "?"}] conf=${fin?.confidence ?? "?"} "${fin?.title.slice(0, 90)}"`);
      console.log(`           gold: ${goldDesc}`);
    }
  });
}
