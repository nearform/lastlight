---
name: lastlight-evals-loop
description: Drive a Last Light EVAL toward a target score with a disciplined, anti-gaming improvement loop — run → diagnose → propose ONE generic fix → re-measure → keep or revert → repeat. Use when the user wants to "improve / raise the pr-review F1", "make the reviewer better against the eval", "close the loop on evals", "iterate on prompts/skills to pass more cases", or "tune the workflow to hit a score target". The loop diagnoses on a TRAIN split and validates on a BLIND held-out split so fixes must generalize, not overfit; it prefers generic overlay prompt/skill edits, and stops for human sign-off before editing any gold answer. For a one-off run/compare use lastlight-evals; to hand-fork a workflow/prompt use lastlight-overlay. Needs an already-scaffolded evals workspace (lastlight-evals) with a pr-review dataset.
version: 1.0.0
tags: [lastlight, evals, loop, improvement, overfitting, pr-review]
---

# Improve an eval, honestly

A loop that raises an eval score **without gaming it**. The trap: the loop can see
both the gold answer and the agent's answer for every case, so it could overfit —
hardcode a repo's finding into a prompt, or edit a gold answer to force a pass.
That lifts the number and ruins the reviewer. Every guardrail here exists to force
**generic, cross-cutting** changes that would help on repos the loop has never seen.

Scope: the **pr-review** tier (its judge trace gives you the agent-vs-gold detail
diagnosis needs). The pattern extends to triage/code-fix, but start here.

## Prerequisites

- A scaffolded evals workspace with a **pr-review** dataset and a working provider
  key — set up via **`lastlight-evals`** first if you don't have one. Confirm a
  bare `lastlight-evals run pr-review --limit 1 --no-open` grades a case.
- An **`instance/` overlay** (the deployment overlay) to receive generic edits —
  see **`lastlight-overlay`**. The loop edits copies here, never core.
- The `diff-runs.ts` helper ships with the evals package
  (`scripts/diff-runs.ts`) — it compares two runs and calls keep/revert.

## The one rule

**One change per iteration.** Propose a single hypothesis, measure its effect in
isolation, keep or revert, then move on. No batching — batching hides which edit
moved the number and invites scattershot overfitting.

## Start here

| You have… | Go to |
|---|---|
| Never run this loop on this dataset | **§1 Set up the split** then §2 |
| A split + baseline already recorded | **§3 Diagnose** |
| A proposed change ready to test | **§5 Audit → §6 Apply → §7 Measure → §8 Decide** |

## 1. Set up the split (once per dataset)

Split the tier's `instance_id`s into **TRAIN** (you diagnose on these — traces
visible) and **HELD-OUT** (blind — you NEVER read their traces; only their
aggregate F1 gates a keep). ~70/30, deterministic (sort ids, take the first 70%
as train). Record both lists at the top of the journal (§9) — they must stay
fixed across the whole loop, or the held-out gate means nothing.

```bash
# list the ids (jq over instances.json), then split deterministically
lastlight-evals run pr-review --instance <all-ids> --no-open   # or omit --instance for the whole tier
```

Set a **target**: an F1 goal (e.g. 0.55) or "improve until plateau" (N=3
consecutive no-keep iterations).

## 2. Baseline

Run both splits and record `avgFbeta` for each in the journal. Use the cheapest
adequate model while iterating on prompts; switch to the real target model only to
confirm a kept change.

```bash
lastlight-evals run pr-review --overlay instance --instance <train-ids>   --no-open
lastlight-evals run pr-review --overlay instance --instance <heldout-ids> --no-open
```

Each writes `eval-results/pr-review/<runId>/scorecard.json`. Note the two runIds.

## 3. Diagnose (TRAIN only)

Read the TRAIN scorecard's `results[].review` and `review.trace`. **Do not open
held-out traces.** For each failing case:
- `falseNegatives` (with `severity`) = **recall** loss — real issues the agent missed.
- `falsePositives` = **precision** loss — noise the agent posted that matched no gold.

Cluster across cases and name the **systematic pattern** — not a one-off. Good
patterns generalize: *"misses security-relevant findings"*, *"posts style nits the
rubric says to suppress"*, *"confidence bar too low → noise"*, *"no awareness of the
repo's conventions → wrong-fit findings"*. See **references/levers.md** for how
each pattern maps to an edit.

## 4. Hypothesis — ONE change, lowest lever first

Pick the **lowest** lever that could move the whole cluster (full detail in
**references/levers.md**):

- **(a) generic — auto.** Edit an overlay prompt/skill/persona, or add a generic
  `instance/repo-context/AGENTS.md` injected into every repo. Must be general.
- **(b) per-repo context — signed-off.** A `datasets/pr-review/context/<id>/AGENTS.md`
  the harness injects only for that repo — the portable *"add this to your repo"*
  finding. Human approves before writing.
- **(c) the eval itself — rare, signed-off.** Edit `review_gold[]` ONLY when the
  gold is demonstrably wrong/incomplete; name the evidence. Human approves.

Escalate only when a lower lever genuinely can't address the pattern, and write
down why.

## 5. Audit the change (adversarial sub-agent)

Before applying, spawn a **generality + leak auditor** sub-agent (prompt template
in **references/guardrails.md**). It **REJECTS** if the change:
- names a specific repo / `instance_id` / file path (lever a must be generic), or
- **encodes the gold answer** — injected repo context that describes the specific
  findings is cheating. It must read as plausible maintainer guidance written
  *without* knowledge of this PR's bug (conventions, architecture, review
  priorities), never "look for bug X".

Rejected → back to §4.

## 6. Apply (hybrid autonomy)

- **Lever (a)** (incl. generic `repo-context/AGENTS.md`): apply automatically to
  `instance/…` once the auditor passes.
- **Lever (b)/(c)**: **STOP.** Present the diff + the written justification and ask
  the human to approve before writing to the dataset.

## 7. Re-measure

Re-run both splits (§2) with the change, then diff against the baseline:

```bash
npx tsx scripts/diff-runs.ts <baseline-train.json> <candidate-train.json> \
    --train <train-ids> --heldout <heldout-ids>
```

Point it at the run pair that covers both splits (or run the two splits in one
`--instance <all-ids>` run so a single scorecard holds both). It prints per-case
F1 deltas, the arm-summary delta, and a **KEEP / REVERT verdict**.

## 8. Decide

- **KEEP** iff train F1 improved **and** held-out did **not** regress (the helper's
  verdict). Train ↑ with held-out ↓ = **overfit → revert**.
- **Lever (b)** per-repo edits are case-scoped: keep iff that case improved, the
  auditor passed, and the human approved — recorded as a per-repo recommendation,
  not a workflow change (no held-out claim is made for it).
- Else **REVERT**: `git checkout` the overlay file, or remove the sidecar.

## 9. Journal, then repeat

Append one entry per iteration (schema in **references/journal-format.md**):
pattern, lever, the diff/context, auditor verdict, train Δ, held-out Δ, decision,
running best. Then return to §3. Stop at the target or the plateau.

Run the loop on a cadence with the built-in `/loop` if you want it to keep going
unattended between your check-ins — but the lever-(b)/(c) sign-off stops still
apply.

## Done when

The target F1 is reached or the loop plateaus, the journal records every
hypothesis and its train/held-out deltas, kept changes live in `instance/` (and,
with sign-off, per-repo `context/` sidecars), and **no** change was kept that
regressed the blind held-out set. Report: baseline → final F1 (train and
held-out), the kept changes, any per-repo recommendations, and anything that
needed human sign-off.
