# Dependency-PR resilience — implementation plan index

Make Last Light's PR-fixing loop **diagnose before it retries**, and let it
classify major dependency bumps by **impact** instead of blanket-escalating
them. Covers GitHub issues
[#251](https://github.com/nearform/lastlight/issues/251) (retry mechanism for
PRs with failing CI checks) and
[#252](https://github.com/nearform/lastlight/issues/252) (flexible rules for
major dependency bumps), which are solved together because they share a root
cause and a config surface.

This directory is the executable plan. Each phase doc is self-sufficient: an
agent with no prior context should be able to execute its phase from that doc
plus this README alone. **Nothing here has been implemented yet** — this is a
design record written for reconsideration before any code lands.

> **Read [09-state-machine.md](09-state-machine.md) before executing any
> phase.** A design review of the PR state machine found three defects that
> would otherwise have shipped (a PR latched permanently dead, human PRs routed
> into the dependency workflow, and major bumps auto-merging ungated on
> unprotected repos), and restructured Phase 3 around a single resolved
> `PrState` snapshot. It is normative and supersedes parts of Phases 3, 4, 5, 7
> and 8; each of those docs carries a pointer to the sections that apply.

## The problem

Both workflows give up too easily, for the same reason: **the policy is prose
inside a prompt**, with no code-level signal and no operator or per-repo dial.

