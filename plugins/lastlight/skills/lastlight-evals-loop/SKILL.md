---
name: lastlight-evals-loop
description: Drive a Last Light EVAL toward a target score with a disciplined, anti-gaming improvement loop — run → mine failures → propose candidate fix(es) → re-measure → keep the best or revert → repeat. Use when the user wants to "improve / raise the pr-review F1", "make the reviewer better against the eval", "close the loop on evals", "iterate on prompts/skills to pass more cases", or "tune the workflow to hit a score target". The loop diagnoses on a TRAIN split and validates on a BLIND held-out split so fixes must generalize, not overfit; it prefers generic overlay prompt/skill edits, and stops for human sign-off before editing any gold answer. For a one-off run/compare use lastlight-evals; to hand-fork a workflow/prompt use lastlight-overlay. Needs an already-scaffolded evals workspace (lastlight-evals) with a pr-review dataset.
version: 1.1.0
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

The method — **weakness-mine → propose a few minimal candidates → keep the one
that survives a blind held-out gate** — follows *Self-Harness: Harnesses That
Improve Themselves* ([arXiv:2606.09498](https://arxiv.org/abs/2606.09498)), adapted
to keep our anti-gaming discipline. See **references/approach.md** for the mapping.

## Prerequisites

- A scaffolded evals workspace with a **pr-review** dataset and a working provider
  key — set up via **`lastlight-evals`** first if you don't have one. Confirm a
  bare `lastlight-evals run pr-review --limit 1 --no-open` grades a case.
- An **`instance/` overlay** (the deployment overlay) to receive generic edits —
  see **`lastlight-overlay`**. The loop edits copies here, never core.
- Two helpers ship with the evals package: **`scripts/mine-failures.ts`** (ranks
  the TRAIN failure signatures into an evidence bundle — the diagnosis input) and
  **`scripts/diff-runs.ts`** (compares two runs and calls keep/revert).

## The one rule

**One change *kept* per round.** A round may *explore* a few minimal candidates,
but at most one is ever kept and committed to `instance/` — the rest are reverted.
So which edit moved the number is always attributable, and no overfit edit rides
along with a good one. Never keep two edits from one round without re-measuring
each in isolation.

## Start here

| You have… | Go to |
|---|---|
| Never run this loop on this dataset | **§1 Set up the split** then §2 |
| A split + baseline already recorded | **§3 Diagnose (mine failures)** |
| Candidate change(s) ready to test | **§5 Audit → §6 Apply → §7 Measure → §8 Decide** |

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
consecutive no-keep rounds).

## 2. Baseline

Run both splits and record `avgFbeta` for each in the journal. Use the cheapest
adequate model while iterating on prompts; switch to the real target model only to
confirm a kept change.

```bash
lastlight-evals run pr-review --overlay instance --instance <train-ids>   --no-open
lastlight-evals run pr-review --overlay instance --instance <heldout-ids> --no-open
```

Each writes `eval-results/pr-review/<runId>/scorecard.json`. Note the two runIds.

## 3. Diagnose (TRAIN only) — mine the failure signatures

Mine the TRAIN scorecard into a ranked **evidence bundle** — recall-loss and
precision-loss signatures ordered by impact — instead of reading traces by hand:

```bash
npx tsx scripts/mine-failures.ts <train-scorecard.json> --train <train-ids> --keywords
```

It reads only the TRAIN split (never held-out) and prints two ranked blocks:
- **RECALL LOSS** — missed gold (`falseNegatives`, weighted by `severity`): the
  real issues the agent missed. Biggest F1 headroom is at the top.
- **PRECISION LOSS** — noise (`falsePositives`): findings that matched no gold.

Each signature is `axis·severity·area` with a frequency, case count, example ids,
and (with `--keywords`) a heuristic category guess. Take the **top systematic
pattern** — not a one-off — and name it: *"misses security-relevant findings"*,
*"posts style nits the rubric says to suppress"*, *"confidence bar too low →
noise"*, *"no awareness of the repo's conventions → wrong-fit findings"*. See
**references/levers.md** for how each pattern maps to an edit. (You can still open
individual TRAIN `review.trace`s to read a signature's underlying findings — just
never a held-out trace.)

## 4. Propose candidates — a few minimal, diverse edits

For the top signature, draft **K = 2–4 candidate edits**, each **minimal** (touches
only what the pattern needs) and each targeting a *different* mechanism or a
different formulation of the same one — e.g. one tightens the severity bar in the
`code-review` skill, another adds a confidence gate in the reviewer prompt. K stays
small on purpose: selecting the best of many candidates optimistically inflates the
train number, so keep the field narrow and let the held-out gate (§7b) be the check.
Drafting one candidate is fine — best-of-K is an option, not an obligation.

Every candidate uses the **lowest** lever that could move the cluster (full detail
in **references/levers.md**):

- **(a) generic — auto.** Edit an overlay prompt/skill/persona, or add a generic
  `instance/repo-context/AGENTS.md` injected into every repo. Must be general.
- **(b) per-repo context — signed-off.** A `datasets/pr-review/context/<id>/AGENTS.md`
  the harness injects only for that repo — the portable *"add this to your repo"*
  finding. Human approves before writing.
- **(c) the eval itself — rare, signed-off.** Edit `review_gold[]` ONLY when the
  gold is demonstrably wrong/incomplete; name the evidence. Human approves.

Escalate a candidate only when a lower lever genuinely can't address the pattern,
and write down why.

## 5. Audit each candidate (adversarial sub-agent)

Before measuring, run the **generality + leak auditor** sub-agent (prompt template
in **references/guardrails.md**) on **every** candidate. It **REJECTS** if the change:
- names a specific repo / `instance_id` / file path (lever a must be generic), or
- **encodes the gold answer** — injected repo context that describes the specific
  findings is cheating. It must read as plausible maintainer guidance written
  *without* knowledge of this PR's bug (conventions, architecture, review
  priorities), never "look for bug X".

