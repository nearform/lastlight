# Handoff — dependency-PR resilience (#251, #252)

Working branch: **`feat/dependency-pr-resilience`**, off `main` at `7d4cc40` (v0.22.0).

**Every phase is implemented.** Phase 8 is deferred by design (09 §S5). The tree
is clean and the full gate is green: `pnpm turbo run typecheck` 12/12,
`pnpm turbo run test` 8/8 (core **2185 passed**, 18 skipped — 1904 at the start
of this work), `pnpm turbo run build` 9/9. The sandbox integration suite passes
against real docker: `RUN_SANDBOX_IT=1 npx vitest run tests/sandbox/` → 43 files,
372 passed.

Read [README.md](README.md) for the plan index and
[09-state-machine.md](09-state-machine.md) — normative, and it supersedes parts
of phases 3, 4, 5, 7 and 8. [BREAKING-CHANGES.md](BREAKING-CHANGES.md) is the
running record; [RELEASE-NOTES.md](RELEASE-NOTES.md) is assembled from it.

## Landed

| Commit | Phase | What |
|---|---|---|
| `afaff51` | — | the plan docs |
| `6549dde` | **1** | `getCiFailureReport` / `getBaseChecksState`; `{{ciSection}}` states out loud when it degraded to annotations; `Actions: read` documented on all three setup surfaces; three Actions read tools in agentic-pi's `READ_TOOLS` |
| `33449be` | **2** | the `fixing` skill and the `diagnose` phase on both fix workflows; `DIAGNOSIS_COMPLETE` / `CI_FIX_COMPLETE` markers; a new engine `skip_if:` |
| `f4373ce` | **6** | `fix:` / `dependencies:` / extended `review:` config through all four layers, clamped add-only with a `policy-downgrade` warning |
| `b442cb9` | — | [10-pr-memory.md](10-pr-memory.md), the PR-memory design |
| `0f1a872` | **3′** | `PrState` + `resolvePrState` + five pure decision functions; PR-scoped run lock; deterministic `pr.checks_failed` routing; four latent bugs fixed |
| `ebf01ac` | **4, 5** | the marker harvest; escalation actions; the flaky cap and model escalation; the gate loop and `.lastlight-verify.sh` hardening; impact classification and the three impact labels; `mayMerge` projected into the merge context |
| `4e045d1` | **4b, 7** | `PrState.notes`; `resolveReviewTrigger` wired; the `excludeApp` deadlock fix; the durable check-run lifecycle |
| `4e2ecd8` | — | test isolation in the `until_bash` integration suite |

Every commit carries its own spec + site docs (a `docs-sync` pre-commit hook
enforces it).

## What is left

Only [06-config.md](06-config.md) §6.5 items **5** and **6**. Item 5 is now
half done; item 6 has not been started.

- **§6.5.5 — `Actions: read`.** The **positive** half is verified against real
  GitHub. The dev App installation (`cliftonc`, all repos) reports
  `"actions": "read"` in its granted permissions, and `getCiFailureReport` run
  against a real red head SHA (`nearform/lastlight@cb9f9cc4`) returns
  `logsAvailable: true` with a genuine 2.5 KB excerpt, the failing step named
  (`Install dependencies`) and no annotation fallback — so the excerpt
  extraction and the renderer both work on real Actions logs, which is the
  premise the fix loop rests on.

  The **negative** half — revoke, and confirm the degrade to annotations *with
  the explicit notice* — is still owed, and needs a target this work did not
  have. Revoking on the live App would disturb production, and the obvious
  substitute does not reproduce the denial: a deliberately downscoped
  installation token that omits `actions` entirely **still returned the logs**,
  because the repository is public and GitHub gates public Actions logs on
  public read rather than on the permission. It therefore needs a **private**
  repo with a red PR, or a second dev App to revoke on.
