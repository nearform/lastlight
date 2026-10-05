/**
 * `defineWorkflow` — a code-defined Last Light workflow (spike).
 *
 * The YAML runtime-policy keys (`git_access`, `workspace`, `pr_scoped`, …) and
 * the routing metadata (`classification`, `chat`) become typed fields; the
 * phases become an ordinary async function over {@link WorkflowContext}.
 */

import type { GitAccessProfile } from "../core/types.js";
import type { WorkflowContext } from "./context.js";
import type { Json } from "./step.js";

export interface WorkflowPolicy {
  gitAccess: GitAccessProfile;
  workspace: "per-run" | "per-target-reuse" | "per-target-recreate";
  prScoped?: boolean;
  prepopulateSynthBranch?: boolean;
  prepopulatePrHeadRef?: boolean;
  prFixShaped?: boolean;
}

export interface WorkflowOutcome {
  success: boolean;
  /** Terminal summary (the YAML engine's `on_success.set_phase` / failure message). */
  summary: string;
  prNumber?: number;
}

export interface LastLightWorkflow {
  name: string;
  /** Bump when a change is not replay-compatible with in-flight runs. */
  version: string;
  description?: string;
  policy: WorkflowPolicy;
  classification?: { intent: string; description: string; examples?: string[] };
  chat?: { trigger?: string; summary: string; deflect?: string[]; reply?: string };
  run(ctx: WorkflowContext): Promise<WorkflowOutcome>;
}

export function defineWorkflow(def: LastLightWorkflow): LastLightWorkflow {
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) throw new Error(`invalid workflow name: ${def.name}`);
  return def;
}
