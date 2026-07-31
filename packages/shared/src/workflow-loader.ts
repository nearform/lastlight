import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve, basename } from "path";
import { parse as parseYaml } from "yaml";
import {
  AgentWorkflowSchema,
  CronWorkflowSchema,
  phaseSkillNames,
  intentToken,
  RESERVED_CONTROL_INTENTS,
  type AgentWorkflowDefinition,
  type CronWorkflowDefinition,
} from "lastlight-workflow-engine";
import type { DisabledConfig, RouteConfig } from "./config-types.js";

/**
 * One root that can contribute assets. The ordered stack is resolved
 * last-wins for prompts/skills and (by basename) for agent-context.
 *
 * `repo` is the odd one out: a PER-RUN layer rooted at a managed repo's own
 * `.lastlight/` directory. It is never installed into the module-level `layers`
 * stack — it's handed to `createAssetResolver()` for the duration of a single
 * run — because up to `concurrency.maxWorkflows` runs (plus a cron fan-out
 * across every managed repo) are in flight at once and a global would race.
 * It is also asset-only: `populateCache()` refuses to read workflow/cron YAML
 * from it (a repo may not define workflows).
 */
export interface AssetLayer {
  name: "built-in" | "overlay" | "legacy" | "repo";
  root: string;
  workflowRoot: string;
  skillRoot: string;
  claudeSkillRoot?: string;
  agentContextRoot: string;
}

export interface WorkflowAssetConfig {
  builtInRoot?: string;
  overlayRoot?: string;
  disabled?: Partial<DisabledConfig>;
}

export interface WorkflowOrigin {
  layer: string;
  filePath: string;
}

const DEFAULT_ROOT = resolve(".");
let layers: AssetLayer[] = [makeLayer("built-in", DEFAULT_ROOT)];
let disabled: DisabledConfig = emptyDisabled();

/**
 * The resolver every module-level asset export delegates to. Rebuilt (never
 * mutated) whenever `layers`/`disabled` change, so the exported facade behaves
 * exactly as it did when those functions read the globals directly.
 */
let defaultResolver: AssetResolver = createAssetResolver(layers, disabled);

const agentCache = new Map<string, AgentWorkflowDefinition>();
const cronCache = new Map<string, CronWorkflowDefinition>();
const agentOrigins = new Map<string, WorkflowOrigin>();
const cronOrigins = new Map<string, WorkflowOrigin>();
let cachePopulated = false;

/**
 * Bumped every time the asset layers change (reconfigure / cache clear). Lets
 * downstream consumers that derive state from the workflow set — notably the
 * classifier's composed prompt + intent vocabulary — cheaply detect staleness
 * without a cross-layer import or a callback registry. Read via `getAssetVersion()`.
 */
let assetVersion = 0;

function emptyDisabled(): DisabledConfig {
  return { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] };
}

function mergeDisabled(value?: Partial<DisabledConfig>): DisabledConfig {
  return {
    workflows: value?.workflows ?? [],
    crons: value?.crons ?? [],
    prompts: value?.prompts ?? [],
    skills: value?.skills ?? [],
    agentContext: value?.agentContext ?? [],
  };
}

function existingDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build a layer from a root directory. Deliberately shape-identical for every
 * layer name, including `repo`: a managed repo's `.lastlight/` mirrors the
 * overlay's on-disk layout exactly (`workflows/prompts/x.md`, `skills/<n>/SKILL.md`,
 * `agent-context/*.md`), so there is one shape to learn and `lastlight fork`
 * output drops straight into a repo. Only `claudeSkillRoot` differs — the
 * `.claude/skills` fallback is a built-in/legacy convenience, not an overlay or
 * repo surface.
 */
export function makeLayer(name: AssetLayer["name"], rootOrWorkflowDir: string): AssetLayer {
  const root = resolve(rootOrWorkflowDir);
  const workflowRoot = join(root, "workflows");
  return {
    name,
    root,
    workflowRoot,
    skillRoot: join(root, "skills"),
    claudeSkillRoot: name === "built-in" || name === "legacy" ? join(root, ".claude/skills") : undefined,
    agentContextRoot: join(root, "agent-context"),
  };
}

