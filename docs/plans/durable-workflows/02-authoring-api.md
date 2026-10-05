# 02 — Authoring API

Module: `lastlight-workflow-engine/durable` (still pino-free and zod-only — the
engine's dependency invariant holds; the runtime adapter lives in core).

## `defineWorkflow`

```ts
export default defineWorkflow({
  name: "build",
  version: "1",                       // bump when a change can't replay in-flight runs
  policy: { gitAccess: "repo-write", workspace: "per-target-recreate", prepopulateSynthBranch: true },
  classification: { intent: "build", description: "…", examples: [/* … */] },
  chat: { trigger: "build owner/repo#N", summary: "…" },
  async run(ctx) { /* ordinary TypeScript */ return { success: true, summary: "complete", prNumber } },
});
```

The YAML runtime-policy keys (`git_access`, `workspace`, `pr_scoped`, …) and
routing metadata (`classification`, `chat`) become typed fields — so the
"overlay-only workflow gets the right token" property from #256/#368 is kept,
and checked by the compiler instead of `validateAssets` warnings.

## `WorkflowContext`

| Member | Durable? | Replaces |
|---|---|---|
| `ctx.agent(name, { prompt, skills, model, variant, timeoutSeconds, access, unrestrictedEgress, webSearch, sandboxImage, commandPolicy, vars })` → `AgentResult` | memoized step | `type: agent` phase |
| `ctx.bash(name, command, { timeoutSeconds, vars })` | memoized step | `type: bash` |
| `ctx.step(name, fn)` | memoized step | `onPhaseEnd` harvests, `scratch` writes, app handlers |
| `ctx.approval(gate, { summary, message, artifact, kind: "approve" \| "reply", timeout })` → `{ approved, reason, reply }` | request step + durable signal wait | `approval_gate`, loop gates, reply gates |
| `ctx.parallel(items, { max }, fn)` | each branch's steps | `type: fanout` |
| `ctx.notify(name, message, vars)` | memoized step (posts once) | `messages.on_*` |
| `ctx.sleep(name, "3d")` | durable timer | — (new) |
| `ctx.model(role)` / `ctx.variant(role)` / `ctx.gateEnabled(g)` / `ctx.num(path, fallback)` / `ctx.render(tpl)` | pure | `{{models.x}}`, `approval:` config, `{ from: … }` budgets |

Prompts are still Markdown templates resolved through the layered
`AssetLoader`, so prompt-level overlay overrides keep working unchanged.

**The rule authors must learn:** step names are the memo key — unique and
deterministic per run (suffix loop/branch indices: `fix:${cycle}`,
`site:${id}`). Code *between* steps re-executes on every replay, so it must be
deterministic (no `Date.now()`, no un-stepped I/O). This is the entire
programming model; it replaces the YAML schema, template grammar, expression
grammar, trigger rules and `PhaseRef` label conventions.

## Library functions instead of DSL constructs

- `reviewLoop(ctx, { review, reReview, fix, maxCycles, approvalGate, messages })`
  — 74 lines, versus ~200 lines of `runReviewerLoop` + its scratch bookkeeping.
  The loop variable is a JS `for`; on replay each completed review/fix step
  returns its persisted result and the loop walks back to where it parked.
- `iterate(ctx, { maxIterations, agent, until, untilBash, onSoftFailure, gate })`
  — `generic_loop`.
- `readStatusLine(output, ["READY", "BLOCKED"])` — a typed verdict from the
  first line that *starts* with a status token, replacing the substring rule.

## Examples

`build` hand-ported: `apps/server/src/workflows/durable/workflows/build.ts`.

`pr-review`'s site-review fan-out, which today needs `type: fanout`,
`branches_from`, `branch:` templates with `{{item.*}}`, `until_bash`,
`on_branch_gate_failure` and branch-name encoding rules:

```ts
const sites = await ctx.step("site-plan:manifest", () => readBranchManifest(ctx));   // typed, validated once
const reviews = await ctx.parallel(sites, { max: ctx.num("siteConcurrency", 6)! }, async (site) => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await ctx.agent(`site:${site.id}:${attempt}`, {
      prompt: "prompts/review-site.md",
      model: site.pair ? ctx.model("review-site-pair") : ctx.model("review-site") ?? ctx.model("review-survey"),
      vars: { item: site },
    });
    const gate = await ctx.bash(`site:${site.id}:${attempt}:check`, `"$FACTS" sites --check ${site.id} --dir .lastlight/pr-review --repo .`);
    if (gate.success) return { site: site.id, ok: true, output: r.output };
  }
  return { site: site.id, ok: false };
});
```

The model fallback is `??`, the retry is a `for`, and the result is a typed
array the next step consumes directly — no `{{#if}}` pairs, no workspace-file
hand-off, no `PhaseRef` label parsing.
