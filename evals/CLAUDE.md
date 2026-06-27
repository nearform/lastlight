# evals — agent orientation

Human-facing usage (how to run, how to add a case) lives in `README.md`. This
file is the *why* — the seams and invariants to preserve when changing the
harness.

## The one invariant

These evals run the **real** production workflows (`issue-triage`, `build`, …)
— their actual YAML, prompts, and skills, unmodified. The only deviations from
production are the two we can't do unattended:

1. **GitHub is mocked**, not bypassed — the agent's `github_*` calls hit an
   in-process fake and are recorded.
2. **Approval gates are disabled** so runs never pause.

If a change makes the eval diverge from prod in any *other* way, it's wrong —
the whole point is to test what ships.

## How the mock actually works (don't break these)

- **The base-URL seam.** The `github_*` tools are agentic-pi's *built-in*
  extension (not a swappable MCP server). agentic-pi ≥ 0.2.11 exposes
  `githubApiBaseUrl`; Last Light threads it `ExecutorConfig.githubApiBaseUrl →
  agenticRun`. `run-instance.ts` sets it to the fake server's URL. This is the
  whole mechanism — `mechanism.test.ts` guards it.
- **Static-token mode.** The harness sets `GITHUB_TOKEN` (a dummy) and
  *unsets* `GITHUB_APP_ID`/`GITHUB_APP_INSTALLATION_ID`, so the GitHub
  extension loads but no real installation token is ever minted. The workflow's
  `profile` (issues-write / repo-write, derived from the workflow name) still
  decides which tools exist.
- **Seeding without a clone.** `runWorkflow` only clones from GitHub when
  `ctx.prePopulateBranch` is set. The eval **never sets it**, so no clone
  happens and the agent's cwd is the workspace root `<stateDir>/sandboxes/
  <taskId>` — exactly the dir `seed.ts` pre-populates (fixture @ base_commit +
  a local bare `origin`, so `git push` works offline). If you ever set
  `prePopulateBranch`, the runner will try to clone real GitHub.
- **Gates need a DB.** A phase only pauses when `db && workflowId && the gate is
  enabled`. The eval passes **no `db`** and an **empty `approvalConfig`**, so
  every gate is a no-op. Don't add a db just for metrics (see below).

## Metrics gotcha

Token/cost come from the session jsonl the executor's shim writes — and the
*final* result envelope is flushed **fire-and-forget** (`void shim.flush()` in
`agent-executor.ts`). So it can land after `runWorkflow` resolves.
`run-instance.ts` calls `drainSessions()` (wait for the jsonl tree to go quiet)
before `collectMetrics()` and before deleting the temp workspace. Remove the
drain and cost silently reads 0.

## Test vs script (keep the split)

- `mechanism.test.ts` — a **real test** in the default `npm test` suite:
  deterministic, AI-free (fake GitHub + the base-URL seam + seed/grade
  red→green). It *should* fail the build if the mock plumbing breaks.
- `run.ts` — a **script** (`npm run eval`), a measurement. It exits non-zero
  only on harness error, never because a model scored badly.
- `datasets/**/*.test.ts` are **fixtures** (held-out tests run inside a seeded
  workspace), NOT harness tests — excluded from both `vitest.config.ts` and
  `evals/tsconfig.json`. Keep them excluded or the default suite tries to run
  raw fixture tests against a missing `src/`.

## Grading = two deterministic signals

- **Execution** (`gradeExecution`): copy the held-out tests in, run them, require
  every `FAIL_TO_PASS` green and every `PASS_TO_PASS` still green — SWE-bench's
  resolved criterion. Held-out tests live in `datasets/<tier>/tests/<id>/`, kept
  out of the seeded repo so the agent can't edit them.
- **Behavioral** (`gradeBehavioral` / `gradeTriage`): assert the recorded
  GitHub mutations (labels, comments, PRs) against the instance's
  `expect_github` / `triage_gold`. Primary signal for triage.

No LLM-as-judge — by design.

## Models

The model list lives in `models.json` (`default` + a `compare` set); `env.ts`
reads it. Each `compare` entry is key-gated by its `envKey`, so
`npm run eval:compare` only runs models whose provider key is present — adding
an entry with no key is a silent no-op, not an error. `id` must be a spec
pi-ai's registry resolves (`provider/model`); Fireworks ids are the long
`fireworks/accounts/fireworks/models/<x>` form. Provider keys are read from
`process.env` by agentic-pi directly (the harness loads `.env`), so a new
provider just needs its key set + a registry id — no harness change.

## Adding a workflow/tier

When pointing the harness at a new real workflow, check:
- `gitAccessProfileForWorkflow` (in `src/workflows/runner.ts`) maps it to a
  profile → which `github_*` tools the agent gets.
- `fake-github.ts` implements every REST endpoint that profile's tools call.
  Unimplemented routes return 404 on purpose (loud, not silent) — add the route
  rather than masking it.
- Register the tier in `run.ts` (`TIERS`) with its default workflow.

## Known sharp edges

- The agent can pick the **wrong owner/repo** for GitHub calls on tiny synthetic
  fixtures (it has no real remote to infer from). That's a model/fixture-tuning
  matter, not a harness bug — surfaces as `behavioral✗` (no PR). Stronger models
  fare better; this is the kind of thing the eval is meant to reveal.
- The harness patches `process.env` (GITHUB_*, etc.) for the duration of a run
  and restores it in `finally`. Keep runs serial; don't parallelize instances in
  one process or the env splices race.