- **§6.5.6 — the evals end-to-end pass.** **Done, with one narrowing.** Two new
  tiers ship in `apps/evals/datasets/`: `fix` (six cases — one per diagnosis
  class, plus the promoted-flaky attempt) and `dependency-merge` (three cases,
  one per impact tier). Both needed a harness seam first: the workflows are
  *dispatched* in production, and every variable their prompts reason with comes
  from `renderContext`'s projection of the `PrState` snapshot — so the harness
  now seeds a snapshot and hands it to core's own projection
  (`apps/evals/src/pr-context.ts`, exported through the evals barrel), rather
  than running them off a hand-built context in which every `{{#if}}` guard takes
  the empty branch.

  **The narrowing:** the escalation *policy* is not measured here and should not
  be. `resolveFixDisposition` and friends are pure functions over the snapshot,
  already table-tested in core without a model; and the harness cannot drive a
  multi-run sequence anyway, because the marker harvest that carries a verdict
  into the next attempt writes through `workflow_runs.scratch` — a database the
  harness deliberately does not pass. What the tiers measure is the half only a
  model can answer: given real CI evidence, does the agent reach the right
  class, and does it honour an impact ceiling nothing in the code enforces.
  `fix__flaky-promoted` covers the attempt dimension by seeding attempt 3 with
  two prior flaky verdicts.

  Baseline: Claude Haiku 4.5, **8/9**, $1.51. The first run found two *fixture*
  defects rather than model ones — identical base/head trees (fixed with
  `repos-head/<id>/`) and two expectations that contradicted the shipped rubrics
  — which is the tiers earning their keep before they ever graded a model.

  The one standing failure is worth carrying forward: on the express 4 → 5 case
  the agent behaves safely every time (FUNCTIONAL, `requires-human`, no
  auto-merge) but intermittently records `impact=none` on a *major*, reasoning
  that the tier is only assigned on the TRIVIAL path. That reading is one the
  prompt's STEP 2a wording permits, and an `impact=none` on a major erases the
  audit record the impact label is supposed to be. Tightening
  `prompts/dependabot-pr-merge.md` is a follow-up with evidence behind it now.
  It is also the case for grading markers rather than mutations: `behavioral`
  passed on every run.

§6.5 items 1–4 are done, including the repo-config clamp check: a fixture
`.lastlight/lastlight.yml` that tries to loosen `fix.maxAttempts`,
`fix.maxCostUsd`, `dependencies.autoMergeMaxImpact` and
`dependencies.requireSettledChecks`, and to set the two operator-only leaves,
is rejected leaf-by-leaf with `policy-downgrade` / `key-not-allowed` /
`invalid-value` and clamps rather than failing.

Then: **cut a GitHub Release.** `lastlight server update` pulls the GHCR images
that only a Release builds, so a prod-facing change cannot reach a deployment
without one (`docs/RELEASING.md`).

## Known gaps, deliberately left

- ~~`fix.localIterations` and `fix.gateTimeoutSeconds` are not wired.~~
  **Closed.** The phase schema's `timeout_seconds` and
  `generic_loop.max_iterations` also accept `{ from: <ctx path>, default: N }`
  (`core/templated-number.ts`), resolved against the run's effective — already
  repo-clamped — `fix` block. The seam turned out to belong in the engine, not
  in the loader or `simple.ts`: the context is the only channel a
  runtime-agnostic engine has.
- ~~The dashboard renders none of this.~~ **Closed.** `PrStatePanel` renders
  `context.prState`, the recorded `{decision, reason}` pairs and the harvested
  push gate on the run detail view; the Config tab renders `fix` /
  `dependencies` / `review`, pinned against the real type by
  `tests/admin/dashboard-config-mirror.test.ts`.
- **The PR-notes journal and the recorded push gate are inert on the kubernetes
  backend** — no host-shared workspace, so the drain finds no file and the gate
  read finds no script.
- ~~`phase2-smoke-github-read-profile.jsonl` records `toolCount: 18`.~~
  **Closed.** Re-captured from a real run (21 tools, the Actions trio
  included), in a clean env from `/tmp` with `--no-skills` so the capturer's
  own skills catalogue and search keys stay out of the evidence — the smoke
  command in `packages/agentic-pi/CLAUDE.md` now says so.
- ~~`resolveDispatchDisposition` reads the operator's review config in the
  dispatcher and the repo-clamped one in `dispatchWorkflow`.~~ **Closed.** The
  gate body is now one function (`applyPrDispatchGate`) called by both routes,
  and `prPolicyConfig(layer)` folds in the repo layer resolved through the
  injected `DispatchDeps.resolveRepoPolicy`. It was worse than the seam note
  said: the webhook route always passes `_prState`, so `dispatchWorkflow`'s
  clamped gate never ran for it and **every** webhook-originated PR dispatch
  used operator values while the prompt rendered the repo's.

