# Phase 8 — Remove the pr-review and issue-triage backstop crons

> # ⛔ DEFERRED — do not execute
>
> Superseded by [09-state-machine.md](09-state-machine.md) §S5. Drawing the fix
> and review state machines together showed `check-prs-awaiting-review` is
> load-bearing in three ways this document does not account for:
>
> 1. It is the **release mechanism** for the five fix terminals that push
>    nothing (attempts exhausted, `infra-dependent`, `flaky`, `upstream-broken`,
>    crash) — no new commit means no further `check_suite`, so without it those
>    PRs are never reviewed. They are the PRs most needing human eyes.
> 2. It is the **de facto repair** for `last-light/review` checks stranded
>    `in_progress` by any deploy, since a fresh run supersedes them. (09's
>    durable check lifecycle makes this redundant — the right order to fix it
>    in, but it must land first.)
> 3. It is the **re-pickup** that makes the PR-scoped run lock's
>    drop-on-conflict safe. A future Phase 8 must convert dropped-on-lock into
>    queued-on-lock before removing any cron.
>
> **Lift out and do independently** — both are worth it on their own merits:
> mapping `pull_request.ready_for_review` → `pr.opened` semantics (row 1 of the
> audit below), and a non-silent outcome for a queued run that expires (row 2).
>
> Its §7.4b supersession is **withdrawn**: with the cron alive,
> `condition.unless: webhooksEnabled` needs generalising after all.

**Risk: low to implement, medium in consequence.** Pairs with
[07-review-triggers.md](07-review-triggers.md); ~~supersedes its §7.4b~~.

Decision: **rely fully on webhooks and explicit requests** for PR review and
issue triage. Delete the two polling crons that exist only as
webhooks-disabled fallbacks.

## What goes

| Thing | Path |
|---|---|
| The review cron | `apps/server/workflows/cron-review.yaml` (`check-prs-awaiting-review`, `*/30 * * * *`) |
| The triage cron | `apps/server/workflows/cron-triage.yaml` (`triage-new-issues`, `*/15 * * * *`) |
| Review discovery | `apps/server/src/cron/review-discovery.ts` (124 lines) |
| Its test | `apps/server/tests/cron/review-discovery.test.ts` (5 cases) |
| The discoverer registration | the `"prs-awaiting-review"` entry in `PR_DISCOVERERS`, `apps/server/src/index.ts:792-808`, plus the `discoverPrsAwaitingReview` import |

## What stays

The four crons that are genuinely *scheduled work*, not webhook substitutes:

- `weekly-health-report` → `repo-health` (Mon 09:00)
- `weekly-security-scan` → `security-review` (Mon 10:00)
- `merge-green-dependency-prs` → `dependabot-pr-merge` (daily 14:00)
- `fix-red-dependency-prs` → `dependabot-ci-fix` (daily 15:00)

The two dependency crons are **not** `unless: webhooksEnabled` — they are
additive backstops that deliberately run alongside the webhooks, and both
`tests/workflows/dependabot-{ci-fix,pr-merge}.test.ts` assert exactly that. They
are unaffected.

`dependabot-discovery.ts` stays (both dependency sweeps use it). Only
`review-discovery.ts` goes.

## The dead-code cascade

