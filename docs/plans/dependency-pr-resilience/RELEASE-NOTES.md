# Dependency-PR resilience (#251, #252)

Assembled from [BREAKING-CHANGES.md](BREAKING-CHANGES.md), which is the per-phase record. This is the operator-facing view: what changes in your repos on upgrade, what you have to do about it, and what you can turn off.

## What this release does

Two issues, one root cause. [#251](https://github.com/nearform/lastlight/issues/251) is that the PR-fixing loop gives up after one try; [#252](https://github.com/nearform/lastlight/issues/252) is that every major dependency bump gets escalated to a human whatever it is. Both were the same defect wearing different clothes: **the policy was prose inside a prompt.** There was no attempt counter anywhere in the system, no code-level signal about *why* CI failed, no rule about bump magnitude outside one clause in a prompt, and no dial an operator could turn. So the only way to change the behaviour was to fork a prompt.

Three things are genuinely new. **The fix loop diagnoses before it retries, and is bounded.** `pr-fix` and `dependabot-ci-fix` now run a cheap `diagnose` phase that classifies the failure as `reproducible`, `env-mismatch`, `flaky`, `infra-dependent` or `upstream-broken`, and only the classes another attempt can help with reach the `fix` phase. Attempts are counted across runs per PR, capped by `fix.maxAttempts` and a cumulative dollar ceiling, and a PR the bot gives up on gets a label and an explanatory comment instead of silence. **Major bumps are classified by impact, not by semver magnitude.** A major is judged against a `dependency-impact` rubric and auto-merges at or below `dependencies.autoMergeMaxImpact`, so a `@types/*` major and a framework rewrite stop being the same event. **`pr-review` gets a trigger policy.** It no longer fires per push; it runs once per settled head SHA and can cite what CI actually said.

Underneath those, the state a PR is in is now resolved **once**, at the dispatch choke point, and every policy question is a pure function over that one snapshot. Previously it was read from six sites, each fetching an overlapping subset and each free to disagree. That restructure is what closes three latent defects (a PR that would have latched permanently dead on `upstream-broken`; a human's red PR routed into the dependency-bump workflow; major bumps auto-merging ungated on repos with no required checks), and it also replaces a per-PR concurrency guard that **has never worked** — it was queried with a bare workflow name and a bare issue number while every ledger row is written with `skill = "<workflow>:<phase>"` and `trigger_id = "owner/repo#N"`, so no row could ever match and nothing has ever stopped two agents cloning and pushing the same branch at once.

## Action required

### 1. Re-consent the GitHub App for `Actions: read`

The App now requests **`Actions: read`** (optional). **Every existing installation must re-consent.** Nothing hard-fails without it — the CI failure report falls back to check-run annotations exactly as it always has — but diagnosis quality is capped at annotations until it is granted, and annotations are usually truncated. The degradation is at least now *stated*: `{{ciSection}}` is prefixed with a `NOTE: GitHub Actions job logs are unavailable…` line rather than silently substituting worse evidence. The notice is suppressed when none of the failed checks is an Actions job, so a CircleCI-only repo is not told to grant a permission that would not help it.

To grant it: in the GitHub App's settings, **Permissions & events → Repository permissions → Actions → Read-only**, save. GitHub then notifies each installation's owner to accept the new permission; accept it on every org/account where Last Light is installed. `Actions: read` is **not** `Workflows: write` — the latter only governs pushing files under `.github/workflows/`.

The same permission backs three new agent tools in agentic-pi (`github_list_workflow_runs`, `github_list_workflow_run_jobs`, `github_get_job_logs`), which return `{ ok: false, reason }` rather than throwing when it is absent.

### 2. Audit your overlay's forks

Several packaged assets changed in ways a fork will not pick up. One of them **fails every run**; the rest fail silently, which is worse to diagnose.

- **Hard failure.** A fork of `workflows/prompts/pr-fix.md` or `workflows/prompts/dependabot-ci-fix.md` **must add the `CI_FIX_COMPLETE` marker instruction**, and a fork of the diagnose prompt must emit `DIAGNOSIS_COMPLETE`. Both phases now require the marker as a postcondition; a forked prompt that never emits it fails on every run.
- **Silent.** A fork of `skills/fixing/SKILL.md` still names the old verify-script path (`../.lastlight-verify.sh`, at the workspace root) — the gate script now lives at `<repo>/.lastlight-verify.sh`, and a fork pointing at the old path means the local gate never runs. The same fork will neither write nor read the new per-PR notes journal.
- **Silent.** A fork of either fix workflow YAML that **reworded** the `phaseOutputs.diagnosis.contains('class=flaky')` expression in `skip_if:` never gets the flaky promotion: the harness matches that string *literally* to decide when a repeated `flaky` verdict should be promoted to a real attempt, so a reworded fork defers on `flaky` forever with no error.
- **Silent.** A fork of `workflows/dependabot-pr-merge.yaml` keeps its own `skill: code-review` and runs the new merge prompt **without** the `dependency-impact` rubric. The prompt still states the tiers and the unknown⇒high rule so it degrades rather than breaks, but the classification will be worse than it should be.
- **Silent.** A fork of `skills/pr-review/SKILL.md` (now 7.1.0) will not read the CI evidence the review can now cite, and keeps a dead `mode: scan` branch the model still pays to read.
(An overlay can only fork workflows, prompts, skills and agent-context — never `src/`, and never a workflow's YAML from a *repo* layer. If you are carrying a patched core checkout rather than an overlay, note additionally that `ReviewDiscoveryClient` lost `getLatestBotReview`: the review cron no longer holds policy, it only finds candidates.)

### 3. Nothing else

There is no migration, no schema change to apply, and no config you must write. Every new key ships with a default.

## Behaviour that changes on upgrade, with no action

### The fix loop (`pr-fix`, `dependabot-ci-fix`)

**A red PR now gets up to three fix attempts instead of one.** `fix.maxAttempts: 3` counts attempts across runs, scoped to the problem: an unchanged head or a head we authored increments it, and a push by anyone else resets it to 1. A crash never consumes an attempt — `failed` means malfunction, and only a completed diagnosis charges budget. The ceiling is `fix.maxAttempts`; the hard brake is `fix.maxCostUsd: 5.0`, cumulative across attempts for one PR, enforced at dispatch before a sandbox is provisioned. Set `fix.maxAttempts: 1` to restore one-shot behaviour; set `fix.maxCostUsd: null` to remove the dollar ceiling (not recommended — a brake that ships disconnected is not a brake).

**Every fix run costs one extra, cheap agent call.** Both workflows now run `diagnose` → `fix`. The phase resolves `{{models.diagnose}}`, which ships **unset** and therefore falls through to `models.default`. If you want the cost saving, pin a cheap model under `models.diagnose` in your overlay. (It ships unset deliberately: pinning an Anthropic model here would break a deployment that has pointed `models.default` at another provider.)

**Failures no retry can fix no longer reach the fix phase at all.** A `flaky`, `infra-dependent` or `upstream-broken` diagnosis skips it — the run still records `succeeded`, no sandbox is provisioned, and `messages.on_failure` ("leaving it for a human") no longer posts on those outcomes. You will see fewer "gave up" messages and fewer sandboxes. A repeated `flaky` verdict does not defer forever: after `fix.maxFlakyDeferrals: 2` consecutive flaky verdicts on the same problem the third is promoted to `reproducible` and a real attempt is spent, on the reasoning that three flaky reports running is an intermittent real failure. `infra-dependent` and `upstream-broken` skip unconditionally regardless of the count.

**A prior diagnosis outside `fix.retryableClasses` now stops dispatch on the next event.** With the packaged `[reproducible, env-mismatch]` that means an `infra-dependent` PR escalates immediately rather than spending its remaining attempts. Narrowing `retryableClasses` in an overlay now has teeth at dispatch time, not only inside a run.

**A PR the bot gives up on gets a label and a comment where it previously got silence.** Three terminal cases — attempts exhausted, cost ceiling exhausted, and a last diagnosis outside `retryableClasses` — now apply `requires-human` and post **one** comment naming the case, the attempts spent, and each attempt's `class=` / `cause=`. The other skips stay silent on purpose: `upstream-broken` (not this PR's fault, self-heals), fork PRs (already commented), `human-hold` / already-escalated, and duplicate deliveries. Anything scripting off `requires-human` should not expect it on those.

**A `requires-human` label that predates the upgrade is not read as a permanent human hold, and you will see nothing on those PRs.** The state the bot honours is "*we* escalated", and the label alone is not it. A label on a PR we have run against before resolves as **our** escalation, pinned to the head SHA our last run saw; only a label on a PR no run of ours has ever touched can be a maintainer's hand-applied hold, which stays permanent. So on the first sweep after the upgrade, an already-exhausted open PR is skipped **silently** as already-escalated — no second label, no comment — and the moment anyone else pushes to it the loop re-arms with no label to remove. Expect the new label + comment on PRs the *new* loop gives up on, not on the backlog.

**Attempts 2 and up now actually use `models["pr-fix-retry"]`.** That key was documented but inert. Every attempt above `fix.escalateModelAfterAttempt: 1` now runs the `fix` phase on it. **A deployment that already set that key as a no-op starts paying for that model on retries.** Operators who never set it see no change at any attempt number. The substitution is applied before `context.models` is persisted, so the admin panel and a resumed run both show the model the attempt actually used.

**Inside one attempt, the fix phase now loops against a gate.** It is a two-iteration loop with a 900-second budget: the agent writes `<repo>/.lastlight-verify.sh` (the repo's real build/test command), the harness runs it, and only a green gate authorises a push. **No gate is now an explicit red** — an absent script exits non-zero deliberately and `gate=skipped` never authorises a push, where previously that only worked by accident of exit codes. The harness deletes the script at the start of every attempt and re-registers its `.git/info/exclude` entry, because the fix family shares one workspace per PR and a stale gate is worse than no gate: it passes green against the wrong commands.

**`dependabot-ci-fix` runs that used to report green now report red when they did nothing.** It previously had no postcondition at all, so a run that inspected the PR and stopped without pushing or labelling was recorded as a success. It now requires `CI_FIX_COMPLETE`.

**Fix prompts carry a per-PR journal.** The agent can append `<kind>: <one line>` notes to `.lastlight-notes` in the checkout; the harness drains them onto the PR's state and renders them back into all three fix prompts as `{{priorNotes}}`, bounded at 4 KiB. Notes are hints only — no decision function reads them, they are flattened to one line on ingest, and a note containing `class=`, `DIAGNOSIS_COMPLETE` or `CI_FIX_COMPLETE` is rejected outright so it cannot forge a parsed token. A head SHA change authored by someone else marks the journal `STALE` rather than clearing it. Practical effect: fix prompts get slightly longer on PRs with a history.

**The run list gains rows for PRs that never ran a phase.** An escalating skip writes a `workflow_runs` row (`succeeded`, no phases, `current_phase: "escalated"`). This is load-bearing, not cosmetic — the escalation SHA is read back off that row, and without it `requires-human` would read as a *human's* permanent hold on the next event and latch the PR dead. Side effect: per-SHA dedup also sees these rows.

### PR routing and concurrency

**`pr-fix` now runs on human PRs that the bot has pushed to.** `pr.checks_failed` previously fired only for dependency PRs, so `pr-fix` could push a fix and never learn whether the build went green. It now also fires when the head commit's author is the bot itself. It stays bounded — it cannot fire on a human PR the bot has never touched — but **this is the one change that can raise run volume on non-dependency PRs.** Watch it after rollout. The event only fires once the head SHA's checks have *fully settled red*, so a repo with several check-reporting apps gets one event per SHA rather than one per suite.

**That route is now deterministic rather than classifier-guessed**: a dependency PR goes to `dependabot-ci-fix`, everything else to `pr-fix`. Previously it went through the LLM classifier, which could only ever land on `dependabot-ci-fix` — `pr-fix.yaml` has no `classification:` block and was structurally unselectable — so a human's red PR would have run a dependency-bump prompt with the `dependency-*` label vocabulary. One classifier call per red PR is also saved.

**One run per PR, across every PR-scoped workflow.** The loser is dropped with a reason rather than queued (every dropped case has a cron re-pickup). If the losing dispatch was an explicit `@bot` request, the requester gets a reply saying a run is already in flight. This replaces the guard described above that never matched a row.

**Three latent bugs are fixed that changed results silently.** The cron fan-out bypassed context enrichment, so every nightly fix run had an empty `{{ciSection}}` and no fork-PR guard; `headSha` was dropped from cron-dispatched runs, weakening the per-SHA dedup; and `baseBranch` was the repo's default branch rather than the PR's real base, so a PR targeting a release branch was merged against the wrong base.

### Dependency PR merges

**Low- and medium-impact major bumps now merge without a human.** Previously every major became `dependency-functional` + `requires-human`. A major is now assessed against the `dependency-impact` rubric and auto-merges at or below `dependencies.autoMergeMaxImpact`, which ships **`medium`**. High-impact majors keep `requires-human`. Set `autoMergeMaxImpact: none` in your overlay to keep today's escalate-every-major behaviour, or `low` for a more conservative rollout.

**`autoMergeMaxImpact` is an instruction to the agent, not a code-enforced ceiling — read it that way before you raise it.** The impact tier is the model's own judgement, self-reported in the `ASSESSMENT_COMPLETE` marker, and the ceiling reaches the run only as prompt text: no code parses `impact=`, compares it to `autoMergeMaxImpact`, or withholds the merge capability from a phase whose tier came back above the ceiling. The dispatch gate refuses a merge run only while checks are still `pending` (plus the human-hold, already-escalated and duplicate-delivery guards), so a failing PR still reaches the phase that holds the merge tools. What *is* enforced in code is the settled-checks precondition: `mayMerge` is computed from `dependencies.requireSettledChecks` and `dependencies.minSettledChecks` before the run starts and handed to the prompt as a decided verdict, and the merge prompt is told not to re-derive it. Merging has always been agent-driven, so this is not a regression — but #252 widens what can land unreviewed, so treat the tier ceiling as policy the agent is asked to honour and the settled-checks gate as the part that holds independently of it.

**`dependency-trivial` changed meaning.** It now means *safe to land without a human*, not *small* — so a major bump can carry it. Anything downstream that read `dependency-trivial` as "not a major" is wrong now; the impact labels are how you tell.

**Three labels are created on your managed repos** the first time a major is assessed: `dependency-major-low` (`0e8a16`), `dependency-major-medium` (`fbca04`), `dependency-major-high` (`b60205`). Created via `github_ensure_labels`, exactly like the existing three.

**One extra comment per auto-merged major**, recording the impact tier and the evidence — the only durable answer to "why did this land unreviewed". Turn it off with `dependencies.auditComment: false`. It counts toward the prompt's existing two-comment maximum and is skipped when the impact label was already on the PR, or when an equivalent comment is already there.

**A PR whose checks are still running or failing no longer gets auto-merge enabled optimistically.** The old path enabled GitHub auto-merge and stopped; it now stops. The settled-checks webhook and the daily sweep bring the PR back once CI has spoken, so nothing is lost — but the "enabled auto-merge, waiting for CI" state disappears from Last Light's behaviour. A `blocked` PR whose checks are *green* (a required review outstanding) still gets auto-merge, which is the case auto-merge exists for.

**A repository with no checks at all stops having its dependency PRs merged automatically — for every bump, not only majors.** `dependencies.minSettledChecks: 1` is the gate, and it is **operator-only**: a repo cannot lower it. This is a real reduction in capability for a genuinely CI-less repo, and it is deliberate — the alternative clamp (`max(repo, operator)`) would have welded the escape hatch shut in the direction people actually need it. If you manage repos with no CI and want the old behaviour, set `dependencies.minSettledChecks: 0` in your overlay.

**`requireSettledChecks: false` and a raised `minSettledChecks` now behave as documented.** The merge prompt previously restated the gate as prose and disagreed with the code predicate in both directions: an operator raising `minSettledChecks` was told the gate was open while it was shut, and a deployment that had turned the gate *off* was still told not to merge. The prompt now reads the single `mayMerge` predicate. `mergeable_state` survives only for branch hygiene (`behind` / `dirty`) and for choosing between the two merge mechanisms.

**The `ASSESSMENT_COMPLETE` marker gained an `impact=` field**, between `verdict=` and `action=`. Anything parsing that line by field position rather than by name sees a new field.

### PR review triggers

**`pr-review` no longer fires on push.** `review.trigger` ships **`after-checks`**: the review runs once per *settled* head SHA, either colour, off a new `pr.checks_settled` event. Two consequences — the review can read and cite the CI result, and a developer pushing three commits in five minutes gets one review instead of three that were stale before they posted. This is a real behaviour reduction if you relied on an immediate review on `pr.opened`: **there is now a wait for CI before any review appears at all, and on a repo whose CI never settles, no review appears.** Set `review.trigger: eager` in your overlay to keep today's behaviour exactly.

**Draft PRs are no longer reviewed on the webhook path.** `review.skipDraft: true` makes the webhook match what the review cron has always done. `ready_for_review` is the event that un-defers them. Set `skipDraft: false` at the operator layer to restore (a repo may only ever turn it *on*).

**Every webhook-enabled deployment gains a cron it did not have.** `check-prs-awaiting-review` previously carried `condition.unless: webhooksEnabled` and is now unconditional — every 30 minutes, bounded by `maxPerRepo: 25` and the global admission cap. It is load-bearing three times over: it is the release mechanism for every PR whose fix chain ended without pushing a commit (attempts exhausted, `infra-dependent`, a flaky deferral, `upstream-broken`, or a crash — no new commit exists, so no further `check_suite` will ever fire); it is the re-pickup that makes the PR-scoped lock's drop-on-conflict safe; and it supersedes a stranded placeholder check.

**The connector emits three new event types**, each routable: `pr.checks_settled` (`routes.github.pr_checks_settled`), `pr.labeled` (`pr_labeled`, carrying `addedLabel`) and `pr.review_requested` (`pr_review_requested`, carrying `requestedReviewer`). All three default to `pr-review` and each falls back to `routes.github.pr_review`, so an overlay that already pinned that one keeps working with no edit. `pr.checks_settled` is emitted **only** under `after-checks` — emitting is what costs event volume.

**`labeled` deliveries now reach `normalize()`.** They were previously dropped as an ignored action. The router hard-ignores every PR label that is not `review.requestLabel`, so the widening costs a normalize call rather than a dispatch — but a deployment counting webhook deliveries by response body sees `{ filtered: true, reason: "unmapped event" }` where it used to see `{ filtered: true, reason: "action=labeled" }`.

**Pressing Re-run on the `last-light/review` check is now a review request**, not a synchronize. A Re-run on anybody else's check still means "the checks changed" and still maps to `pr.synchronize`.

**The check-state queries now exclude our own app**, and this is not optional. `getChecksConclusion` / `getChecksSummary` / `getBaseChecksState` take `{ excludeApp }` and every trigger-side caller passes the bot name. Without it a `last-light/review` check sitting `queued` (waiting for CI under `after-checks`) or `in_progress` pinned the aggregate at `pending`: the settle event never fired, the review never ran, the check never concluded, and a repo that made the check *required* had an unmergeable PR forever. The same loop reached `pr.checks_passed` on Dependabot PRs. Excluding our own check can never turn red into green, and commit statuses carry no app so nothing is excluded there.

**If you have `review.postsCheck` on** (it ships `false`), four things change. A cron-, comment-, Slack- or CLI-triggered review used to post no check at all and now posts one. The check no longer strands `in_progress` — its lifecycle now hangs off the run's terminal transition rather than a `.then()` on an in-memory promise, so a deploy mid-review, a queued-then-resumed run, an expiry or a crash all resolve it. Its conclusion is read from the review actually posted rather than from the run's exit code: a run that legitimately skipped concludes `neutral`, a failed run concludes `neutral` with "Review didn't complete", a cancelled run concludes `cancelled` — all of which pass branch protection, so a review that could not run never blocks a merge on its own. And a *deferred* review leaves a placeholder: `after-checks` posts a `queued` check ("Waiting for CI to finish before reviewing") so branch protection can require `last-light/review` without racing the settle event, `on-request` posts a `neutral` one whose Re-run button is the request affordance. Placeholders are posted only on PR-attention events; a plain skip (draft, already reviewed, run in flight) posts nothing at all.

**Cron `condition.unless` is now a predicate map.** An unrecognised predicate name **registers** the cron and logs one warning per boot, where previously any value other than `webhooksEnabled` was silently ignored — which meant a typo turned a conditional cron into an unconditional one. Registering is the safe direction: a silently dropped cron produces no ticks, no rows and no error.

**The review sweep's `maxPerRepo` now caps candidates offered, not runs dispatched.** `review-discovery.ts` is a pure candidate finder; its draft filter and its per-candidate review lookup moved into the one PR-state snapshot the trigger decides over. On a repo whose open PRs are mostly already reviewed, the sweep resolves a snapshot per candidate and skips at the gate. Same order of API calls, moved one layer down, in exchange for the cron holding no policy.

## New configuration

Three blocks in `config/default.yaml`, overridable in your overlay and settable by a managed repo in `.lastlight/lastlight.yml`. `fix`, `dependencies` and `review` are appended to `DEFAULT_REPO_CONFIG_ALLOW_KEYS`, so a repo may set them unless you remove the key from `repoConfig.allowKeys`. **A repo may only ever be more conservative than you are** — a loosening leaf is dropped with a `policy-downgrade` warning rather than failing the run.

```yaml
fix:
  maxAttempts: 3               # cross-run attempts per (repo, PR) before requires-human
  localIterations: 2           # within-run gate-loop iterations inside ONE attempt  [NOT WIRED]
  gateTimeoutSeconds: 900      # until_bash budget for the repo's build/test gate    [NOT WIRED]
  escalateModelAfterAttempt: 1 # attempts above this use models["pr-fix-retry"] when set
  maxCostUsd: 5.0              # cumulative ceiling across attempts for one PR; null = off
  maxFlakyDeferrals: 2         # a `flaky` verdict defers this often, then counts as reproducible
  retryableClasses: [reproducible, env-mismatch]

dependencies:
  autoMergeMaxImpact: medium   # none | low | medium | high — ceiling for a MAJOR  [PROMPT-LEVEL]
  requireSettledChecks: true   # `mayMerge` requires settled-"passing"; dispatch refuses "pending"
  minSettledChecks: 1          # `mayMerge` needs >= N settled checks; 0 = legacy
  auditComment: true           # post the evidence comment when auto-merging a major

review:
  postsCheck: false            # post the `last-light/review` Check Run
  trigger: after-checks        # eager | after-checks | on-request
  requestLabel: null           # label that requests a review in `on-request` mode
  skipDraft: true              # skip draft PRs (what the review cron has always done)
```

**Clamping, leaf by leaf.**

| Leaf | Repo may set it? | Clamp |
|---|---|---|
| `fix.maxAttempts`, `fix.localIterations`, `fix.maxFlakyDeferrals` | yes | `min(repo, operator)` |
| `fix.maxCostUsd` | yes | `min`; `null` reads as unbounded |
| `fix.retryableClasses` | yes | must be a subset of yours |
| `fix.escalateModelAfterAttempt` | **no** — operator-only | it is spend |
| `fix.gateTimeoutSeconds` | **no** — operator-only | it is a shared resource |
| `dependencies.autoMergeMaxImpact` | yes | the lower tier on `none < low < medium < high` |
| `dependencies.requireSettledChecks` | yes | add-only `true`; a `false` is dropped with a warning |
| `dependencies.auditComment` | yes | free — cosmetic |
| `dependencies.minSettledChecks` | **no** — operator-only | clamping `max(repo, operator)` would weld the escape hatch shut for a repo with no CI at all |
| `review.trigger`, `review.requestLabel` | yes | free — all three modes are equally safe, and a repo choosing `on-request` is opting itself out of automation |
| `review.skipDraft`, `review.postsCheck` | yes | add-only `true`; a repo may skip drafts and may ask for the check, but may not force reviews onto drafts or suppress a check your branch protection requires |

Two notes on the template surface. `fix` and `dependencies` are seeded onto the template context; **`review` deliberately is not** — `build.yaml`'s reviewer loop declares `output_var: review` and `prompts/pr.md` reads `{{review.approved}}` / `{{review.cycles}}`, so a top-level `review` object would have shadowed it and made every build PR body claim unresolved reviewer issues. The same hazard applies to any overlay workflow using `output_var: fix` or `output_var: dependencies`. And **`review.afterChecks` does not exist** and was not added: a "review only when checks pass" variant is a footgun next to a bounded fix loop, because a PR we gave up on never goes green, so the escalated PRs — the ones most needing human eyes — would have been the only ones never reviewed.

## Known gaps and follow-ups

- **`fix.localIterations` and `fix.gateTimeoutSeconds` are not wired.** The phase schema parses `max_iterations` and `timeout_seconds` as plain numbers, so they cannot be templated from config. The workflow YAML hardcodes `2` and `900`, matching the packaged defaults, so the shipped behaviour is correct — but **changing either config key has no effect**. To change them today, edit the workflow YAML or fork it in an overlay. This is a known gap, not a decision.
- **The dashboard's per-repo Config tab will not render the new blocks.** The dashboard's mirrored `RepoMergedConfig` / `RepoConfigSources` types (`apps/server/dashboard/src/api.ts`) do not carry `fix` / `dependencies` / `review`. Display-only; the config itself resolves and applies correctly. `lastlight repo config show` is the workaround.
- **An agentic-pi fixture is one number stale.** `packages/agentic-pi/test/fixtures/phase2-smoke-github-read-profile.jsonl` records `toolCount: 18`; the `read` profile now has 21 (and every other profile grew by the same three). It is captured contract evidence from a real run, so it must be **re-captured** with the smoke command in `packages/agentic-pi/CLAUDE.md` (which needs a model API key plus App credentials) rather than hand-edited. No test asserts against it today.
- **Neither harness-side file is handled on the kubernetes sandbox backend, and one of them is worse than inert.** `.lastlight-verify.sh` and `.lastlight-notes` both live in the checkout and are both managed by the harness on every other backend: deleted at the start of each attempt and registered in `.git/info/exclude`. The kubernetes clone-init (`src/sandbox/k8s/init-clone.ts`) writes no exclude entry and deletes neither file, while both fix prompts instruct `git add -A && git commit`. So on kubernetes the journal is never drained (there is no host-shared workspace to drain from) **and** both files are committed into the dependency PR, and a stale `.lastlight-verify.sh` survives across attempts — a gate that passes green against the wrong commands. Needs a code fix on that backend before it is used for the fix family.
- **Four fix-loop template variables are projected and read by nothing.** `renderContext` seeds `flakyPromoted`, `flakyDeferrals`, `maxFlakyDeferrals` and `ciLogsAvailable` onto every PR-scoped run's context, and no prompt references any of them. Two consequences. On the promoted third run the agent gets no signal that its `flaky` verdict will not be accepted this time, which is exactly the run the promotion exists to make useful. And `skills/fixing/SKILL.md` tells the agent to say so when the CI report says logs were unavailable, using a fact it is never handed — the `{{ciSection}}` prose notice is the only evidence it has. Prompt-side gap; the values are already there to render.
- **Overlay forks fail silently in four places** — see [Action required](#2-audit-your-overlays-forks). The two that will bite hardest are a forked `skills/fixing/SKILL.md` still naming the old verify-script path (the local gate never runs) and a forked fix workflow that reworded the `class=flaky` skip expression (the flaky promotion never fires, so the PR defers forever). A forked `dependabot-pr-merge.yaml` runs without the impact rubric.
- **`requires-human` is still an overloaded terminal flag.** "Gave up", "high-impact bump" and "auto-merge disabled on the repo" all collapse to one label that permanently suppresses cron discovery, with nothing to distinguish them and no expiry. This release improves the *comment* and carves `upstream-broken` out of labelling entirely, but a proper fix deserves its own issue.
- **The `pr-review` and `issue-triage` backstop crons stay.** Removing them was planned and is deferred: the review sweep turned out to be load-bearing in three ways (above). Two pieces of that work are lifted out as independent follow-ups — the `ready_for_review` mapping, and a policy for a queued run that expires.
- **Two verification steps could not be run in this work** because they need credentials it did not have. Neither blocks the release; both are worth doing before you trust the loop in anger. **`Actions: read`, end to end** — grant it on a dev App, confirm the CI failure report returns real log excerpts against a known-red PR, then revoke and confirm it degrades to annotations *with* the notice. This is the higher-value one: every diagnosis is capped at annotation quality until the permission is actually granted, which is the premise the whole fix loop rests on. **The evals pass** — five diagnosis classes driven through attempts 1 → 3 asserting the escalation policy per class, and a major-bump case per impact tier; it needs a model provider key and costs real spend. See `06-config.md` §6.5 items 5 and 6. (The `until_bash` sandbox integration suite *was* run, against real docker: 43 files, 372 passed.)
- **Two pre-existing documentation defects were found and left alone.** `apps/www/src/pages/docs/configuration.astro` documents a `WORKFLOW_DIR` env var that does not exist (assets resolve layer-wise; there is no such variable and no `workflowDir` field), which misleads anyone setting up an instance. And `{{#if}}` does not nest in the template engine — nested conditionals were leaking raw mustache into agent prompts. That is fixed and pinned by a test in the fix prompts; **other prompts are unaudited.**

## Upgrade recommendation

**Start with `fix.maxAttempts: 2` in your overlay, measure, then raise.** The `diagnose` phase per attempt is new spend, partly offset by not paying for install + tests on failures that no retry can fix. Measure cost per attempt from the `executions.cost_usd` rollups before going to the packaged `3`. `fix.maxCostUsd` is the hard brake and is enforced at dispatch, before a sandbox is provisioned, so it bounds the downside while you are measuring.

If you want a slower rollout of the dependency changes, `dependencies.autoMergeMaxImpact: low` gets you impact classification with only the safest majors landing unreviewed; `none` keeps today's escalate-every-major behaviour while still giving you the impact labels and the audit trail. If your team relies on a review appearing the moment a PR opens, set `review.trigger: eager` and pick up the rest.

Watch two things after rollout. **Run volume on non-dependency PRs**, because `pr.checks_failed` now fires on PRs the bot has pushed to. And **the first daily sweep** — not for a wave of labels and comments (the existing `requires-human` backlog is skipped silently as already-escalated), but because any PR that has been pushed to since our last run on it is re-armed and spends a fresh attempt.

**This needs a GitHub Release to reach a deployment.** Per [docs/RELEASING.md](../../RELEASING.md), essentially any prod-facing change does: `lastlight server update` deploys by *pulling* the `ghcr.io/nearform/lastlight-*` images, and only a GitHub Release builds them. A `config/default.yaml`, workflow, prompt or skill change reaches prod only once it is released and the overlay's `deploy.version` is bumped to the tag. This release changes all of those plus agentic-pi's tool set, so it needs **two** tags: the `vX.Y.Z` release tag (five npm packages + the images) and an `agentic-pi-vA.B.C` tag, pushed first so `agentic-pi-npm.yml` finishes before the release's `npm` job packs core and evals. Semver intent: **minor** — new user-facing capability, and the behaviour changes above are within a 0.x line. Roll out by bumping `deploy.version` in each overlay repo and pushing; the "Deploy overlay" Action pins the host's CLI to the tag and runs the update.