### Overlay forks that silently keep old behaviour

Each of these degrades quietly rather than erroring, which is the dangerous
shape. All are recorded in BREAKING-CHANGES.

- A fork of `skills/fixing/SKILL.md` still names `../.lastlight-verify.sh`; the
  gate never runs.
- A fork of either fix workflow that **kept** the old
  `phaseOutputs.diagnosis.contains('class=<cls>')` rows now never matches at
  all, so it runs a full sandbox on every `flaky` / `infra-dependent` /
  `upstream-broken` verdict; one that **reworded**
  `scratch.fixMarkers.diagnosis.class == 'flaky'` never gets the flaky
  promotion — `promoteFlakyDiagnosis` matches that expression **literally**.
- A fork of `dependabot-pr-merge.yaml` keeps `skill: code-review` and runs the
  new prompt without the impact rubric.
- A fork of either fix prompt that reworded a marker line loses the harvest, and
  with it `attempt` / `priorAttempts` / `flakyDeferrals`.

## Decisions already made — do not re-litigate

- **Packaged defaults** (operator's call, overriding the docs' own
  recommendations): `dependencies.autoMergeMaxImpact: medium`,
  `review.trigger: after-checks`, `review.skipDraft: true`.
- **README locked decision 8 ("no changes to `packages/workflow-engine/`") is
  not held**, three times: `skip_if:`, the `generic_loop` marker postcondition,
  and `messages` on loop phases.
- **An escalating skip writes a run row.** Without one `escalatedAtSha` never
  persists, and the next dispatch reads our own `requires-human` as a *human's*
  permanent hold — latching the PR dead, which is the one-way door 09 §S1 set
  out to remove. This is 09 → D1's general rule applied to itself.
- **`.lastlight-verify.sh` and `.lastlight-notes` both live at the checkout root
  on every backend**, kept out of the PR by `.git/info/exclude`. The
  workspace-root placement the plan assumed is unreachable on gondolin, which is
  the packaged default.
- `review` is **not** seeded onto the template context (it would shadow
  `build.yaml`'s `output_var: review`). `fix` and `dependencies` are.
- `models.diagnose` ships **unset** — pinning an Anthropic model would break a
  deployment that overrides only `models.default` to another provider.

## Pre-existing bugs found (not introduced here)

See BREAKING-CHANGES → "Pre-existing bugs found during execution". The two worth
knowing before touching this code:

- **The dispatcher's concurrency guard never worked** — `isRunning(handler,
  triggerId)` was called with a bare workflow name and a bare issue number while
  every row is written as `<workflow>:<phase>` / `owner/repo#N`. Closed by the
  PR-scoped lock.
- **`{{#if}}` does not nest** (`templates.ts`, lazy regex). Fixed in the prompts
  this work touched and pinned by tests; other prompts are unaudited.

## Working notes

- **The `docs-sync` pre-commit hook inspects the index**, so `git add … && git
  commit …` in one shell call trips it — the staging has not run when the hook
  fires. Stage in a separate call. Bypass is `LASTLIGHT_SKIP_DOCS_CHECK=1`.
- **`apps/www/src/content/spec/` is generated and gitignored** — edit
  `apps/server/spec/*.md` and `apps/www/src/pages/`, never the mirror.
- **`pnpm --filter lastlight-shared test` and `lastlight-workflow-engine test`
  are silent no-ops** — neither package has a `test` script and pnpm exits 0.
  Their behaviour is covered by `lastlight-core`'s suite.
- **Subagents were repeatedly cut off mid-task** by connection errors and
  watchdog stalls, each time *after* the code had landed but before reporting.
  Verify the tree independently rather than trusting the completion signal.
- Frozen surfaces: `runWorkflow.length === 9` (`evals-contract.test.ts`),
  `DEFAULT_REPO_CONFIG_ALLOW_KEYS` order vs `config/default.yaml`,
  `tests/cron/label-vocab.test.ts`, and `{{phaseOutputs}}` being empty across a
  resume boundary.

```bash
pnpm turbo run typecheck && pnpm turbo run test    # the gate
cd apps/server && npx vitest run tests/engine/pr-decisions.test.ts   # the state machine's table tests
RUN_SANDBOX_IT=1 npx vitest run tests/sandbox/     # needs the sandbox image built
```
