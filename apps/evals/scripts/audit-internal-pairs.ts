/**
 * One-off audit: print WHICH finding the internal-recall judge credits for each
 * gold, with its tier — over preserved artifact dirs. Read-only; spends one
 * MATCH call per dir (~$0.01). Written for the 2026-08-24 §2f re-audit
 * (RESTART.md): the counts alone cannot distinguish "withheld defect claim"
 * (H-A1) from "posted but uncredited by the review judge" (H-A4).
 *
 * Usage: npx tsx scripts/audit-internal-pairs.ts <instances.json> <instance_id> <artifactDir> [...]
 */
import { readFileSync } from "node:fs";

import { gradeInternalRecall } from "../src/grade.js";
import { internalJudgeInputs, readPipelineArtifacts } from "../src/review-pipeline-stats.js";
import type { GoldComment } from "../src/schema.js";

const [instancesPath, instanceId, ...dirs] = process.argv.slice(2);
if (!instancesPath || !instanceId || !dirs.length) {
  console.error("usage: audit-internal-pairs.ts <instances.json> <instance_id> <artifactDir> [...]");
  process.exit(2);
}
const instances = JSON.parse(readFileSync(instancesPath, "utf8")) as { instance_id: string; review_gold?: GoldComment[] }[];
const gold = instances.find((i) => i.instance_id === instanceId)?.review_gold;
if (!gold?.length) {
  console.error(`no review_gold for ${instanceId}`);
  process.exit(2);
}

for (const dir of dirs) {
  const readout = readPipelineArtifacts(`${dir}/${instanceId}/pr-review`);
  if (!readout) {
    console.log(`${dir}: no artifacts`);
    continue;
  }
  const grade = await gradeInternalRecall({ gold, findings: internalJudgeInputs(readout.findings) });
  console.log(`\n== ${dir} (matched ${grade?.matched ?? "?"})`);
  if (grade?.error) {
    console.log(`  JUDGE ERROR — every row below is the all-null placeholder: ${grade.error}`);
    continue;
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
