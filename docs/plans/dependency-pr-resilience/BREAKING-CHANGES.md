# Breaking changes — dependency-PR resilience

A running record of every behaviour change in this work that an existing
deployment would notice on upgrade. Last Light has very few users, so the plan
deliberately prefers a clean break over a compatibility shim — but every break
is recorded here, with the migration, so the release notes can be assembled from
this file.

Entries are appended as each phase lands.

## Policy defaults chosen at execution time

Three of the README's open questions were settled by the operator before any code landed. Each overrides the phase doc's own recommendation in favour of delivering the issue's actual ask, on the basis that Last Light has very few deployments and a clean break is cheaper than a compatibility shim.

| Key | Plan recommended | **Shipped** | Effect on upgrade |
|---|---|---|---|
| `dependencies.autoMergeMaxImpact` | `low` | **`medium`** | Low- **and** medium-impact major version bumps auto-merge on every deployment, rather than requiring `medium` to be set in an overlay. This is issue #252's actual ask. High-impact majors still get `requires-human`. |
| `review.trigger` | `eager` (today's behaviour) | **`after-checks`** | `pr-review` no longer fires on `pr.opened` / `pr.synchronize` / `pr.reopened`. It runs once per settled head SHA, either colour, and can cite the CI result. Rapid pushes no longer produce a review per commit. |
| `review.skipDraft` | `true` | **`true`** | Draft PRs are no longer reviewed on the webhook path, matching what the cron has always done. `ready_for_review` becomes the event that triggers the review. |

## Deviations from the plan's locked decisions

- **README locked decision 8 — "No changes to `packages/workflow-engine/`" — is not held.** That decision rested on "every capability needed already exists". It does not: 09's locked decisions 7 and 9 require a diagnosis of `flaky` / `infra-dependent` / `upstream-broken` to skip the `fix` phase while the run still records `succeeded`, and the engine had no phase-level conditional skip. A minimal `skip_if:` was added, reusing the scheduler's existing non-failing-skip mechanism and `loop-eval.ts`'s existing safe expression evaluator.

<!-- PHASES -->

## Pre-existing bugs found during execution (not introduced by this work)

- **The dispatcher's double-dispatch guard has never worked.** `dispatcher.ts:133` calls `db.executions.isRunning(handler, triggerId)` with a bare workflow name (`"pr-fix"`) and a bare issue number (`"42"`), but every phase row is written by `phase-executor.ts` with `skill = "<workflow>:<phase>"` and `trigger_id = "owner/repo#N"`. No row can ever match on both predicates, so the guard whose comment reads *"Guard against double-dispatching the same work"* has been a no-op for every workflow. Phase 3′'s PR-scoped lock replaces it, and this is why that lock matters more than the plan assumed.
- **`apps/www/src/pages/docs/configuration.astro` documents a `WORKFLOW_DIR` env var that does not exist.** `spec/02-configuration.md` states explicitly that there is no `WORKFLOW_DIR` and no `workflowDir` field — assets resolve layer-wise. Left as-is (out of scope), but it misleads anyone setting up an instance.
- **The site claimed the wrong phase counts for both fix workflows** — `pr-fix` was described as single-phase and the workflows overview card said "1 phase", while the `dependabot-ci-fix` card claimed "2 phases" when it had one. Corrected as part of Phase 2's docs.
- **The dashboard's mirrored `RepoMergedConfig` / `RepoConfigSources` types** (`apps/server/dashboard/src/api.ts`) do not carry the new policy blocks, so the per-repo Config tab will not render them. Display-only; recorded as a follow-up.

## Phase 6 — the `fix:` / `dependencies:` config blocks

- **`dependencies.autoMergeMaxImpact` ships `medium`**, so low- and medium-impact major bumps auto-merge on every deployment (see the table above). Set it to `none` in an overlay to keep today's escalate-every-major behaviour.
- **`review.trigger: after-checks` and `review.skipDraft: true` ship packaged** (see the table above). Inert until Phase 7 consumes them.
- **`dependencies.minSettledChecks: 1` is operator-only** and cannot be lowered by a repo. A genuinely CI-less repo therefore stops auto-merging dependency PRs on upgrade. This is deliberate: §6.2's `max(repo, operator)` clamp would have welded the escape hatch shut in the direction people need it, so the CI-less case is handled on the fact (`checksState === "none"` blocks *major* auto-merge only) rather than on the policy.
- **`fix.maxCostUsd` ships at `5.0`, on** — a cumulative per-PR ceiling across attempts. A brake that ships disconnected is not a brake.
- **`review.afterChecks` does not exist.** The `passing` variant was a footgun in combination with the fix loop: a PR we gave up on never goes green, so the escalated PRs — the ones most needing human eyes — would have been the only ones never reviewed.
- **New repo-settable keys**: `fix`, `dependencies` and `review` are appended to `DEFAULT_REPO_CONFIG_ALLOW_KEYS`. A repo may only ever be *more* conservative; a loosening leaf is dropped with a new `policy-downgrade` warning rather than failing the run.
- **`fix` and `dependencies` are seeded onto the template context; `review` deliberately is not.** `renderTemplate`'s `walkKey` resolves a dotted key against `ctx` before falling back to `ctx.phaseOutputs`, and `build.yaml`'s reviewer loop declares `output_var: review`, read by `prompts/pr.md` as `{{#if !review.approved}}` / `{{review.cycles}}`. A top-level `review` object would have shadowed it and made every build PR body claim unresolved reviewer issues. The same hazard applies to any future overlay workflow using `output_var: fix` or `output_var: dependencies`.

## Phase 1 — real CI evidence (`Actions: read`)

- **The GitHub App requests a new optional permission, `Actions: read`.** Every existing installation must re-consent to grant it. Nothing hard-fails without it — the CI failure report degrades to check-run annotations exactly as before — but the degradation is now *stated* in `{{ciSection}}` instead of being invisible, and diagnosis quality is capped at annotations until it is granted.
- **`agentic-pi`'s `read` profile grew from 18 tools to 21** (`github_list_workflow_runs`, `github_list_workflow_run_jobs`, `github_get_job_logs`), and every other profile by the same three. Any consumer pinning a profile's tool count sees the change.
- **Follow-up, not done here:** `packages/agentic-pi/test/fixtures/phase2-smoke-github-read-profile.jsonl` records `toolCount: 18` and is now one number stale. It is captured contract evidence from a real run, so it must be re-captured with the smoke command in `packages/agentic-pi/CLAUDE.md` (needs a model API key + App credentials) rather than hand-edited. No test asserts against it today.

## Phase 2 — the `fixing` skill and the `diagnose` phase

- **`pr-fix` and `dependabot-ci-fix` gained a `diagnose` phase.** Both now run `diagnose` → `fix` instead of `fix` alone, so every fix run costs one extra (cheap) agent call. The phase resolves `{{models.diagnose}}`, which is unset in `config/default.yaml` and therefore falls through to `models.default`; an operator wanting the cost saving should pin a cheap model under `models.diagnose` in their overlay.
- **Both phases now require a completion marker.** `diagnose` fails without `DIAGNOSIS_COMPLETE`, `fix` without `CI_FIX_COMPLETE`. `dependabot-ci-fix` previously had no postcondition at all, so a run that inspected the PR and stopped without pushing or labelling reported green; it now reports red. An overlay that forks `prompts/pr-fix.md` or `prompts/dependabot-ci-fix.md` **must add the marker instruction** or every run of that workflow fails.
- **`skip_if` is a new phase-level field** (see the deviation above). It takes one expression or a list, OR-ed, in the `until:` grammar, and produces the same non-failing skip as `requires_sandbox` — the run still records `succeeded`. Purely additive: phases without it behave exactly as before.
- **A `flaky` / `infra-dependent` / `upstream-broken` diagnosis no longer reaches the `fix` phase**, so `messages.on_failure` ("leaving it for a human") no longer posts on those outcomes and no sandbox is provisioned for them.
- **`skills/fixing/` is new**, and both fix workflows moved from `skill: building` to `skills: [fixing, building]`. An overlay that overrides `skills/building/SKILL.md` is unaffected; one that pinned the phase's `skill:` field in a forked workflow YAML keeps its own value.
