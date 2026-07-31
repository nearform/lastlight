# Handoff — dependency-PR resilience (#251, #252)

Working branch: **`feat/dependency-pr-resilience`** (off `main` at `7d4cc40`, v0.22.0).
Tree is clean and the full gate is green: `pnpm turbo run typecheck` 12/12, `pnpm turbo run test` 8/8 (core **1904 passed**, 15 skipped).

Read [README.md](README.md) for the plan index and [09-state-machine.md](09-state-machine.md) — normative, it supersedes parts of phases 3, 4, 5, 7 and 8. [BREAKING-CHANGES.md](BREAKING-CHANGES.md) is the running record the release notes get assembled from.

## Landed

| Commit | Phase | What |
|---|---|---|
| `afaff51` | — | the plan docs |
| `6549dde` | **1** | `getCiFailureReport` / `getBaseChecksState`; `{{ciSection}}` states out loud when it degraded to annotations; `Actions: read` documented on all three setup surfaces; three Actions read tools in agentic-pi's `READ_TOOLS` |
| `33449be` | **2** | the `fixing` skill and the `diagnose` phase on both fix workflows; `DIAGNOSIS_COMPLETE` / `CI_FIX_COMPLETE` markers; a new engine `skip_if:` |
| `f4373ce` | **6** | `fix:` / `dependencies:` / extended `review:` config through all four layers, clamped add-only with a `policy-downgrade` warning |
| `b442cb9` | — | [10-pr-memory.md](10-pr-memory.md), the PR-memory design (folds into Phase 4) |
| `0f1a872` | **3′** | `PrState` + `resolvePrState` + five pure decision functions; PR-scoped run lock; deterministic `pr.checks_failed` routing; four latent bugs fixed |

Every commit carries its own spec + site docs (a `docs-sync` pre-commit hook enforces it).

## Remaining

### Phase 4 — [04-retry.md](04-retry.md), as superseded by [09](09-state-machine.md) §S1
Less remains than the doc implies: `resolveFixDisposition` **already** enforces `maxAttempts`, `maxCostUsd`, the stateful `requires-human` guard and the live `upstream-broken` precondition. What is left:

- **The `onPhaseEnd` marker harvest** — parse the two marker lines into `scratch`, populating `priorAttempts[]` and `flakyDeferrals`. This replaces a documented seam: `pr-state.ts:452` currently approximates "did this run spend an attempt?" by asking whether the `diagnose` phase produced a succeeded ledger row. Replace that call; the signature does not change.
- **Escalation *actions*.** Today a PR that exhausts its attempts is skipped with a reason but **nothing is applied to the PR** — no `requires-human`, no comment. It is safe (a later push by anyone else resets `attempt` to 1, so it cannot latch) but it is *silent*, which §4.3 explicitly calls worse than being visible. Needs the label plus **one** comment naming the escalation case, the attempt count, and each attempt's `class=` / `cause=`.
- **Flaky deferral counting** and promotion to `reproducible` at `fix.maxFlakyDeferrals: 2`.
- **Model escalation** — substitute `models["pr-fix-retry"]` above `fix.escalateModelAfterAttempt` in `simple.ts`. Do not try to template `{{attempt}}` into `model:`; `resolveModelVariant` renders against `run.ctx` only.
- **The within-run gate loop** — `generic_loop` + `until_bash` on the `fix` phase. Two traps: `timeout_seconds` defaults to **30s** in `runUntilBash` and will kill a real test suite; and the engine only retries *soft* outcomes, which is acceptable — do **not** add hard-failure retry to the engine.
- **`.lastlight-verify.sh` hardening** — record its contents on the run record, make `gate=skipped` never authorise a push, rewrite it every attempt.
- **Phase 4b — PR memory** ([10-pr-memory.md](10-pr-memory.md)): `PrState.notes`, a bounded fenced journal riding the same harvest.

> **Wrinkle that applies to both the verify script and the memory journal.** 09 asserts `.lastlight-verify.sh` "sits outside the git tree" at the workspace root. That is true on docker/none/smol but **not on gondolin, which is the default backend** — gondolin mounts only cwd, so `../` is unreachable in the guest. The established pattern is the skill bundle's: stage under the repo and add to `.git/info/exclude`. Resolve per backend.

### Phase 5 — [05-impact.md](05-impact.md), as superseded by [09](09-state-machine.md) → D10
`mayMerge` already exists and already gates both merge actions, so D10 is done. Left: the `dependency-impact` skill, the three impact labels (+ `label-vocab.test.ts`), and the merge prompt's STEP 2 / 2b / 3 plus the extended `ASSESSMENT_COMPLETE` marker. `dependencies.autoMergeMaxImpact` ships **`medium`**.