- **`dependabot-ci-fix` is one-shot (#251).** It clones the PR head, tries one
  fix, pushes, and if stuck applies `requires-human` — which permanently
  removes the PR from the nightly sweep *and* the webhook path. The agent never
  learns whether its pushed fix turned CI green, so it is guessing. There is no
  attempt counter anywhere in the system.
- **`dependabot-pr-merge` blanket-escalates majors (#252).** The only rule
  about bump magnitude in the entire codebase is one prose conjunct in the
  TRIVIAL test (`workflows/prompts/dependabot-pr-merge.md:79`). Every major
  becomes `dependency-functional` + `requires-human`, whether it is a
  `@types/*` dev bump or a runtime framework rewrite.

## Two findings that shaped the design

Both were discovered while researching this plan and are documented in full in
[00-current-behaviour.md](00-current-behaviour.md).

1. **We do not have the GitHub App `Actions: read` permission.** The harness
   tries to download real Actions job logs and *silently* falls back to
   check-run annotations when that 403s. Every install that followed our own
   setup docs is in that fallback. Any "understand why CI failed" work is
   guesswork until this is fixed.
2. **`pr-fix` never receives CI feedback at all.** `pr.checks_failed` is
   emitted *only* for dependency PRs, so a human PR going red fires nothing and
   `pr-fix` can never see whether its own push worked.

## Locked decisions

| # | Decision | Why |
|---|---|---|
| 1 | Retry is **layered and diagnosis-gated** — classify the failure first, then decide whether another attempt can help | Blind retries burn budget on failures no amount of retrying fixes (missing secrets, a red base branch) |
| 2 | A new **`fixing` skill**, distinct from `building` | `building` is about *implementing*; `fixing` is about *diagnosing a failure that already happened*. Different procedure, different rubric |
| 3 | Impact for majors is judged from **evidence, with no checkout** | Keeps the cheap green-PR path cheap; passing CI is already behavioural evidence |
| 4 | **CI-still-running is a hard, code-level guard**, uniform across all three trigger routes | Today it is an emergent property of one code path and is not configurable |
| 5 | New **`fix:` and `dependencies:` config blocks**, overlay-overridable and repo-settable, clamped so a repo can only be *more* conservative | Mirrors the existing add-only `approval` precedent from #180 |
| 6 | Low/medium-impact major → **auto-merge + one audit comment**; high keeps `requires-human` | The audit comment is the record of *why* it was safe |
| 7 | Everything keys off **`PR_FIX_SHAPED_WORKFLOWS`**, so `pr-fix` and `dependabot-ci-fix` improve together | They are already the same shape; divergence would be accidental |
| 8 | **No changes to `packages/workflow-engine/`** | Every capability needed already exists; the two genuine gaps are routed around at the dispatch layer |
| 9 | **One `PrState`, resolved once at `dispatchWorkflow`**; every decision is a pure function over it returning `{decision, reason}` | State was scattered across seven stores and read from six sites free to disagree — see [09-state-machine.md](09-state-machine.md) |
| 10 | **One run per PR**, across every PR-scoped workflow; the loser is dropped with a reason | Two fix workflows could otherwise clone and push the same branch concurrently |
| 11 | **`failed` means malfunction**; a crash never consumes a retry attempt | Otherwise one bad hour escalates every open PR in the fleet to `requires-human` |
| 12 | **The crons stay** — Phase 8 is deferred | The review sweep turned out to be load-bearing three times over (§S5) |

## Phases

Execute in order — each leaves the repo green before the next starts.

- [ ] **Phase 0** — [00-current-behaviour.md](00-current-behaviour.md) —
  research record: how the two workflows actually behave today, the trigger
  matrix, and the two findings. *No code.* Read this first.
- [ ] **Phase 1** — [01-ci-evidence.md](01-ci-evidence.md) — `Actions: read`,
  a structured CI failure report, and Actions read tools in agentic-pi
  *(risk: medium — needs App re-consent + an agentic-pi release)*
- [ ] **Phase 2** — [02-diagnosis.md](02-diagnosis.md) — the `fixing` skill and
  the `diagnose` phase with its five failure classes *(risk: medium — the
  design crux)*
- [ ] **Phase 3** — [03-signals.md](03-signals.md) — deterministic signals in
  code: preflight, check-state guards, context enrichment, three latent bugs
  *(risk: low)*
- [ ] **Phase 4** — [04-retry.md](04-retry.md) — the cross-run attempt counter,
  escalation policy, model escalation, and the within-run local gate loop
  *(risk: medium — `until_bash` has no production consumer yet)*
- [ ] **Phase 5** — [05-impact.md](05-impact.md) — major-bump impact
  classification and the auto-merge gate *(risk: low)*
- [ ] **Phase 6** — [06-config.md](06-config.md) — the `fix:` / `dependencies:`
  config blocks through all four layers, plus docs and verification
  *(risk: low, but touches many files)*
- [ ] **Phase 7** — [07-review-triggers.md](07-review-triggers.md) —
  configurable `pr-review` trigger modes: `eager` / `after-checks` /
  `on-request` *(risk: medium — contains a must-fix deadlock)*
- [x] ~~**Phase 8**~~ — [08-remove-backstop-crons.md](08-remove-backstop-crons.md)
  — **deferred.** The `pr-review` and `issue-triage` crons stay. See
  [09-state-machine.md](09-state-machine.md) §S5 for why the review sweep is
  load-bearing; `ready_for_review` mapping and the queued-run expiry policy are
  lifted out as independent work.
- [ ] **Phase 3′** — [09-state-machine.md](09-state-machine.md) — the normative
  state machine: `PrState`, the four pure decision functions, and the three
  defects they fix *(risk: medium — restructures Phase 3)*

Phases 1–3 are independent of each other and could run in parallel. Phase 4
depends on 2 and 3; Phase 5 depends on 3; Phase 6 can land first as inert
config, or last. **Phase 3 is now the largest phase**, because 09 restructures
it around `resolvePrState`; Phases 4, 5 and 7 get correspondingly thinner on top
of it.

Phase 7 is separable from 1–6 — it addresses a different workflow (`pr-review`)
and could ship on its own. It is filed here because it shares the config
plumbing, the check-state signals, and the same "make the policy configurable
rather than hardcoded" thesis. With Phase 8 deferred, §7.4b (generalising
`condition.unless: webhooksEnabled`) is **un-superseded** and live again.

## Open questions to settle before executing

> [09-state-machine.md](09-state-machine.md) settles 4, 7 and 9, makes 6 moot,
> and partly settles 5. Statuses are marked inline below.

1. **App re-consent.** `Actions: read` requires every existing installation to
   re-consent. Acceptable? The plan degrades explicitly (a visible "logs
   unavailable" line) rather than silently, but diagnosis quality is capped at
   annotations without it.
2. **agentic-pi scope.** Adding Actions read tools means a fixture re-capture
   and an independent npm release of a separately-published package. If that is
   unwelcome timing, Phase 1 can ship harness-side pre-fetch only and add the
   agent tools later — diagnosis still works, with less ability to dig.
3. **`autoMergeMaxImpact` default.** The plan ships `low` packaged (conservative,
   near-inert for existing deployments) and puts `medium` — #252's actual ask —
   in the `nearform/lastlight-nearform` overlay. Shipping `medium` packaged
   would silently change behaviour for every deployment.
4. **Broadening `pr.checks_failed`** to PRs whose head commit Last Light
   authored is the only change that can increase run volume on non-dependency
   PRs. Bounded, but a real behaviour change.
5. **`pr-review` default trigger mode.** Phase 7 keeps `eager` (today's
   behaviour) as the packaged default so upgrading changes nothing, but
   `after-checks` is arguably the better default now that the review can read
   the CI result. Also note Phase 7 flips one existing behaviour: draft PRs are
   currently reviewed on the webhook path but skipped by the cron, and the
   proposed `review.skipDraft: true` default makes the webhook path match the
   cron.
6. **Are there webhook-less deployments?** Phase 8 removes the two crons whose
   entire purpose was `unless: webhooksEnabled` — a Slack/CLI-only install
   loses automatic triage and review completely. Confirm none exists before
   merging.
7. **What should happen to a queued run that expires?** `expireStaleRuns`
   cancels anything queued longer than `maxQueueWaitMs` (1 h). The removed cron
   was the de-facto re-pickup; after Phase 8 that work is silently dropped.
   Re-dispatch, notify, or raise the window — needs a decision.
8. **Should bot-authored PRs be reviewable?** The webhook drops every PR whose
   author ends `[bot]`; the removed cron only skipped our own. After Phase 8
   that divergence becomes the permanent behaviour by default.
9. **`requires-human` is an overloaded terminal flag** — "gave up",
   "high-impact bump", and "auto-merge disabled on the repo" all collapse to one
   label that permanently suppresses cron discovery, with nothing to
   distinguish them and no expiry. This plan improves the *comment* and carves
   `upstream-broken` out of labelling entirely, but a proper fix deserves its
   own issue.

## Cost posture

A `diagnose` phase per attempt is new spend, offset by not paying for
install + tests on non-retryable failures. Recommended rollout: ship with
`fix.maxAttempts: 2` in the overlay, measure cost per attempt from the
`executions.cost_usd` rollups, then raise. `fix.maxCostUsd` is the hard brake
and is enforced at dispatch, before a sandbox is provisioned.
