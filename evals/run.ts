/**
 * Eval runner (a measurement, not a test).
 *
 * Drives the REAL production workflows (issue-triage / build / …) against a
 * fake GitHub for each model under test, grades deterministically, and prints
 * a model-comparison scorecard + writes SWE-bench-compatible artifacts. It
 * exits non-zero only if the HARNESS itself errors — never because a model
 * scored poorly (that's the signal we're measuring).
 *
 * Run:
 *   npm run eval                       # triage tier, default model
 *   npm run eval -- code-fix           # code-fix tier
 *   npm run eval -- triage code-fix    # both
 *   EVAL_MODELS="openai/gpt-5.5,openai/gpt-5.4-mini" npm run eval
 *
 * The deterministic, AI-free plumbing is covered separately by
 * `evals/mechanism.test.ts` in the normal `npm test` suite.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv, hasProviderKey, evalModels } from "./env.js";
import { runInstance } from "./run-instance.js";
import { summarize, renderTable, writeArtifacts } from "./report.js";
import type { SweBenchInstance, InstanceResult } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Tier {
  name: string;
  defaultWorkflow: string;
}
const TIERS: Record<string, Tier> = {
  triage: { name: "triage", defaultWorkflow: "issue-triage" },
  "code-fix": { name: "code-fix", defaultWorkflow: "build" },
};

function loadInstances(tier: string): SweBenchInstance[] {
  const file = join(HERE, "datasets", tier, "instances.json");
  if (!existsSync(file)) return [];
  const all = JSON.parse(readFileSync(file, "utf8")) as SweBenchInstance[];
  // Optional substring filter for focused debugging: EVAL_INSTANCE=off-by-one
  const filter = process.env.EVAL_INSTANCE?.trim();
  return filter ? all.filter((i) => i.instance_id.includes(filter)) : all;
}

async function main(): Promise<number> {
  loadDotEnv();
  if (!hasProviderKey()) {
    console.error(
      "No provider key found. Set OPENAI_API_KEY (or ANTHROPIC_API_KEY / OPENROUTER_API_KEY)\n" +
        "in your environment or .env, then re-run `npm run eval`.",
    );
    return 1;
  }

  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const tiers = (requested.length ? requested : ["triage"]).filter((t) => {
    if (!TIERS[t]) {
      console.error(`Unknown tier "${t}". Known: ${Object.keys(TIERS).join(", ")}`);
      return false;
    }
    return true;
  });
  const models = evalModels();

  console.log(`Models: ${models.join(", ")}`);
  console.log(`Tiers:  ${tiers.join(", ")}\n`);

  const all: InstanceResult[] = [];
  let harnessErrors = 0;

  for (const tierName of tiers) {
    const tier = TIERS[tierName];
    const datasetDir = join(HERE, "datasets", tierName);
    const instances = loadInstances(tierName);
    if (!instances.length) {
      console.log(`(tier "${tierName}": no instances at ${datasetDir} — skipping)\n`);
      continue;
    }
    for (const model of models) {
      for (const inst of instances) {
        process.stdout.write(`▶ [${model}] ${tierName}/${inst.instance_id} … `);
        const result = await runInstance(inst, {
          model,
          datasetDir,
          defaultWorkflow: tier.defaultWorkflow,
        });
        all.push(result);

        if (result.error) {
          harnessErrors++;
          console.log(`HARNESS ERROR: ${result.error}`);
          continue;
        }
        const exec = result.resolved !== undefined ? (result.resolved ? "resolved" : "unresolved") : "";
        const beh = result.behavioral ? (result.behavioral.ok ? "behavioral✓" : "behavioral✗") : "";
        const cost = result.costUsd ? `$${result.costUsd.toFixed(4)}` : "";
        console.log([exec, beh, cost].filter(Boolean).join("  "));
      }
    }
  }

  if (!all.length) {
    console.error("\nNothing ran — no datasets matched the requested tiers.");
    return 1;
  }

  const card = summarize(all);
  const resultsDir = join(HERE, "results", tiers.join("+"));
  writeArtifacts(resultsDir, card);
  console.log("\n" + renderTable(card) + "\n");
  console.log(`Artifacts: ${resultsDir}/{scorecard.json,predictions.jsonl}`);

  // Non-zero ONLY on harness failure — model quality is the measurement.
  return harnessErrors > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
