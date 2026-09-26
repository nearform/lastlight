# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information. A reporter (or maintainer) reply re-opens triage automatically (router-driven), provided no build has started yet. |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent. **Now read by the harness** — see the stage vocabulary below |
| `ready-for-human`          | `ready-for-human`    | A person's turn. Originally "requires human implementation"; it is also where a successful agent build lands |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Labels Last Light writes and reads

Three more labels are part of the harness's own vocabulary rather than the triage roles above. The strings live in `apps/server/src/cron/dependabot-discovery.ts`, which is the single source of truth for them, and `apps/server/tests/cron/label-vocab.test.ts` pins them against the prompts that create them.

| Label | Who applies it | Who reads it | Meaning |
| --- | --- | --- | --- |
| `lastlight-ignore` | **a human, only** | the dispatch gate + the router | **The hold.** "Last Light, stay off this." Blocks *every* workflow on the issue or PR carrying it — triage, review, fix, merge, everything — and outranks an explicit `@last-light …` request, which gets one reply naming the label. Remove it and the bot resumes; nothing is persisted either way. Operator-configurable as `hold.label` (env `LASTLIGHT_HOLD_LABEL`); colour `24292f`. |
| `requires-human` | the bot (escalation, and the agent per the dependabot prompts) | nothing — but its **removal** is read | A **notification**: "I stopped and a human should look." It holds nothing, and its presence is not a decision input. Taking it off *is* one: the bot reads "we escalated at this head, the head has not moved, our label is gone" as a maintainer asking for another try, and starts a fresh attempt-and-cost window at the same commit. So you never *have* to remove it — a push re-arms the loop with the label still on the PR — but removing it is one of the three ways to say "go again", alongside a push and `@last-light retry [reason]`. |
| `dependency-trivial` / `dependency-functional` / `dependency-major-{low,medium,high}` | the `dependabot-pr-merge` agent | the merge prompt | The dependency-PR verdict + major-bump impact tier. See `apps/server/spec/05-router.md`. |

Do not reach for `requires-human` to stop the bot touching something — it has not meant that since the hold label shipped, and taking it *off* now means the opposite ("try again"). Apply `lastlight-ignore`.

**Un-sticking an escalated PR.** Three things work from GitHub and do exactly the same thing — push a commit, comment `@last-light retry [reason]`, or remove `requires-human`. Each starts a fresh full window (`fix.maxAttempts` attempts and `fix.maxCostUsd` of spend), each is recorded on the run that follows so you can see who asked and why, and none of them produces a second escalation comment. Retries are unbounded, so this is a real spending decision: the escalation comment on the PR lists all four options, including the hold. From a terminal, `lastlight pr retry <owner/repo#N> [reason]` is the same record over the admin API — and, uniquely, dispatches the stuck workflow immediately rather than waiting for the next event.

## The stage vocabulary — the software-factory pipeline

`ready-for-agent` is finally read by something. Applying it to an issue in a repo the operator has listed under `autonomy.repos` dispatches a gated `build` workflow, and the issue then moves through a four-label pipeline:

```
ready-for-agent ──build──▶ agent-building ──▶ ready-for-human   (build succeeded)
                                         └──▶ agent-blocked     (build failed)
```

**The label is the source of truth.** There is no pipeline table and no stage column anywhere in the database — the label on the issue *is* the state. That is what makes the pipeline legible to a human scanning the tracker, and what makes a `label:ready-for-agent` query a sound way to find work.

| Label | Who applies it | Who reads it | Meaning |
| --- | --- | --- | --- |
| `ready-for-agent` | a human, **or** the `issue-triage` agent | the router + the build dispatch gate | The entry signal. Triage says this is fully specified and an agent can take it. Applying it is the only way into the pipeline |
| `agent-building` | **the harness**, host-side, at dispatch | the backstop sweep, which *excludes* it | In flight: a build has been dispatched for this issue. Agent-owned — nobody hand-edits it |
| `ready-for-human` | **the harness**, when the build run finishes `succeeded` | nothing | Success terminus: there is a PR for a person to review and merge |
| `agent-blocked` | **the harness**, when the run finishes `failed` or `cancelled` — and when a build is refused on a spend ceiling | the budget refusal, as its once-only dedup key | Failure terminus: the build did not get there and a human should read why |