/** Configure ordered asset layers. Built-ins load first; overlay wins by logical name. */
export function configureWorkflowAssets(config: WorkflowAssetConfig = {}): void {
  const builtInRoot = resolve(config.builtInRoot || DEFAULT_ROOT);
  const next = [makeLayer("built-in", builtInRoot)];
  if (config.overlayRoot) next.push(makeLayer("overlay", config.overlayRoot));
  layers = next;
  disabled = mergeDisabled(config.disabled);
  defaultResolver = createAssetResolver(layers, disabled);
  clearWorkflowCache();
}

/**
 * The layer stack + disables the module-level facade currently resolves
 * against. Exposed so a caller can compose a per-run resolver on top of them
 * without reaching for the globals or re-deriving the built-in/overlay roots:
 *
 *   createAssetResolver(
 *     [...getAssetLayers(), makeLayer("repo", join(repoRoot, ".lastlight"))],
 *     getDisabledAssets(),
 *     { agentContextAdditiveOnly: true },
 *   )
 */
export function getAssetLayers(): readonly AssetLayer[] {
  return layers;
}

/** Copy of the effective disables (see `getAssetLayers`); safe to hand out. */
export function getDisabledAssets(): DisabledConfig {
  return {
    workflows: [...disabled.workflows],
    crons: [...disabled.crons],
    prompts: [...disabled.prompts],
    skills: [...disabled.skills],
    agentContext: [...disabled.agentContext],
  };
}

/** Legacy wrapper used by older tests to point directly at a workflow directory. */
export function setWorkflowDir(dir: string): void {
  const workflowRoot = resolve(dir);
  layers = [{
    name: "legacy",
    root: resolve("."),
    workflowRoot,
    skillRoot: resolve("skills"),
    claudeSkillRoot: resolve(".claude/skills"),
    agentContextRoot: resolve("agent-context"),
  }];
  disabled = emptyDisabled();
  defaultResolver = createAssetResolver(layers, disabled);
  clearWorkflowCache();
}

export function clearWorkflowCache(): void {
  agentCache.clear();
  cronCache.clear();
  agentOrigins.clear();
  cronOrigins.clear();
  cachePopulated = false;
  assetVersion++;
}

/** Monotonic counter bumped on every asset-layer reconfigure / cache clear. */
export function getAssetVersion(): number {
  return assetVersion;
}

