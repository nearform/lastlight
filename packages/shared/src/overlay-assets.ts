/**
 * Enumerate the assets a deployment overlay overrides or adds.
 *
 * The instance overlay (`$LASTLIGHT_OVERLAY_DIR`, prod `instance/`) can replace
 * or add workflows, prompts, skills, and agent-context files by logical name —
 * the layer-aware resolution lives in `src/workflows/loader.ts`. This module is
 * the read-only inverse: given the built-in (`coreRoot`) and overlay
 * (`overlayRoot`) trees, list every asset the overlay provides and whether it
 * **shadows** a same-named built-in or is a fresh **addition**.
 *
 * It's a pure filesystem walk (no loader caches), so the host-local CLI
 * (`lastlight server status`, `lastlight fork`) and the in-harness admin API
 * (`GET /admin/api/overrides`) can share one source of truth.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type OverlayAssetType = "workflow" | "cron" | "prompt" | "skill" | "agent-context";

export interface OverlayAsset {
  type: OverlayAssetType;
  /** Logical name — workflow/cron/skill name, or the filename for prompts/context. */
  name: string;
  /** True when a same-named built-in exists under `coreRoot` (overlay shadows it);
   *  false when the overlay adds something the built-ins don't have. */
  shadowsDefault: boolean;
}

export interface EnumerateOpts {
  /** Built-in asset tree (the lastlight checkout root). */
  coreRoot?: string;
  /** Overlay asset tree (the instance/ overlay root). */
  overlayRoot?: string;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir).filter(predicate).sort();
}

function listDirs(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((n) => isDir(join(dir, n)))
    .sort();
}

const isYaml = (n: string): boolean => n.endsWith(".yaml") || n.endsWith(".yml");
const isMarkdown = (n: string): boolean => n.endsWith(".md");

/** Read a workflow YAML's `name`/`kind` without throwing on malformed files. */
function readWorkflowMeta(filePath: string): { name: string; kind: string } | null {
  try {
    const raw = parseYaml(readFileSync(filePath, "utf-8")) as Record<string, unknown> | null;
    if (!raw || typeof raw.name !== "string") return null;
    return { name: raw.name, kind: typeof raw.kind === "string" ? raw.kind : "" };
  } catch {
    return null;
  }
}

/**
 * Index built-in assets by logical name so overlay entries can be tagged as
 * shadowing vs adding. Workflows/crons are keyed by their YAML `name`; prompts,
 * skills, and agent-context by filename / directory name.
 */
function indexBuiltins(coreRoot: string) {
  const workflows = new Set<string>();
  const crons = new Set<string>();
  const workflowDir = join(coreRoot, "workflows");
  for (const file of listFiles(workflowDir, isYaml)) {
    const meta = readWorkflowMeta(join(workflowDir, file));
    if (!meta) continue;
    (meta.kind === "cron" ? crons : workflows).add(meta.name);
  }
  return {
    workflows,
    crons,
    prompts: new Set(listFiles(join(coreRoot, "workflows", "prompts"), isMarkdown)),
    skills: new Set(listDirs(join(coreRoot, "skills"))),
    agentContext: new Set(listFiles(join(coreRoot, "agent-context"), isMarkdown)),
  };
}

/**
 * List every asset the overlay provides, tagging each as shadowing a built-in or
 * a fresh addition. Returns `[]` when no overlay is configured or present.
 */
export function enumerateOverlayAssets(opts: EnumerateOpts): OverlayAsset[] {
  const { coreRoot, overlayRoot } = opts;
  if (!overlayRoot || !isDir(overlayRoot)) return [];
  const builtins = coreRoot && isDir(coreRoot)
    ? indexBuiltins(coreRoot)
    : { workflows: new Set<string>(), crons: new Set<string>(), prompts: new Set<string>(), skills: new Set<string>(), agentContext: new Set<string>() };

  const assets: OverlayAsset[] = [];

  // Workflows + crons — keyed by YAML `name`, split by `kind`.
  const overlayWorkflowDir = join(overlayRoot, "workflows");
  for (const file of listFiles(overlayWorkflowDir, isYaml)) {
    const meta = readWorkflowMeta(join(overlayWorkflowDir, file));
    if (!meta) continue;
    const isCron = meta.kind === "cron";
    assets.push({
      type: isCron ? "cron" : "workflow",
      name: meta.name,
      shadowsDefault: (isCron ? builtins.crons : builtins.workflows).has(meta.name),
    });
  }

  // Prompts — keyed by filename under workflows/prompts/.
  for (const file of listFiles(join(overlayRoot, "workflows", "prompts"), isMarkdown)) {
    assets.push({ type: "prompt", name: file, shadowsDefault: builtins.prompts.has(file) });
  }

  // Skills — keyed by directory name under skills/.
  for (const dir of listDirs(join(overlayRoot, "skills"))) {
    assets.push({ type: "skill", name: dir, shadowsDefault: builtins.skills.has(dir) });
  }

  // Agent-context — keyed by filename under agent-context/.
  for (const file of listFiles(join(overlayRoot, "agent-context"), isMarkdown)) {
    assets.push({ type: "agent-context", name: file, shadowsDefault: builtins.agentContext.has(file) });
  }

  return assets;
}
