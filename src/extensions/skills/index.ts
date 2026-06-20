/**
 * Skills resource entry point.
 *
 * Pi implements the Agent Skills standard (https://agentskills.io) natively:
 * a skill is a directory with a `SKILL.md` (frontmatter `name` + `description`
 * + instructions). Pi's resource loader discovers skills from default
 * locations (~/.pi/agent/skills, ~/.agents/skills, project .pi/skills,
 * .agents/skills, and package `skills/` dirs) and surfaces them to the agent
 * via progressive disclosure — only names/descriptions are always in context;
 * the agent `read`s the full SKILL.md on demand.
 *
 * Unlike `github`/`web-search`, skills are NOT `customTools`. They're a
 * Pi-native resource fed to `DefaultResourceLoader` via `additionalSkillPaths`
 * / `noSkills` (the same channel file-search uses for `additionalExtensionPaths`).
 * This module's only job is to normalize the operator's `--skill` paths
 * (tilde + relative → absolute, drop missing ones) so the runner can hand
 * them straight to the loader.
 *
 * Safe-by-default like every other extension: a path that doesn't exist is
 * dropped with a warning rather than aborting the run.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface SkillsConfig {
  /**
   * Extra skill paths from `--skill <path>` (repeatable). Each entry is a
   * directory of skills OR a single skill directory/file. Additive even when
   * `noSkills` is true.
   */
  skillPaths?: string[];
  /** When true, disable Pi's default skill discovery. Explicit paths still load. */
  noSkills?: boolean;
  /** Working directory, for resolving relative `--skill` paths. */
  cwd: string;
  /** Home directory for `~` expansion. Injectable for tests; default os.homedir(). */
  home?: string;
}

export interface SkillsResult {
  /**
   * - "default"    — no flags; rely on Pi's default discovery.
   * - "configured" — at least one explicit `--skill` path resolved.
   * - "disabled"   — `--no-skills` with no explicit paths that resolved.
   */
  status: "default" | "configured" | "disabled";
  /** Resolved, existence-checked absolute paths for `additionalSkillPaths`. */
  additionalSkillPaths: string[];
  /** Pass-through for `DefaultResourceLoader.noSkills`. */
  noSkills: boolean;
  /** Non-fatal issues (e.g. a `--skill` path that doesn't exist). */
  warnings: string[];
}

/** Expand a leading `~` and resolve to an absolute path against `cwd`. */
function resolveSkillPath(raw: string, cwd: string, home: string): string {
  let p = raw;
  if (p === "~") {
    p = home;
  } else if (p.startsWith("~/")) {
    p = resolve(home, p.slice(2));
  }
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** One discovered skill, flattened for the `skills_status` JSONL event. */
export interface SkillSummary {
  /** Skill name (from SKILL.md frontmatter). */
  name: string;
  /** Absolute path to the skill's SKILL.md. */
  source: string;
  /**
   * Whether the model can auto-invoke it. False when the skill set
   * `disable-model-invocation: true` (hidden from the system prompt) — worth
   * surfacing since such a skill is present but won't be picked up on its own.
   */
  modelInvocable: boolean;
}

export interface SkillsStatusEvent {
  type: "skills_status";
  status: SkillsResult["status"];
  /** Number of skills the resource loader actually discovered. */
  discovered: number;
  skills: SkillSummary[];
  /** Operator-mapped `--skill` paths that resolved (echoed for observability). */
  mappedPaths: string[];
  noSkills: boolean;
}

/**
 * Build the `skills_status` event, or null when it should be suppressed.
 *
 * Gated so a default run (no skill flags) in a clean environment (no skills
 * discovered) emits nothing — keeping the golden `test/fixtures/*.jsonl`
 * byte-identical (AGENTS.md rule #2). It surfaces only when the operator
 * opted in via `--skill`/`--no-skills` (status !== "default") OR at least one
 * skill was actually discovered.
 */
export function buildSkillsStatusEvent(
  result: SkillsResult,
  discovered: SkillSummary[],
): SkillsStatusEvent | null {
  if (result.status === "default" && discovered.length === 0) return null;
  return {
    type: "skills_status",
    status: result.status,
    discovered: discovered.length,
    skills: discovered,
    mappedPaths: result.additionalSkillPaths,
    noSkills: result.noSkills,
  };
}

export function loadSkillsExtension(config: SkillsConfig): SkillsResult {
  const home = config.home ?? homedir();
  const noSkills = config.noSkills === true;
  const warnings: string[] = [];
  const additionalSkillPaths: string[] = [];

  for (const raw of config.skillPaths ?? []) {
    const abs = resolveSkillPath(raw, config.cwd, home);
    if (!existsSync(abs)) {
      // Non-fatal: an operator pointed at a folder that isn't there. Drop it
      // and warn rather than failing the run (safe-by-default).
      warnings.push(`skill path not found, ignoring: ${raw}`);
      continue;
    }
    additionalSkillPaths.push(abs);
  }

  let status: SkillsResult["status"];
  if (additionalSkillPaths.length > 0) {
    status = "configured";
  } else if (noSkills) {
    status = "disabled";
  } else {
    status = "default";
  }

  return { status, additionalSkillPaths, noSkills, warnings };
}