### Phase 7 — [07-review-triggers.md](07-review-triggers.md), as superseded by [09](09-state-machine.md) §S2
`resolveReviewTrigger` exists as a pure function but is **deliberately not wired** — `resolveDispatchDisposition` leaves `pr-review` ungated (`pr-decisions.ts:502`). Left: wire it; the `getChecksConclusion({ excludeApp })` deadlock fix (**must-fix** — `postsCheck` + `after-checks` deadlocks on our own check); the durable check-run lifecycle (completed from the run's terminal transition, not a `.then()` on an in-memory promise, so it stops stranding on every deploy); the new webhook events `labeled` / `review_requested` / `ready_for_review`; `skipDraft` enforcement; CI evidence in the review context; §7.4b's `condition.unless` predicate map (un-superseded, since the crons stay).

Config already ships `review.trigger: after-checks` and `review.skipDraft: true`, so wiring it **changes behaviour on upgrade** — both are recorded in BREAKING-CHANGES.

### Final — task #8
Whole-plan verification per [06-config.md](06-config.md) §6.5: the sandbox integration test for `until_bash` (`RUN_SANDBOX_IT=1`, needs the images built), the evals end-to-end pass, and a release note assembled from BREAKING-CHANGES.md. Phase 8 is **deferred** — the crons stay (09 §S5).

## Decisions already made — do not re-litigate

- **Packaged defaults** (operator's call, overriding the docs' own recommendations): `dependencies.autoMergeMaxImpact: medium`, `review.trigger: after-checks`, `review.skipDraft: true`.
- **README locked decision 8 ("no changes to `packages/workflow-engine/`") is not held.** It rested on "every capability needed already exists"; it did not. `skip_if:` was added, reusing the scheduler's existing non-failing-skip path and `loop-eval.ts`'s existing evaluator.
- `review` is **not** seeded onto the template context (it would shadow `build.yaml`'s `output_var: review`). `fix` and `dependencies` are.
- `models.diagnose` ships **unset** — pinning an Anthropic model would break a deployment that overrides only `models.default` to another provider.

## Pre-existing bugs found (not introduced here)

- **The dispatcher's concurrency guard has never worked.** `isRunning(handler, triggerId)` is called with a bare workflow name and a bare issue number; every phase row is written with `skill = "<workflow>:<phase>"` and `trigger_id = "owner/repo#N"`. No row can match both, so it always returned false — meaning the per-PR workspace reuse (#107), which deliberately drops the run-id suffix so runs land on the *same directory*, has been relying on a guarantee it never had. Closed by the PR-scoped lock in `0f1a872`.
- `{{#if}}` **does not nest** (`templates.ts:8`, lazy regex) — nested conditionals were leaking raw mustache into agent prompts. Fixed in the fix prompts and pinned by a test; other prompts are unaudited.
- `apps/www/.../configuration.astro` documents a **`WORKFLOW_DIR` env var that does not exist**. Left as-is, out of scope.
- The dashboard's mirrored `RepoMergedConfig` / `RepoConfigSources` (`apps/server/dashboard/src/api.ts`) do not carry the new policy blocks, so the per-repo Config tab won't render them.
- `packages/agentic-pi/test/fixtures/phase2-smoke-github-read-profile.jsonl` records `toolCount: 18`, now 21. It is captured evidence from a real run — re-capture with the smoke command in `packages/agentic-pi/CLAUDE.md`, don't hand-edit. Nothing asserts it today.

## Working notes for the next session

- **The `docs-sync` pre-commit hook inspects the index**, so `git add … && git commit …` in one shell call trips it — the staging hasn't run when the hook fires. Stage in a separate call. Bypass is `LASTLIGHT_SKIP_DOCS_CHECK=1`.
- **`pnpm --filter lastlight-shared test` and `lastlight-workflow-engine test` are silent no-ops** — neither package has a `test` script and pnpm exits 0. Their behaviour is covered by `lastlight-core`'s suite. Don't trust them as a gate.
- Four subagents in a row were cut off mid-task by `API Error: Connection closed mid-response`, each time **after** the code had landed but before reporting. Verify the tree independently rather than trusting the completion signal, and commit at phase boundaries.
- Frozen surfaces: `runWorkflow.length === 9` (`evals-contract.test.ts`), `DEFAULT_REPO_CONFIG_ALLOW_KEYS` order vs `config/default.yaml`, `tests/cron/label-vocab.test.ts`, and `{{phaseOutputs}}` being empty across a resume boundary.

```bash
pnpm turbo run typecheck && pnpm turbo run test    # the gate
cd apps/server && npx vitest run tests/engine/pr-decisions.test.ts   # the state machine's table tests
```