Rejected candidates are dropped (not counted); survivors go to §6. If none survive,
back to §4.

## 6. Apply (hybrid autonomy)

Apply each surviving candidate on its **own throwaway branch** (or stash between
candidates) so their §7a measurements don't cross-contaminate — only the winner is
committed in §8.

- **Lever (a)** (incl. generic `repo-context/AGENTS.md`): apply automatically to
  `instance/…` once the auditor passes.
- **Lever (b)/(c)**: **STOP.** Present the diff + the written justification and ask
  the human to approve before writing to the dataset.

## 7. Re-measure — train selects, held-out confirms **once**

The blind held-out set must be consumed **once per round**, not once per candidate —
gating every candidate on held-out and keeping the best would inflate it (max-of-K
selection bias). So split measurement in two:

**7a. Rank candidates on TRAIN only.** Run each survivor on the TRAIN split and diff
*without* `--heldout` (the verdict prints `REVIEW — no held-out`, expected here):

```bash
npx tsx scripts/diff-runs.ts <baseline-train.json> <candidate-train.json> --train <train-ids>
```

Pick **one winner**: highest train Δ → tie-break lowest lever → smallest diff →
fewest per-case train regressions. **Do not touch held-out in 7a.**

**7b. Confirm the winner on HELD-OUT, once.** Run the winner on both splits and diff
with the full gate:

```bash
npx tsx scripts/diff-runs.ts <baseline.json> <winner.json> \
    --train <train-ids> --heldout <heldout-ids>
```

(Run the two splits in one `--instance <all-ids>` run so a single scorecard holds
both.) If a candidate may legitimately be held-out-driven with flat train, add
`--symmetric` for the paper's non-regressive gate (KEEP iff neither split regresses
and one improves); record which gate you used. With a single candidate, 7a and 7b
collapse into one gated run.

## 8. Decide

- **KEEP** the winner iff its train F1 improved **and** held-out did **not** regress
  (the helper's verdict). Train ↑ with held-out ↓ = **overfit → revert**.
- **Lever (b)** per-repo edits are case-scoped: keep iff that case improved, the
  auditor passed, and the human approved — recorded as a per-repo recommendation,
  not a workflow change (no held-out claim is made for it).
- **Revert the K−1 losers** and, on a REVERT verdict, the winner too: `git checkout`
  the overlay file, or remove the sidecar. Exactly one edit (or none) survives the
  round — that is the "one change kept per round" rule.

## 9. Journal, then repeat

Append one entry per **round** (schema in **references/journal-format.md**): the
mined pattern, the K candidates with each one's train Δ, which won, the winner's
single held-out Δ, the decision, and the running best. Then return to §3. Stop at
the target or the plateau (N=3 consecutive no-keep rounds).

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
