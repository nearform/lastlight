# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information. A reporter (or maintainer) reply re-opens triage automatically (router-driven), provided no build has started yet. |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
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

## Notes for this repo

- All five labels exist in `nearform/lastlight`. `needs-info` and `wontfix`
  predate this setup; `needs-triage`, `ready-for-agent`, and `ready-for-human`
  were created during `/setup-matt-pocock-skills`.
- The repo also carries a separate `needs-review` label (used for
  design-heavy issues a human should look at before an agent grabs them, e.g.
  the architecture-deepening backlog #93–#100). It is **not** one of the five
  canonical triage roles — don't use it as the AFK-ready/human-ready signal.