Two of the four (`ready-for-agent`, `ready-for-human`) are the triage words above, reused rather than duplicated — the triage vocabulary already had the right word for "a person's turn now". The other two are new and agent-owned. The packaged strings are in `apps/server/src/engine/stage-labels.ts`, but they are **operator-owned config**: a deployment configures them under `autonomy.stages` in `config/default.yaml`, and renaming one renames what the code gates on.

**The entry label comes off at dispatch, not at completion.** The harness applies `agent-building` and removes `ready-for-agent` *before* the run starts, so a re-delivered webhook or a backstop sweep cannot pick the same issue up twice. If you see an issue carrying both labels, the removal failed and the advance did not: harmless, and the next advance or a human reconciles it.

**The terminal labels are written by the harness too.** A stage observer hangs off the run's *persisted* terminal transition, so `succeeded` lands the issue on `ready-for-human` and `failed` or `cancelled` lands it on `agent-blocked` — whether the run finished normally, was resumed after a restart, expired in the queue or was cancelled from the dashboard. A run paused at an approval gate moves nothing: it is still in flight, and reporting it as finished would be a lie you would then have to move a second time. Re-firing is harmless — re-adding a label the issue already has is a no-op, and removing one that has gone is a swallowed 404 — so there is no bookkeeping behind it. A build a human asked for with `@last-light build` carries no stage and therefore acquires no stage labels at all.

**A sweep picks up what a webhook dropped.** `pick-up-ready-issues` runs every 20 minutes, alongside webhooks rather than instead of them, and offers any open issue that carries the entry label and does *not* carry `agent-building`. That second condition is what makes a half-finished advance (new label on, old one stuck) safe: without it the sweep would re-offer an issue that is actively building. Everything else — the allow-list, the hold, already-built, run-in-flight, the budgets — is decided at the dispatch gate the webhook crosses too, so the sweep can only ever *find* work, never authorise it.

**The budgets in `autonomy.budget` are enforced**, at that same gate, before a run starts. A refusal is always recorded and the noise is proportionate to how terminal it is: hitting the harness-wide concurrency ceiling logs and nothing more (it clears in minutes); hitting a repo's builds-per-day quota also writes an `autonomy.skip` row to the activity log; hitting a daily spend ceiling additionally applies `agent-blocked` and posts **one** comment naming the ceiling, what has been spent, when it resets at midnight UTC, and the two ways on (remove the label to re-arm, or ask the operator to raise the limit). The label is the comment's dedup key, so a sweep re-tick twenty minutes later cannot comment again. A repo's daily quota counts builds *started* in every status, because a failed build still spent the money.

**The board reads these labels, and writes them.** The dashboard's Board tab lays the four stage labels out as columns — derived from `autonomy.stages`, so a renamed label renames its column — and files every open issue under the label it carries, joined to its latest run, any approval waiting on you, and the PRs that close it. Its card actions are live (dispatch / rebuild, retry, unblock & rebuild, approve / reject, cancel), and dragging a card onto a stage's `enter` or `running` column starts a build through the same dispatch gate, as the logged-in human. Dropping it on a terminal column only moves the label.

**What is not built yet.** `on_merge: auto-low-impact` — it is accepted and recorded but behaves as `none`, because no impact signal exists for a feature PR.

**Merging.** By default the PR the build opens parks at `ready-for-human` and a person merges it. A stage configured `on_merge: auto` instead has the build agent enable GitHub **auto-merge** on its own PR — which is not the same as merging: CI and branch protection still gate the landing, and the agent is told never to merge directly. That policy applies to autonomous pipeline runs only; a human's `@last-light build` always parks the PR, whatever the stage says.

**Stopping it.** The hold label (`lastlight-ignore`) outranks the pipeline entirely, exactly as it outranks everything else, and a repo can turn the stage off wholesale with `disabled.workflows: [build]` in its `.lastlight/lastlight.yml`. Re-applying `ready-for-agent` by hand to an issue whose build failed is read as an explicit retry and dispatches again; the same label re-applied **by the bot** is a hard skip, because machines must never re-spend.

## Notes for this repo

- All five labels exist in `nearform/lastlight`. `needs-info` and `wontfix`
  predate this setup; `needs-triage`, `ready-for-agent`, and `ready-for-human`
  were created during `/setup-matt-pocock-skills`.
- The repo also carries a separate `needs-review` label (used for
  design-heavy issues a human should look at before an agent grabs them, e.g.
  the architecture-deepening backlog #93–#100). It is **not** one of the five
  canonical triage roles — don't use it as the AFK-ready/human-ready signal.
