# 09 — Review decisions (2026-10-10)

The design review of issue #435 settled the open questions and changed the
plan in places. Where this file and an earlier doc disagree, this file wins;
the earlier docs carry a pointer back here. How the wider field does it is in
[`01-options.md`](01-options.md#how-other-sdlc-factories-do-it-2026-10-10).

## Why the rewrite

The three dialect *bugs* (substring verdicts, no AND/NOT, outputs lost on
resume) are fixable inside YAML. The case for TypeScript rests on what isn't:
the 4.3k LOC of handlers that are code pretending to be config (mostly
pr-review's pipeline), DAG semantics nobody can predict, and resume
correctness. Overlay TS authoring is **not** a driver — no overlay has ever
forked a workflow YAML (see 9 below).

## Decisions

1. **All-TS, one dialect.** Every workflow becomes `defineWorkflow`; the YAML
   workflow dialect is deleted in the same change (see 7).

2. **Dynamic workflows go through a plan interpreter, not code.** A built-in
   workflow executes a zod-validated JSON *plan* — a short list of closed step
   kinds (`agent`, `bash`, `approval`, `notify`, bounded retry/loop), step
   names derived from the plan index. A planner agent, a Slack user or a repo's
   `.lastlight/` can supply a plan because it is data; anything that needs real
   control flow graduates to a TS workflow. **Follow-up issue**, not #435. The
   only #435 constraint: `ctx` stays drivable from data (no compile-time-only
   features).

3. **Depend on OpenWorkflow and engage upstream** rather than vendor it. Pin an
   exact version (no `^`) until 1.0. Open an upstream issue first — feedback
   from the spike, a clear statement that we want to adopt and support the
   project and are happy to send PRs — and check the asks fit their roadmap
   before writing them: a `logger` option, a configurable lease/heartbeat,
   buffered signals (or a documented check-before-park pattern), and a table
   prefix/schema option. Last Light becomes a public reference user.

4. **One database via a generic Drizzle `Backend`.** OpenWorkflow's own
   backends would still bring a second driver per dialect (`node:sqlite` beside
   libsql — outside our `sqlite-write-lock`; `postgres.js` beside `pg`/neon)
   and a second migration system, even with a table prefix. So: implement its
   `Backend` interface over an injected Drizzle db + schema + optional
   write-serializer hook, `ow_*` tables in both `schema/sqlite.ts` and
   `schema/pg.ts`, generated per `apps/server/src/state/CLAUDE.md`, run under
   the existing dual-dialect parity tests. Build it in-repo; offer it upstream
   (e.g. `@openworkflow/backend-drizzle`) once it passes their backend test
   suite. A separate `workflows.db` exists only behind a dev flag.

5. **In-flight runs across a deploy: replay by name; fail loudly on a break.**
   OpenWorkflow memoizes by step *name*, not position, so inserting or
   reordering steps replays safely — the same semantics the YAML engine has
   today (resume by phase name against the deployed file). `version` is bumped
   only when a step name changes meaning; a run pinned to a retired version is
   marked `failed: workflow version retired` on boot and its issue/PR gets a
   re-run link. Old versions are **never** kept registered (this supersedes
   05-migration's "keep N-1 registered"). Guards: a lint rule banning
   non-deterministic step names, and a CI test that replays every workflow
   against recorded histories (captured from the E2E suite, 8).

6. **Typed agent outcomes through a `submit_result` tool.**
   `ctx.agent(name, { …, result: zodSchema })` injects a `submit_result` tool
   into the session (implemented in agentic-pi) whose parameters are the
   schema. A validation failure goes back to the agent as a tool error; a
   session that ends without a valid call is nudged once, then the step fails —
   which also retires the "silent no-op" postcondition marker. Provider-native
   structured output is ruled out (it doesn't compose with a tool-using final
   turn across providers). `r.output` stays available; workspace files remain
   only for large artifacts a later bash step or the facts CLI reads.
   `readStatusLine` survives only inside the converter's output. In #435.

7. **One-go cut-over.** All 15 workflows are hand-ported straight to their
   final shape (`result:` schemas, no `y*` compat helpers). No per-workflow
   `durable: true` flag and no dual engine. The YAML→TS converter and the
   parity test stay on the branch as **development aids** that show what each
   workflow did; they are not a ship gate. Evals run after the cut-over, not
   before it.

8. **Ship gate: end-to-end integration tests with a scripted model.** The
   existing fake `AgentPort` skips agentic-pi, the tool loop, git and GitHub —
   exactly what this change touches. So:
   - a **scripted model provider** in agentic-pi (test-only) that replays
     per-step assistant turns including tool calls (edits, `git commit`,
     `github_*`, `submit_result`);
   - `FakeGitHub` promoted from `apps/evals` into shared test-support so core
     tests can drive it;
   - `--sandbox none` against a temp git repo; each test runs the real path:
     webhook payload → router → dispatch → durable runtime → agentic-pi → git
     + FakeGitHub → assertions on recorded calls and DB rows.

   **Must pass:** `issue-triage`; `build` (BLOCKED stop; happy path parked at
   the approval gate → process restart → approval via the admin API → reviewer
   fix cycle → PR); `pr-review` (pipeline with scripted agents → inline
   comments; re-review on push resolves threads). **If cheap once the harness
   exists:** `pr-fix` (incl. a missing `submit_result`), `dependabot-ci-fix`
   (bot-branch routing, #442), and the `kill -9` mid-step reclaim.

9. **Overlay TS workflows are out of #435.** Prompts, skills, agent-context
   and config keep their per-file layering, unchanged. The loader **rejects**
   `instance/workflows/*.yaml` at boot with an error naming the replacement.
   Built-ins stay internally composable so the design in
   [`04-overlays.md`](04-overlays.md) is not blocked. **Follow-up issue**,
   picked up when a real override need appears — that need decides which typed
   options to expose.

10. **The workflow graph is derived from code, conditions included.** A
    build-time ts-morph script projects each `run()`'s control flow onto its
    `ctx.*` calls and emits `workflow-graphs.json` into the image (no ts-morph
    in the server process):

    | Construct | Rendered as |
    |---|---|
    | `await ctx.agent/bash/approval/notify/step(name, …)` | node: step-name pattern (`fix:${cycle}` → `fix:N`) + kind |
    | `if`/`else`, ternary, `&&` | branch; the condition's source text on the edge |
    | `for`/`while` | back-edge labelled with the loop condition |
    | `ctx.parallel` | fan-out node with the branch body as a subgraph |
    | library calls (`reviewLoop`, `iterate`) | followed into their source, collapsible subgraph |
    | `return`/`throw` | terminal node |
    | anything else | opaque "code" node linking the source span — never dropped |

    The run view overlays the path taken and where a run is parked; the
    definition view adds per-edge frequencies from history. Built-ins must
    extract with **zero opaque nodes** (CI), and CI asserts every step name the
    E2E suite records maps to a graph node — the runtime partner of 5's lint
    rule. Convention: name complex conditions so edge labels stay readable.

11. **Per-step workspace snapshots and `forkRun` are in #435.** After each
    `agent`/`bash` step, `ctx` writes the workspace to a hidden ref
    `refs/lastlight/runs/<runId>/<step>` (a tree via `git write-tree` on a
    temporary index — the branch is untouched). Contents: tracked files
    (deduped against the clone — only changed blobs cost anything), untracked
    non-ignored files, and `.lastlight/` artifacts force-included. Never
    `node_modules` or anything else gitignored. A per-file size cap (≈5 MB)
    skips and records oversize files. Measured scale: one complete pr-review
    artifact dir is ~376 KB. `forkRun(runId, fromStep, overrides)` checks out
    the step's tree, restores the memo up to it and continues with overrides
    (model, prompt, thinking). Config `durable.snapshots`: **evals on**; **prod
    `off` (default) or `failed`** — taken during the run, deleted on success,
    kept for failed/cancelled runs until the workspace is next recreated.
    Follow-up: port the `micro-*` phase-replay scripts onto `forkRun` and add a
    "fork from here" dashboard action.

12. **Admission stays ours; OpenWorkflow only sees admitted runs.** OpenWorkflow
    owns execution, leases, reclaim and replay. Last Light keeps *whether a run
    may start*: the global cap, the PR run lock, k8s quota probes, queue TTL and
    the queued-ack comments (#172, #244). A run is created in OpenWorkflow only
    when admission promotes it; worker concurrency is set ≥ the cap and is not
    the limiter. Parked runs (approval/sleep) don't count against the cap, and
    an **approved run re-enters admission at the front of the queue** — the
    decision row is written immediately, the signal is sent when a slot frees
    (the nearform OOM history argues against a burst of resumes). Cancel and
    supersede stay ours, driving OpenWorkflow's cancel (graceful cancel, #437,
    slots in later). `workflow_runs` stays the projected status for the
    dashboard and evals. Lease reclaim retires the "running but dead" sweeps;
    only the "queued, never admitted" sweep remains.

13. **Crons stay light data.** The nine `cron-*.yaml` move to `crons/` under a
    small standalone schema (`name`, `schedule`, `workflow`, `context`/`discover`,
    `condition`). The `crons:` enable/disable layering and `allowKeys` bound are
    unchanged. Triggers are configuration; control flow is code.
    `classification`/`chat` routing metadata stay typed fields on
    `defineWorkflow`.

14. **The webhook inbox is separate work.** Persist the raw delivery (keyed on
    `X-GitHub-Delivery`) before the 202, route from the inbox, re-process on
    boot. It needs no durable runtime, has a different failure mode (lost
    events, not wrong execution), and gets its own issue and PR. If it lands
    first, the E2E suite can inject deliveries straight into it.

15. **Rollback is designed in, and drizby is the canary.**
    - Ship a **v0.40.x patch first** whose resume and sweep code skip any
      `workflow_runs` row with an `engine` it doesn't know; the cut-over marks
      its rows `engine = 'durable'`. That makes the previous image a safe
      rollback target (it won't re-run durable runs on the YAML engine).
    - **No destructive migrations in the cut-over release.** `ow_*` tables are
      additive; YAML-only tables/columns are dropped a release later.
    - **Rehearse** on a copy of the drizby database: cut over with scripted
      runs parked at gates → roll back to the patch → roll forward; nothing may
      run twice.
    - YAML runs in flight at the cut-over are failed with a "workflow engine
      upgraded, re-run" link (a handful of parked approvals at most — check
      before deploying).
    - Deploy **drizby first**, nearform only once drizby is healthy.
    - Release as a minor bump with a breaking-change note (forked overlay
      workflow YAML now fails at boot).
