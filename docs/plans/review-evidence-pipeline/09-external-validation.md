# WP9 — external validation (mandatory)

**Goal.** Establish whether anything this plan builds generalises beyond eight
PRs from one private repository.

**Depends on:** [WP6](06-adjudicate.md). **Blocks:** any external claim about
review quality, and any decision to enable the pipeline by default.

## Why this is mandatory and not optional

The eight `skillspro` cases are an excellent **architecture-development**
instrument and an inadequate basis for a **general quality claim**. Specifically:

- **n = 8 cases, 25 gold findings, one repository, one team's review style.**
  One case (`1641`) has empty gold and exists to catch precision regressions, so
  the recall set is seven cases.
- **Rounds of the same PR are correlated.** `1587-r1/r2/r3` are one PR; so are
  `1680-r1/r2` and `1641/1641-r2`. There are really **four PRs**, not eight
  independent samples.
- **The blind split is three cases.** A single case moving swings it by 33%. The
  baseline was decisive at n=1 only because it was saturated at zero; nothing
  above zero will be.
- **We have been iterating against it for four candidates.** Even with the
  train/blind discipline, the *architecture* has been shaped by this repo's
  defect profile. That is selection on the instrument, and it is invisible from
  inside.
- **One language, one framework, one house style.** The obligation families were
  derived from what converts here.

Every number in [08-evals.md](08-evals.md) is a **development signal**. WP9 is
what turns it into a claim.

## The validation set

Three tiers, in increasing order of independence.

### Tier 1 — the in-repo Martian set (available today)

`apps/evals/datasets/pr-review/` already imports Martian's **Code Review Bench**:
50 PRs across Sentry, Grafana, Cal.com, Discourse and Keycloak, with a
`martian-leaderboard.json` sidecar carrying per-tool tp/fp/fn so our arm can be
slotted in among their tools.

Two caveats, both already recorded in that dataset's README and both binding:

- **Martian's gold set is incomplete by their own methodology**, which
  *understates* precision. That is why the default is F1 rather than F0.5 —
  do not "fix" it.
- `instances.json` is gitignored and generated locally by
  `scripts/import-martian.ts`. Regenerate rather than assuming it is present.

### Tier 2 — a second private repository

The generality question we actually care about commercially is *"does this work
on a repo we did not design against?"* — which needs a private repo with a real
human reviewer, built the same way the `skillspro` set was built
(`lastlight-evals add-case --pr <url> --review`, gold curated per comment id,
anti-spoil check, base commit pinned and asserted).

`nearform/techbase` is the obvious candidate — it is already a managed repo on
the same deployment. **Curating it is a human task with human sign-off**, per
[HANDOFF.md](HANDOFF.md).

### Tier 3 — published benchmarks

CR-Bench and c-CRAB give directly comparable public numbers
([00-evidence §5](00-evidence.md)) — CR-Bench GPT-5.2 at 27.0% recall / 3.6%
precision, c-CRAB Claude Code at 32.1%. Running against these is how we answer
"are we good" rather than "did we improve".

## The threat this set introduces: contamination

Tiers 1 and 3 are **public repositories**, and the PRs predate current model
training cutoffs. A model may have seen the fix, the issue, or the review
discussion.

This cuts the opposite way from the `skillspro` set's weakness, which is why both
are needed:

| | `skillspro` (private) | Martian / CR-Bench (public) |
|---|---|---|
| Contamination | none — private repo | **plausible** |
| Selection | we designed against it | independent |
| Style match | one team | many |

**Report them separately and never pool them.** A pooled number hides both
biases. If the public-set result is dramatically better than the private-set
result, suspect contamination before celebrating.

## Protocol

1. **Freeze the architecture first.** WP9 runs on a fixed candidate. It is not an
   iteration loop, and it is **not** a place to tune thresholds — that is what
   the train split is for. Tuning on WP9 destroys exactly the property it exists
   to provide.
2. **Run once per released architecture**, not per change.
3. **Report the full metric set** from [08-evals.md](08-evals.md) — internal
   recall, posted recall, SNR, comments/PR, latency, cost — per tier, unpooled.
4. **Compare against the shipped baseline on the same tier**, not against the
   `skillspro` numbers.
5. **Publish the gap honestly.** If the pipeline gains +15 micro-recall on
   `skillspro` and +2 on Martian, that is the finding, and it means the obligation
   families are repo-shaped. That is actionable — it points at
   [WP7](07-review-memory.md) as the generalisation mechanism rather than at more
   families.

## Acceptance criteria

1. Tier 1 runs end to end against both the shipped baseline and the candidate,
   with results slotted into the Martian leaderboard ranking.
2. Results are reported **per tier, unpooled**, with the contamination caveat
   stated in the summary rather than a footnote.
3. No threshold, prompt or obligation family is changed as a result of reading
   WP9. If something obviously wants changing, it goes back to the train split
   and WP9 is re-run afterwards.
4. Tier 2 exists, or its absence is recorded as a known limitation on any
   external claim.
5. Cost and wall clock for a 50-case tier-1 arm are measured and recorded before
   it becomes a routine gate — at ~2–3× baseline per case this is not free, and
   it should run per release, not per commit.

## Non-goals

- **Not a development loop.** See protocol 1.
- **No new private dataset beyond tier 2** in this work package.
- **No fine-tuning on any of it.** These are evaluation sets; using them as
  training data destroys them.
