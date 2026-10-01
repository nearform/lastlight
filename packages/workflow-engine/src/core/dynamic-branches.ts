/**
 * Dynamic fan-out branches — `type: fanout` with `branches_from:` + `branch:`.
 *
 * A static fan-out declares its branch list in YAML. Some fan-outs cannot know
 * theirs until run time: pr-review's `site-review` runs one reviewer per site
 * that `site-plan` formed, and only `site-plan` knows how many that is. Before
 * this existed the workflow declared sixteen slots and code-facts filled the
 * unused ones with pre-satisfied `empty` lines — sixteen YAML blocks, a slot
 * arithmetic for the pair model, and a dashboard full of "done in 0s" cards.
 *
 * Instead, an earlier phase writes a manifest into the workspace and the
 * fan-out handler resolves it here, just before any branch starts. Everything
 * downstream of the resolved `FanoutBranch[]` (pre-gate, pool, gates, regate,
 * reporting, the per-branch ledger rows that give resume) is unchanged.
 *
 * Pure: no IO. The handler reads the file; evals and tests can call this
 * directly with a parsed manifest.
 */
import type { FanoutBranch, FanoutBranchTemplate, PhaseDefinition } from "./schema.js";
import { branchNameError } from "./schema.js";
import { renderTemplate, type TemplateContext } from "./templates.js";

/** One manifest entry: an `id` plus any free scalar vars, exposed as `{{item.*}}`. */
export type BranchManifestItem = Record<string, string | number | boolean>;

export interface BranchManifest {
  items: BranchManifestItem[];
}

export interface ResolvedDynamicBranches {
  branches: FanoutBranch[];
  /** How many manifest items were dropped for exceeding `branches_from.max`. */
  truncated: number;
}

/**
 * Item STRING values are rendered into `until_bash`, i.e. into a shell command,
 * and the manifest lives in a workspace the agent can write. So a value must be
 * inert in shell: path-ish characters only. Anything richer belongs in the
 * branch's `context_file`, which is read as bytes and never executed.
 */
const SAFE_ITEM_VALUE = /^[A-Za-z0-9._/-]*$/;

/** Parse and validate a manifest's JSON. Throws a message naming what is wrong. */
export function parseBranchManifest(raw: string): BranchManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`branch manifest is not valid JSON: ${(err as Error).message}`);
  }
  if (!json || typeof json !== "object" || !Array.isArray((json as { items?: unknown }).items)) {
    throw new Error('branch manifest must be an object of the form { "items": [ … ] }');
  }
  const items = (json as { items: unknown[] }).items;
  items.forEach((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`branch manifest items[${i}] must be an object`);
    }
    for (const [key, value] of Object.entries(item)) {
      if (!/^[\w-]+$/.test(key)) {
        throw new Error(`branch manifest items[${i}] has an invalid key ${JSON.stringify(key)}`);
      }
      if (typeof value === "string") {
        if (!SAFE_ITEM_VALUE.test(value)) {
          throw new Error(`branch manifest items[${i}].${key} = ${JSON.stringify(value)} has characters outside [A-Za-z0-9._/-]`);
        }
      } else if (typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`branch manifest items[${i}].${key} must be a string, number or boolean`);
      }
    }
  });
  return { items: items as BranchManifestItem[] };
}

/** Render one template field; an empty render means "not set" (inherit the phase's). */
function field(t: string | undefined, ctx: TemplateContext): string | undefined {
  if (t === undefined) return undefined;
  const out = renderTemplate(t, ctx).trim();
  return out === "" ? undefined : out;
}

/**
 * Render `phase.branch` once per manifest item, capped at `branches_from.max`.
 *
 * Every string field sees `{ ...ctx, item }`, so `model:` can combine run config
 * with item vars (`{{#if item.pair}}{{models.review-site-pair}}{{/if}}`), EXCEPT
 * `until_bash`, which sees ONLY `{ item }` — the schema already restricts its
 * placeholders to `{{item.*}}`, and rendering it against the run context would
 * put issue titles and comment bodies into a shell command.
 *
 * Throws on an invalid or duplicate rendered name: a manifest that cannot name
 * its branches is a producer bug, and running the fan-out anyway would key
 * ledger rows the resume path cannot parse back.
 */
export function resolveDynamicBranches(
  phase: Pick<PhaseDefinition, "name" | "branches_from" | "branch">,
  manifest: BranchManifest,
  ctx: TemplateContext,
): ResolvedDynamicBranches {
  const tpl: FanoutBranchTemplate | undefined = phase.branch;
  const max = phase.branches_from?.max;
  if (!tpl || max === undefined) {
    throw new Error(`${phase.name}: resolveDynamicBranches needs \`branches_from:\` and \`branch:\``);
  }
  const kept = manifest.items.slice(0, max);
  const seen = new Set<string>();
  const branches = kept.map((item, i): FanoutBranch => {
    const itemCtx = { ...ctx, item } as TemplateContext;
    const name = renderTemplate(tpl.name, itemCtx).trim();
    const err = branchNameError(name);
    if (err) throw new Error(`${phase.name}: manifest item ${i} renders branch name ${JSON.stringify(name)} — ${err}`);
    if (seen.has(name)) throw new Error(`${phase.name}: manifest renders branch name ${JSON.stringify(name)} twice (names are ledger keys)`);
    seen.add(name);

    const branch: FanoutBranch = { name };
    const prompt = field(tpl.prompt, itemCtx);
    if (prompt) branch.prompt = prompt;
    const skill = field(tpl.skill, itemCtx);
    if (skill) branch.skill = skill;
    if (tpl.skills) branch.skills = tpl.skills.map((s) => renderTemplate(s, itemCtx).trim()).filter(Boolean);
    const model = field(tpl.model, itemCtx);
    if (model) branch.model = model;
    const variant = field(tpl.variant, itemCtx);
    if (variant) branch.variant = variant;
    const contextFile = field(tpl.context_file, itemCtx);
    if (contextFile) branch.context_file = contextFile;
    const untilBash = field(tpl.until_bash, { item } as unknown as TemplateContext);
    if (untilBash) branch.until_bash = untilBash;
    if (tpl.command_policy) branch.command_policy = tpl.command_policy;
    if (tpl.timeout_seconds !== undefined) branch.timeout_seconds = tpl.timeout_seconds;
    return branch;
  });
  return { branches, truncated: manifest.items.length - kept.length };
}