`cron-review.yaml` and `cron-triage.yaml` are the **only two** users of
`condition: { unless: webhooksEnabled }`. (`cron-dependabot-*.yaml` merely
mention it in a NOTE explaining they deliberately *don't* have it.) Removing
both leaves the mechanism with zero production consumers:

- `apps/server/src/cron/jobs.ts:37-40` — the filter itself.
- `apps/server/src/index.ts:1245` — `const webhooksEnabled = !!(config.webhookSecret && config.githubApp)` and its use at L1247.
- `CronWorkflowSchema.condition` in `packages/workflow-engine/src/core/schema.ts:484-488`.

**Recommendation: keep the mechanism, remove the inert config key.** An overlay
can define its own crons and may legitimately want the condition, and
`tests/workflows/loader.test.ts:211-217` keeps it exercised by fixture. It costs
four lines. But `config/default.yaml:195`'s `cron.webhooksEnabledCondition: true`
**is** genuinely dead — `normalizeFileConfig` never reads it — so delete that
key and its block.

Also retired: **`mode: scan` loses its last consumer.** `cron-triage.yaml` is
the only remaining `context: { mode: scan }`, and nothing reads it — not
`issue-triage.yaml`, not `skills/issue-triage/SKILL.md`, not the cron runner. It
is a vestige of the agent-sweep pattern already replaced for review and
dependencies (`review-discovery.ts:11-15` documents why: the sweep agent
couldn't re-mint auth, couldn't pre-clone, and had no way to hand its chosen PR
to `post-review`). Drop the remaining `mode: scan` references in comments while
removing it.

## Consequences — accept these explicitly

This is a deliberate reduction in coverage. Each of these becomes true:

1. **Issues opened while the server is down are never triaged.** There is no
   catch-up sweep. GitHub does not redeliver a webhook that was never
   attempted... it *does* retry failed deliveries and offers manual redelivery
   in the App's Advanced tab, but an issue opened during a multi-hour outage
   will simply have been missed. The recovery is a human asking, or a manual
   redelivery.
2. **PRs opened while the server is down are never reviewed.** Same reasoning.
   `@<botName> review` and the Check Run's Re-run button are the manual
   recoveries.
3. **A deployment without webhooks loses triage and review entirely.** That is
   precisely the population `unless: webhooksEnabled` served — a Slack/CLI-only
   install. Confirm no such deployment exists before merging; if one does, it
   needs the crons or an explicit migration note.
4. **Phase 7's `after-checks` mode loses its safety net.** A deferred review
   waits for `check_suite.completed`; if that delivery is dropped, the review
   never runs and — with `postsCheck` on — a `queued` check sits on the PR
   indefinitely. That is the sharpest interaction between this phase and
   Phase 7, and it is why §7.4b (generalise `condition.unless` so the review
   cron can run with webhooks on) is **superseded**: there is no review cron to
   generalise for.

   Mitigations, in order of cost: GitHub's at-least-once delivery plus manual
   redelivery; the Re-run button; `@<botName> review`. If that proves too thin
   in practice, the cheapest re-addition is not the old cron but a **bounded
   reconciliation** — on boot, and hourly, look for PRs carrying a `queued`
   `last-light/review` check older than N minutes and settle them. That is a
   different shape from the removed sweep (it reconciles *our own* stuck state
   rather than polling GitHub for work) and should be its own issue, not this
   phase.

## Prerequisite — the webhook and comment paths become load-bearing

Removing the sweeps means every scenario they silently covered must be handled
by a webhook or an explicit request. This audit is the gate on the phase: the
**blocking** rows must ship with it or before it.

| # | Scenario | Covered today? | Resolution |
|---|---|---|---|
| 1 | **Draft PR marked ready for review** | **No — blocking.** `pull_request.ready_for_review` is unmapped (`github-webhook.ts:311-326` handles only `opened`/`synchronize`/`reopened`). Combined with Phase 7's `skipDraft: true`, the `opened` event is skipped *and* the ready event never arrives — such a PR gets **no review at all** | Map `ready_for_review` → `pr.opened` semantics. Phase 7 §7.3 lists it as an addition; this phase makes it **mandatory** |
| 2 | **A queued run expiring** | **No — blocking-ish.** `expireStaleRuns` (`workflows/admission.ts:141-155`) cancels any run queued longer than `maxQueueWaitMs` (default 1 h). The cron was the de-facto re-pickup; without it that work is dropped permanently | Decide one: raise the window, re-dispatch on expiry instead of cancelling, or at minimum notify on the PR/issue so it is visible. Silent drop is not acceptable once nothing sweeps |
| 3 | **Check lifecycle on non-webhook routes** | **No — blocking for Phase 7.** `postsCheck` fires only for `pr.opened`/`synchronize`/`reopened` (Phase 7 §7.4a) | Lift it, per §7.4a. Without the cron there is no second chance to resolve a stuck `queued` check |
| 4 | **A failed or crashed run** | No auto-retry. The cron re-picked it, because `getLatestBotReview` found no review at that head SHA | Manual: dashboard **Retry** / `lastlight workflow retry <id>`. Both already exist and are ledger-driven. Document as the recovery; consider a bounded auto-retry later |
| 5 | **PR or issue created during an outage** | No | GitHub retries failed deliveries and offers manual redelivery in the App's Advanced tab; otherwise `@<botName> review` / a comment to re-triage |
| 6 | **A repo newly added to the managed list** | No backlog sweep | Accept and document — its existing open PRs and issues are never picked up. A one-off `lastlight` CLI dispatch is the workaround |
| 7 | **Bot-authored PRs (renovate, github-actions, …)** | Filtered at the webhook — `isBotAuthoredPr` drops any author ending `[bot]` (`github-webhook.ts:174-183`). The cron filtered only `authorLogin !== botLogin`, so it *would* have reviewed them | A real divergence. Either accept (dependency PRs are handled by the dependency workflows anyway) or narrow the filter to `botLogin` only. Decide explicitly rather than inheriting it |
| 8 | **A non-maintainer requesting a review** | No — the comment path requires `MAINTAINER_ROLES` = OWNER/MEMBER/COLLABORATOR (`router.ts:75`) and an exact `@<botName>` mention with no legacy fallback | Accept; it is a deliberate abuse gate |
| 9 | **Re-triaging an issue** | **Yes** — the comment path already re-triages on a `needs-info` reply, an author reply with substantive info, or a maintainer request (`router.ts:335-347`) | No action |
| 10 | **Phase 7 `after-checks` with a dropped `check_suite.completed`** | No | See "Consequences" §4 — the bounded reconciliation idea, as its own issue |

Rows 1-3 are the ones that turn "reduced coverage" into "silently broken", so
treat them as part of this phase's definition of done rather than follow-ups.

## Migration concerns

**Orphaned `cron_overrides` rows.** A deployment may have DB rows keyed to
`check-prs-awaiting-review` / `triage-new-issues`. `getJobs` builds from the
YAML and applies overrides on top, so an override for a cron that no longer
exists is inert — harmless, but it will linger in the admin Crons pane's data
if that reads the table directly. Either leave them (documented) or delete them
in a one-line migration. Prefer leaving them: they are self-evidently harmless
and a migration that deletes rows is a worse trade.

**Silent per-repo and overlay votes.** Under #180 a managed repo may have
`crons: { enable: [check-prs-awaiting-review] }` in its `.lastlight/lastlight.yml`,
and an operator overlay may name either cron in `crons.disable`. After this
change those entries **silently do nothing** — the repo believes it opted in.

`repoCronPrefs` / `resolveCronRepos` (`apps/server/src/cron/repo-crons.ts`)
should therefore **warn on an unknown cron name**, surfaced as a
`RepoConfigWarning` like every other repo-config rejection. This is a small
addition and the honest one: the per-repo config contract is "warn, drop the
offending keys, run anyway", and a vote for a cron that does not exist is
exactly such a key. Worth doing here rather than deferring — this phase is what
creates the first population of them.

## Files

| File | Change |
|---|---|
| `apps/server/workflows/cron-review.yaml` | delete |
| `apps/server/workflows/cron-triage.yaml` | delete |
| `apps/server/src/cron/review-discovery.ts` | delete |
| `apps/server/tests/cron/review-discovery.test.ts` | delete |
| `apps/server/src/index.ts` | drop the `prs-awaiting-review` discoverer + import; leave `webhooksEnabled` (see cascade) |
| `apps/server/config/default.yaml` | delete the inert `cron.webhooksEnabledCondition` block (L194-195) |
| `apps/server/src/cron/repo-crons.ts` | warn on an unknown cron name |
| `packages/shared/src/repo-config-schema.ts` | a warning code for it (reuse `invalid-value`, or add `unknown-cron`) |
| `packages/cli/src/repo-cli.ts` | `WARNING_LABEL` entry if a new code is added |

## Tests

- **Delete** `tests/cron/review-discovery.test.ts`.
- **Update** `tests/workflows/issue-triage.test.ts:30-40` — it asserts
  `getCronWorkflows().find(c => c.workflow === "issue-triage")` exists, is named
  `triage-new-issues`, and has `context.mode === "scan"`. Replace with the
  inverse assertion: **no cron dispatches `issue-triage`**. Keep its sibling
  marker test — the marker still matters for webhook runs.
- **Add** the same inverse assertion for `pr-review`, so neither cron can be
  reintroduced by accident.
- `tests/workflows/loader.test.ts:211-217` uses an inline `triage-new-issues`
  fixture to exercise `condition.unless` parsing — **keep it**, it is a schema
  test and is now the only coverage of a mechanism with no production user.
- `tests/cron/control-keys.test.ts` and `discovery-cron-optout.test.ts` — check
  for references to the removed cron names.
- Add a `repo-crons` test for the unknown-cron-name warning.

## Docs

- `apps/server/spec/03-integrations.md` — the cron table (L108 job-source row,
  L133-141 the dependency-backstop note) and any listing of the two crons.
- `apps/server/CLAUDE.md:248` — the `cron/` layout comment naming
  `review-discovery.ts`.
- `apps/www/src/pages/docs/` — the crons/workflows pages listing the schedule
  set; `docs/workflows/pr-review.astro` and the triage page if they mention a
  sweep.
- Release notes: this is a **behaviour reduction** and must be called out
  alongside Phase 7's `skipDraft` change.

## Done when

- No cron dispatches `pr-review` or `issue-triage`, and a test asserts it.
- `review-discovery.ts` and its test are gone; `dependabot-discovery.ts` is
  untouched.
- A repo voting for a removed cron gets a warning instead of silence.
- The docs no longer describe a review or triage sweep.
- **Rows 1-3 of the prerequisite audit are closed**: `ready_for_review` is
  mapped, an expiring queued run is not silently dropped, and the
  `last-light/review` check is posted and completed on every route.
