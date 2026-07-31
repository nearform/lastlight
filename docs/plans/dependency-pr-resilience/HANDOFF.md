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

Only [06-config.md](06-config.md) §6.5 items **5** and **6** — both need
credentials this work did not have.

- **§6.5.5 — `Actions: read`, verified for real.** Grant it on the dev App,
  confirm `getCiFailureReport` returns `logsAvailable: true` with genuine log
  excerpts against a known-red PR, then revoke and confirm it degrades to
  annotations *with the explicit notice*. This is the highest-value remaining
  check: every diagnosis in the fix loop is capped at annotation quality until
  the permission is actually granted, and the whole plan's premise is that real
  logs are what make diagnosis worth doing.
- **§6.5.6 — the evals end-to-end pass.** Needs a model provider key (no
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` was available
  here) and costs real model spend. Drive each of the five diagnosis classes
  through attempts 1 → 3 asserting the escalation policy per class, and a
  major-bump case per impact tier asserting the label + action. Scaffold with
  `plugins/lastlight/skills/lastlight-evals`; build fixtures from real PRs with
  `add-case --pr <url>`.

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

- **`fix.localIterations` and `fix.gateTimeoutSeconds` are not wired.** The
  phase schema parses `max_iterations` and `timeout_seconds` as plain numbers,
  so they cannot be templated from config; `pr-fix.yaml` and
  `dependabot-ci-fix.yaml` hardcode values matching the packaged defaults (`2`
  and `900`). Changing either config key does nothing. Wiring them needs a
  config→definition seam in the loader or `simple.ts`.
- **The dashboard renders none of this.** Nothing in `apps/server/dashboard/src`
  reads `context.prState`, so §S3's "recorded snapshot in the run detail panel"
  has no panel yet, and the mirrored `RepoMergedConfig` / `RepoConfigSources`
  types still do not carry `fix` / `dependencies` / `review`.
- **The PR-notes journal is inert on the kubernetes backend** — no host-shared
  workspace, so the drain finds no file.
- **`packages/agentic-pi/test/fixtures/phase2-smoke-github-read-profile.jsonl`
  records `toolCount: 18`, now 21.** Captured evidence from a real run —
  re-capture with the smoke command in `packages/agentic-pi/CLAUDE.md`, do not
  hand-edit. Nothing asserts it today.
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