function loadYamlFile(filePath: string): unknown {
  if (!existsSync(filePath)) throw new Error(`Workflow file not found: ${filePath}`);
  const raw = readFileSync(filePath, "utf-8");
  try {
    return parseYaml(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML in ${filePath}: ${msg}`);
  }
}

function workflowFiles(dir: string): string[] {
  if (!existingDir(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
}

function populateCache(): void {
  if (cachePopulated) return;
  cachePopulated = true;

  for (const layer of layers) {
    // A repo layer contributes ASSETS ONLY — a managed repo may never define a
    // workflow or a cron (that would let any repo we watch schedule arbitrary
    // agent runs on the operator's instance). Repo layers are only ever passed
    // to `createAssetResolver`, never into this global stack, but the guard
    // makes the invariant structural instead of merely conventional.
    if (layer.name === "repo") continue;
    const namesInLayer = new Set<string>();
    const cronNamesInLayer = new Set<string>();
    for (const file of workflowFiles(layer.workflowRoot)) {
      const filePath = join(layer.workflowRoot, file);
      const raw = loadYamlFile(filePath);
      const kind = (raw as Record<string, unknown>)?.kind;

      if (kind === "cron") {
        const result = CronWorkflowSchema.safeParse(raw);
        if (!result.success) {
          throw new Error(`Invalid cron workflow in ${filePath}: ${JSON.stringify(result.error.format())}`);
        }
        if (cronNamesInLayer.has(result.data.name)) {
          throw new Error(`Duplicate cron workflow name "${result.data.name}" in ${layer.name} layer`);
        }
        cronNamesInLayer.add(result.data.name);
        if (!disabled.crons.includes(result.data.name) && !disabled.workflows.includes(result.data.workflow)) {
          cronCache.set(result.data.name, result.data);
          cronOrigins.set(result.data.name, { layer: layer.name, filePath });
        }
      } else {
        const result = AgentWorkflowSchema.safeParse(raw);
        if (!result.success) {
          throw new Error(`Invalid workflow in ${filePath}: ${JSON.stringify(result.error.format())}`);
        }
        if (namesInLayer.has(result.data.name)) {
          throw new Error(`Duplicate workflow name "${result.data.name}" in ${layer.name} layer`);
        }
        namesInLayer.add(result.data.name);
        if (!disabled.workflows.includes(result.data.name)) {
          agentCache.set(result.data.name, result.data);
          agentOrigins.set(result.data.name, { layer: layer.name, filePath });
        } else {
          agentCache.delete(result.data.name);
          agentOrigins.delete(result.data.name);
        }
      }
    }
  }
}

export function getWorkflow(name: string): AgentWorkflowDefinition {
  populateCache();
  if (disabled.workflows.includes(name)) throw new Error(`Workflow is disabled: "${name}"`);
  const cached = agentCache.get(name);
  if (cached) return cached;
  throw new Error(`Workflow not found: "${name}" (looked in ${layers.map((l) => l.workflowRoot).join(", ")})`);
}

export function getCronWorkflows(): CronWorkflowDefinition[] {
  populateCache();
  return Array.from(cronCache.values());
}

export function listAgentWorkflows(): AgentWorkflowDefinition[] {
  populateCache();
  return Array.from(agentCache.values());
}

/**
 * The enabled workflow that claims a given classifier intent via its
 * `classification.intent`, if any. Backs the router's data-driven fallback: an
 * intent the router's bespoke switch doesn't handle routes to its owning
 * workflow. Returns undefined for control intents and unclaimed tokens.
 */
export function getWorkflowByIntent(intent: string): AgentWorkflowDefinition | undefined {
  populateCache();
  for (const def of agentCache.values()) {
    if (def.classification?.intent === intent) return def;
  }
  return undefined;
}

export function getWorkflowOrigin(name: string): WorkflowOrigin | undefined {
  populateCache();
  return agentOrigins.get(name);
}

export function getCronWorkflowOrigin(name: string): WorkflowOrigin | undefined {
  populateCache();
  return cronOrigins.get(name);
}

export function loadWorkflowYamlRaw(name: string): string {
  populateCache();
  if (disabled.workflows.includes(name)) throw new Error(`Workflow is disabled: "${name}"`);
  const origin = agentOrigins.get(name);
  if (!origin) throw new Error(`Workflow file not found for logical name: ${name}`);
  return readFileSync(origin.filePath, "utf-8");
}

function assertSafeRelative(relativePath: string, kind: string): void {
  if (!relativePath || relativePath.length === 0) throw new Error(`${kind} path is empty`);
  if (relativePath.startsWith("/") || relativePath.includes("\0")) {
    throw new Error(`${kind} path is invalid: ${relativePath}`);
  }
}

function isInside(filePath: string, root: string): boolean {
  const r = resolve(root);
  const f = resolve(filePath);
  return f === r || f.startsWith(r + "/");
}

/**
 * A non-fatal thing the resolver noticed while loading assets. Today the only
 * kind is an agent-context file a repo layer wasn't allowed to override
 * (see `agentContextAdditiveOnly`) — surfaced rather than thrown because the
 * run should still proceed, just with the operator's file winning. Callers are
 * expected to log it / echo it back to the repo so the drop isn't silent.
 */
export interface AssetWarning {
  kind: "agent-context-dropped";
  /** Basename of the dropped file, e.g. `security.md`. */
  name: string;
  /** Absolute path of the file that was ignored. */
  filePath: string;
  /** The layer the ignored file came from. */
  layer: AssetLayer["name"];
  /** One-liner, safe to put in a log line or a PR comment. */
  message: string;
}

export interface AssetResolverOptions {
  /**
   * When true, a layer named `repo` may only ADD agent-context files: one whose
   * basename an earlier (operator-owned) layer already provides is dropped
   * instead of replacing it, and recorded in `warnings`. Off by default so the
   * built-in → overlay stack keeps its normal last-wins behaviour.
   */
  agentContextAdditiveOnly?: boolean;
}

/**
 * The layer-dependent half of the loader, bound to one specific layer stack.
 *
 * Exists so a caller can resolve assets against `globals + one extra per-run
 * layer` WITHOUT installing that layer into the module-level stack: several
 * workflows run concurrently (and a cron fan-out fires across every managed
 * repo at once), so a mutated global would race between runs. The module-level
 * exports below are a thin facade over one of these built from the last
 * `configureWorkflowAssets` call.
 */
export interface AssetResolver {
  resolvePromptPath(relativePath: string): string;
  loadPromptTemplate(relativePath: string): string;
  loadSkillRaw(name: string): string;
  loadSkillInstructions(name: string): string;
  resolveSkillPaths(names: readonly string[]): string[];
  loadAgentContext(): string;
  /**
   * Warnings from the most recent `loadAgentContext()` call — a snapshot, not
   * an append-only log, so repeated loads can't grow it unboundedly. Empty
   * until `loadAgentContext()` has run at least once.
   */
  readonly warnings: readonly AssetWarning[];
}

/**
 * Build a resolver over an explicit layer stack. See `getAssetLayers()` for the
 * composition idiom. The `layers`/`disabled` parameters deliberately shadow the
 * module-level globals of the same name: everything inside this closure reads
 * the captured stack, and the shadowing makes it impossible for a body in here
 * to reach the globals by accident.
 */
export function createAssetResolver(
  layers: readonly AssetLayer[],
  disabled: DisabledConfig,
  options: AssetResolverOptions = {},
): AssetResolver {
  const additiveOnly = options.agentContextAdditiveOnly === true;
  let warnings: AssetWarning[] = [];

  function resolvePromptPath(relativePath: string): string {
    assertSafeRelative(relativePath, "Prompt");
    if (disabled.prompts.includes(relativePath) || disabled.prompts.includes(basename(relativePath))) {
      throw new Error(`Prompt template is disabled: ${relativePath}`);
    }
    for (const layer of [...layers].reverse()) {
      const filePath = resolve(layer.workflowRoot, relativePath);
      if (!isInside(filePath, layer.workflowRoot)) throw new Error(`Prompt path escapes workflow directory: ${relativePath}`);
      if (existsSync(filePath)) return filePath;
    }
    throw new Error(`Prompt template not found: ${relativePath}`);
  }

  function loadPromptTemplate(relativePath: string): string {
    const filePath = resolvePromptPath(relativePath);
    return readFileSync(filePath, "utf-8");
  }

  function loadSkillRaw(name: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
    if (disabled.skills.includes(name)) throw new Error(`Skill is disabled: ${name}`);
    for (const layer of [...layers].reverse()) {
      const bases = [layer.skillRoot, layer.claudeSkillRoot].filter(Boolean) as string[];
      for (const base of bases) {
        const filePath = join(base, name, "SKILL.md");
        if (!isInside(filePath, base)) throw new Error(`Skill path escapes skill directory: ${name}`);
        if (existsSync(filePath)) return readFileSync(filePath, "utf-8");
      }
    }
    throw new Error(`Skill not found: skills/${name}/SKILL.md`);
  }

  function loadSkillInstructions(name: string): string {
    return loadSkillRaw(name);
  }

  /**
   * Resolve a list of skill names to their absolute directory paths.
   * Each returned path is the skill folder root (containing `SKILL.md`
   * plus any `scripts/`, `references/`, `assets/`) — not the .md file.
   * The sandbox staging step in agent-executor uses these to symlink or
   * copy the whole folder into the phase's bundle at
   * `<workspaceRoot>/.lastlight-skills/<phase>/<name>/`.
   * Layer-aware: later layers win over earlier ones (same precedence and
   * disabled-skill handling as `loadSkillRaw`).
   */
  function resolveSkillPaths(names: readonly string[]): string[] {
    return names.map((name) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error(`Invalid skill name: ${name}`);
      }
      if (disabled.skills.includes(name)) {
        throw new Error(`Skill is disabled: ${name}`);
      }
      for (const layer of [...layers].reverse()) {
        const bases = [layer.skillRoot, layer.claudeSkillRoot].filter(Boolean) as string[];
        for (const base of bases) {
          const dir = join(base, name);
          const skillFile = join(dir, "SKILL.md");
          if (!isInside(skillFile, base)) throw new Error(`Skill path escapes skill directory: ${name}`);
          if (existsSync(skillFile)) return dir;
        }
      }
      throw new Error(`Skill not found: skills/${name}/SKILL.md`);
    });
  }

  /**
   * Concatenate resolved agent-context/*.md with overlay filename replacement.
   * Later layers replace earlier files by basename; disabled.agentContext removes
   * either exact filenames (rules.md) or stem names (rules).
   */
  function loadAgentContext(): string {
    const files = new Map<string, string>();
    const drops: AssetWarning[] = [];
    for (const layer of layers) {
      if (!existingDir(layer.agentContextRoot)) continue;
      for (const f of readdirSync(layer.agentContextRoot).filter((n) => n.endsWith(".md")).sort()) {
        const filePath = join(layer.agentContextRoot, f);
        // Additive-only: a managed repo may ADD context, never REPLACE what an
        // operator-owned layer already provides — otherwise committing a file
        // called `security.md` / `rules.md` would neuter the operator's rules
        // for every run against that repo. Non-repo layers keep last-wins.
        if (additiveOnly && layer.name === "repo" && files.has(f)) {
          drops.push({
            kind: "agent-context-dropped",
            name: f,
            filePath,
            layer: layer.name,
            message: `Ignored repo agent-context file "${f}": a higher-trust layer already provides it (repo context is additive only).`,
          });
          continue;
        }
        files.set(f, filePath);
      }
    }
    const disabledNames = new Set(disabled.agentContext.flatMap((n) => [n, n.endsWith(".md") ? n.slice(0, -3) : `${n}.md`]));
    // Recomputed per call (not appended) — `warnings` is a snapshot of the last
    // load. A drop of a name that's disabled anyway isn't worth reporting.
    warnings = drops.filter(({ name }) => !disabledNames.has(name) && !disabledNames.has(name.slice(0, -3)));
    return Array.from(files.entries())
      .filter(([name]) => !disabledNames.has(name) && !disabledNames.has(name.slice(0, -3)))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, filePath]) => readFileSync(filePath, "utf-8"))
      .join("\n\n---\n\n");
  }

  return {
    resolvePromptPath,
    loadPromptTemplate,
    loadSkillRaw,
    loadSkillInstructions,
    resolveSkillPaths,
    loadAgentContext,
    // A getter, not a captured array: `loadAgentContext` REPLACES the list each
    // call, so a snapshot property would go stale after the first load.
    get warnings(): readonly AssetWarning[] {
      return warnings;
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level asset facade. Thin delegations to the default resolver — kept so
// every existing call site (runner, classifier, chat-skills, admin routes,
// profiles, the CLI's `fork`, the evals bootstrap) is unchanged by the
// introduction of per-run resolvers.
// ---------------------------------------------------------------------------

export function resolvePromptPath(relativePath: string): string {
  return defaultResolver.resolvePromptPath(relativePath);
}

export function loadPromptTemplate(relativePath: string): string {
  return defaultResolver.loadPromptTemplate(relativePath);
}

export function loadSkillRaw(name: string): string {
  return defaultResolver.loadSkillRaw(name);
}

export function loadSkillInstructions(name: string): string {
  return defaultResolver.loadSkillInstructions(name);
}

export function resolveSkillPaths(names: readonly string[]): string[] {
  return defaultResolver.resolveSkillPaths(names);
}

export function loadAgentContext(): string {
  return defaultResolver.loadAgentContext();
}

// Route targets that are IN-PROCESS handlers, not workflow YAML files — so
// they're allowed even though `agentCache` (which only holds workflows) can't
// vouch for them. `build` is deliberately absent: it's a real workflow
// (`build.yaml`), validated the normal way via the cache.
const INTERNAL_ROUTE_TARGETS: Record<string, ReadonlySet<string>> = {
  "github.approval_response": new Set(["approval-response"]),
  "github.explore_reply": new Set(["explore-reply"]),
  "slack.approve": new Set(["approval-response"]),
  "slack.reject": new Set(["approval-response"]),
  "slack.reset": new Set(["chat-reset"]),
  "slack.status": new Set(["status-report"]),
  "slack.chat": new Set(["chat"]),
  "slack.explore_reply": new Set(["explore-reply"]),
};

function validateRouteTargets(routes?: RouteConfig): void {
  if (!routes) return;
  for (const [surface, values] of Object.entries(routes) as Array<[keyof RouteConfig, Record<string, string>]>) {
    for (const [routeName, target] of Object.entries(values)) {
      const routeKey = `${surface}.${routeName}`;
      if (target.includes("/") || target.includes("..")) throw new Error(`Unsafe route target for ${routeKey}: ${target}`);
      if (INTERNAL_ROUTE_TARGETS[routeKey]?.has(target)) continue;
      if (agentCache.has(target)) continue;
      if (disabled.workflows.includes(target)) {
        throw new Error(`Route ${routeKey} targets disabled workflow: ${target}`);
      }
      throw new Error(`Route ${routeKey} targets missing workflow or internal handler: ${target}`);
    }
  }
}

export function validateAssets(routes?: RouteConfig): void {
  populateCache();
  for (const route of ["workflows", "crons"] as const) {
    for (const name of disabled[route]) {
      if (name.includes("/") || name.includes("..")) throw new Error(`Unsafe disabled ${route} entry: ${name}`);
    }
  }

  // Every enabled cron must target a workflow that still exists (and isn't
  // disabled) — otherwise the cron boots fine and only fails on first tick.
  for (const [cronName, def] of cronCache) {
    if (!agentCache.has(def.workflow)) {
      throw new Error(`Cron "${cronName}" targets missing or disabled workflow: ${def.workflow}`);
    }
  }

  // Classifier `classification` blocks: each declared intent must be unique
  // across workflows (two owners would make routing/parsing ambiguous), must
  // not shadow a reserved control intent (approve/reject/status/reset/chat —
  // the harness owns those), and its derived prompt token must be collision-free
  // (e.g. `qa-test` and `qa_test` both → QATEST). A base classifier template
  // must also exist to compose into. This runs at boot so a bad overlay fails
  // fast instead of on the first classified event.
  const controlIntents = new Set<string>(RESERVED_CONTROL_INTENTS);
  const intentOwner = new Map<string, string>();
  const tokenOwner = new Map<string, string>();
  let anyClassification = false;
  for (const [wfName, def] of agentCache) {
    const c = def.classification;
    if (!c) continue;
    anyClassification = true;
    if (controlIntents.has(c.intent)) {
      throw new Error(
        `Workflow "${wfName}" classification.intent "${c.intent}" is a reserved control intent (${[...controlIntents].join(", ")})`,
      );
    }
    const prevIntent = intentOwner.get(c.intent);
    if (prevIntent) {
      throw new Error(
        `Workflows "${prevIntent}" and "${wfName}" both claim classifier intent "${c.intent}" — an intent must have exactly one owning workflow`,
      );
    }
    intentOwner.set(c.intent, wfName);
    const token = intentToken(c.intent);
    const prevToken = tokenOwner.get(token);
    if (prevToken) {
      throw new Error(
        `Workflows "${prevToken}" and "${wfName}" derive the same classifier token "${token}" from different intents — rename one classification.intent`,
      );
    }
    tokenOwner.set(token, wfName);
  }
  if (anyClassification) {
    try {
      resolvePromptPath("prompts/classifier.md");
    } catch (err: unknown) {
      throw new Error(`Classifier base template prompts/classifier.md: ${(err as Error).message}`);
    }
  }

  // Every enabled workflow's phase asset references (prompt templates and
  // skills) must resolve now — so a missing/disabled overlay asset fails at
  // startup instead of on the first event. Skip templated refs (containing
  // "{{"), which can only be resolved at render time.
  for (const [wfName, def] of agentCache) {
    for (const phase of def.phases) {
      const promptRefs = [
        phase.prompt,
        phase.loop?.on_request_changes.fix_prompt,
        phase.loop?.on_request_changes.re_review_prompt,
      ].filter((p): p is string => typeof p === "string" && p.length > 0 && !p.includes("{{"));
      for (const ref of promptRefs) {
        try {
          resolvePromptPath(ref);
        } catch (err: unknown) {
          throw new Error(`Workflow "${wfName}" phase "${phase.name}" prompt "${ref}": ${(err as Error).message}`);
        }
      }
      const skillNames = phaseSkillNames(phase).filter((n) => !n.includes("{{"));
      if (skillNames.length) {
        try {
          resolveSkillPaths(skillNames);
        } catch (err: unknown) {
          throw new Error(`Workflow "${wfName}" phase "${phase.name}" skills: ${(err as Error).message}`);
        }
      }
    }
  }

  validateRouteTargets(routes);
}
