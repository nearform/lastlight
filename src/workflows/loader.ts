import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve, basename } from "path";
import { parse as parseYaml } from "yaml";
import {
  AgentWorkflowSchema,
  CronWorkflowSchema,
  phaseSkillNames,
  type AgentWorkflowDefinition,
  type CronWorkflowDefinition,
} from "./schema.js";
import type { DisabledConfig, RouteConfig } from "../config.js";

interface AssetLayer {
  name: "built-in" | "overlay" | "legacy";
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

const agentCache = new Map<string, AgentWorkflowDefinition>();
const cronCache = new Map<string, CronWorkflowDefinition>();
const agentOrigins = new Map<string, WorkflowOrigin>();
const cronOrigins = new Map<string, WorkflowOrigin>();
let cachePopulated = false;

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

function makeLayer(name: AssetLayer["name"], rootOrWorkflowDir: string): AssetLayer {
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
  clearWorkflowCache();
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
  clearWorkflowCache();
}

export function clearWorkflowCache(): void {
  agentCache.clear();
  cronCache.clear();
  agentOrigins.clear();
  cronOrigins.clear();
  cachePopulated = false;
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

export function loadPromptTemplate(relativePath: string): string {
  const filePath = resolvePromptPath(relativePath);
  return readFileSync(filePath, "utf-8");
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

export function resolvePromptPath(relativePath: string): string {
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

export function loadSkillRaw(name: string): string {
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

export function loadSkillInstructions(name: string): string {
  return loadSkillRaw(name);
}

/**
 * Resolve a list of skill names to their absolute directory paths.
 * Each returned path is the skill folder root (containing `SKILL.md`
 * plus any `scripts/`, `references/`, `assets/`) — not the .md file.
 * The sandbox staging step in agent-executor uses these to symlink or
 * bind-mount the whole folder into `<workspace>/.agents/skills/<name>/`.
 * Layer-aware: overlay skills win over built-ins (same precedence and
 * disabled-skill handling as `loadSkillRaw`).
 */
export function resolveSkillPaths(names: readonly string[]): string[] {
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
export function loadAgentContext(): string {
  const files = new Map<string, string>();
  for (const layer of layers) {
    if (!existingDir(layer.agentContextRoot)) continue;
    for (const f of readdirSync(layer.agentContextRoot).filter((n) => n.endsWith(".md")).sort()) {
      files.set(f, join(layer.agentContextRoot, f));
    }
  }
  const disabledNames = new Set(disabled.agentContext.flatMap((n) => [n, n.endsWith(".md") ? n.slice(0, -3) : `${n}.md`]));
  return Array.from(files.entries())
    .filter(([name]) => !disabledNames.has(name) && !disabledNames.has(name.slice(0, -3)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, filePath]) => readFileSync(filePath, "utf-8"))
    .join("\n\n---\n\n");
}

const INTERNAL_ROUTE_TARGETS: Record<string, ReadonlySet<string>> = {
  "github.approval_response": new Set(["approval-response"]),
  "github.issue_build": new Set(["github-orchestrator"]),
  "github.explore_reply": new Set(["explore-reply"]),
  "slack.approve": new Set(["approval-response"]),
  "slack.reject": new Set(["approval-response"]),
  "slack.reset": new Set(["chat-reset"]),
  "slack.status": new Set(["status-report"]),
  "slack.build": new Set(["github-orchestrator"]),
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
