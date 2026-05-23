/**
 * Minimal template engine for workflow prompt files.
 *
 * Supports:
 *   {{varName}}            — simple variable substitution
 *   {{slugify varName}}    — slugify helper applied to a variable
 *   {{branchUrl file}}     — generate a GitHub branch URL for a file in issueDir
 *   {{#if varName}}...{{/if}} — conditional blocks (no nesting, truthy check)
 */

export interface TemplateContext {
  // Core build request
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueLabels: string[];
  commentBody: string;
  sender: string;

  // Computed from build request
  branch: string;
  taskId: string;
  issueDir: string;
  bootstrapLabel: string;

  // Optional: available during PR phase
  approved?: boolean;
  fixCycles?: number;
  reviewerNote?: string;
  docLinks?: string;

  // Optional: available during fix/re-review phases
  fixCycle?: number;

  // Optional: PR fix request context
  prNumber?: number;
  prTitle?: string;
  prBody?: string;
  failedChecks?: string;
  ciSection?: string;

  // Optional: when set, the harness pre-clones the repo at this branch into
  // the sandbox workspace before the agent starts (see GitSandboxAccess in
  // src/engine/profiles.ts). Used by pr-review / pr-fix so the agent enters
  // a workspace already checked out at the PR's head ref.
  prePopulateBranch?: string;

  // Optional: context snapshot (for architect prompt)
  contextSnapshot?: string;

  // Optional: available during generic loop iterations
  iteration?: number;
  maxIterations?: number;
  previousOutput?: string;

  // Optional: phase outputs from DAG workflow (${phaseName.output} substitution).
  // Values may be strings or structured data (e.g. { approved: true, cycles: 1 })
  // when a phase emits an object via output_var — templates can read
  // {{phaseName.field}} for nested access and ${phaseName.output} for strings.
  phaseOutputs?: Record<string, unknown>;

  /**
   * Mutable phase-to-phase state surfaced from `workflow_runs.scratch`.
   * Used by the socratic explore loop to accumulate Q&A across reply-gate
   * pauses. Templates can read {{scratch.socratic.qa}} etc. via the
   * existing two-level dot notation in renderTemplate.
   */
  scratch?: Record<string, unknown>;

  /**
   * Non-GitHub trigger id (currently only `slack:{teamId}:{channel}:{thread}`).
   * When set, the runner uses this instead of deriving one from
   * owner/repo/issueNumber — that gives Slack-initiated workflows a stable
   * key to pause/resume on.
   */
  triggerIdOverride?: string;

  // Arbitrary extra context
  [key: string]: unknown;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Render a template string with the given context.
 * Processes: {{#if}}, {{slugify}}, {{branchUrl}}, {{varName}}.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  let result = template;

  // 0. Phase output substitution: ${phaseName.output} → phaseOutputs[phaseName]
  if (ctx.phaseOutputs) {
    const phaseOutputs = ctx.phaseOutputs;
    result = result.replace(/\$\{(\w+)\.output\}/g, (_match, phaseName: string) => {
      const val = phaseOutputs[phaseName];
      if (val === undefined || val === null) return "";
      return typeof val === "string" ? val : String((val as { output?: unknown })?.output ?? JSON.stringify(val));
    });
  }

  // Walk a dotted key like `scratch.socratic.ready` through ctx, falling
  // back to ctx.phaseOutputs for the first segment. Returns undefined on
  // any missing intermediate.
  const walkKey = (key: string): unknown => {
    const parts = key.split(".");
    if (parts.length === 1) {
      const val = ctx[key];
      if (val !== undefined && val !== null) return val;
      return ctx.phaseOutputs?.[key];
    }
    let cur: unknown = ctx[parts[0]];
    if (cur === undefined || cur === null) cur = ctx.phaseOutputs?.[parts[0]];
    for (let i = 1; i < parts.length; i++) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[parts[i]];
    }
    return cur;
  };

  // 1. Conditional blocks: {{#if varName}}...{{/if}} (supports dot notation).
  result = result.replace(
    /\{\{#if\s+(!?)(\w+(?:\.\w+)*)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, negate, varName, body) => {
      const val = walkKey(varName);
      // Truthy: non-empty string, non-zero number, non-empty array, true boolean
      const truthy =
        val !== undefined &&
        val !== null &&
        val !== "" &&
        val !== false &&
        val !== 0 &&
        !(Array.isArray(val) && val.length === 0);
      return (negate ? !truthy : truthy) ? body : "";
    }
  );

  // 2. Slugify helper: {{slugify varName}}
  result = result.replace(/\{\{slugify\s+(\w+)\}\}/g, (_match, varName) => {
    const val = ctx[varName];
    if (val === undefined || val === null) return "";
    return slugify(String(val));
  });

  // 3. Branch URL helper: {{branchUrl filename}}
  // Generates: https://github.com/{owner}/{repo}/blob/{branch}/.lastlight/issue-{N}/{file}
  result = result.replace(/\{\{branchUrl\s+(\S+)\}\}/g, (_match, file) => {
    const encoded = encodeURIComponent(ctx.branch);
    return `https://github.com/${ctx.owner}/${ctx.repo}/blob/${encoded}/${ctx.issueDir}/${file}`;
  });

  // 4. Simple variable substitution: {{varName}} and {{a.b.c...}}.
  //    Dotted access first checks top-level ctx, then falls back to
  //    ctx.phaseOutputs[parent] for the first segment so YAML phases can
  //    emit structured output via `output_var` and downstream prompts can
  //    read it directly — and the socratic explore loop can read
  //    {{scratch.socratic.qa}}.
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key) => {
    const val = walkKey(key);
    if (val === undefined || val === null) return "";
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  });

  return result;
}
