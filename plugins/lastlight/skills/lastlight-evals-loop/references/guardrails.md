# Guardrails — keeping the loop honest

The loop sees the gold answer and the agent's answer, so it *could* game the score.
These guardrails make that hard and, where it isn't automatable, put a human in the
way. None is optional.

## 1. Held-out split (empirical anti-overfit gate)

Diagnose on TRAIN; validate on a BLIND HELD-OUT split whose traces you never read.
A generic (lever a) change is kept only if **train F1 improves AND held-out F1 does
not regress** beyond a small epsilon. A train gain with a held-out regression is
overfitting — revert it. `scripts/diff-runs.ts` computes this verdict for you; do
not override it by eyeballing train alone.

The split ids are fixed for the whole loop. If you re-split (e.g. to add cases),
say so in the journal and treat prior held-out results as no longer comparable.

## 2. One change *kept* per round

Isolates causal effect. If two edits ship together and the number moves, you can't
attribute it — and you can't tell an overfit edit riding along with a good one. A
round may *explore* K=2–4 minimal candidates, but each is measured on its own
branch and at most one is kept.

**Best-of-K must not consume the blind split K times.** Selecting the best of many
candidates on held-out inflates it (max-of-K selection bias). So candidates are
ranked on **TRAIN only**; the single winner gets **one** held-out confirmation.
Keep K small — the more candidates you screen on train, the more optimistic the
winner's train number, and only the one held-out run keeps it honest.

## 3. The generality + leak auditor (adversarial sub-agent)

Before applying ANY change, spawn a fresh sub-agent to try to reject it. It is
adversarial on purpose — its job is to find the reason this is gaming, not to
approve. Give it the diff (or the injected-context text), the diagnosed pattern,
and this instruction:

> You are auditing a proposed change to a code-review agent that is being tuned
> against an eval. Your job is to REJECT changes that game the eval instead of
> genuinely improving the reviewer. Default to REJECT when unsure.
>
> REJECT if the change:
> 1. names or targets a specific repository, `instance_id`, file path, function,
>    or PR — a generic prompt/skill/persona edit (lever a) must apply to any repo;
> 2. encodes the eval's gold answer — e.g. injected repo context or a prompt that
>    describes the specific findings the agent is "supposed to" make. Injected
>    repo context must read as plausible standing maintainer guidance written
>    WITHOUT knowledge of this PR's bug (conventions, architecture, review
>    priorities), never "check for <the specific issue>";
> 3. hard-codes an answer, a magic string, or a case count to pass a known case;
> 4. (for a gold/eval edit) lacks concrete evidence that the existing gold is
>    wrong — "it makes a case pass" is not evidence.
>
> Otherwise ACCEPT. Reply with a verdict (ACCEPT/REJECT) and a one-line reason.

A REJECT sends you back to reformulating a more general change. Record the verdict
either way.

## 4. The lever ladder + sign-off

Generic (a) edits auto-apply once the auditor passes. Per-repo context (b) and any
gold/PR-text edit (c) **stop for human sign-off** with a written justification —
they are the game-able levers, so a human always ratifies them. Never edit
`review_gold` to make a failing case pass; only when the gold is demonstrably wrong.

## 5. Never touch core

Edits live in `instance/` (overlay) and, with sign-off, dataset sidecars / gold.
Core workflow code is never modified — the whole value of the harness is that the
*real* workflow runs. If a fix seems to require a core change, it's out of scope
for the loop; note it for the maintainers instead.

## 6. Auditable journal + provenance

Every hypothesis → diff → train/held-out deltas → decision is recorded
(references/journal-format.md), and every run records which injected context it saw
(`injectedContext` on each result). A reviewer can reconstruct exactly what changed
and why the number moved — no silent wins.

## The keep/revert decision, precisely

```
best-of-K selection (per round, before the gate below):
    rank surviving candidates on TRAIN ONLY  ->  winner = highest trainΔ
    (tie-break: lowest lever, smallest diff, fewest train per-case regressions)
    then apply the gate below to the WINNER, consuming held-out ONCE.
lever (a) generic:
    KEEP  iff  trainΔ > epsilon  AND  heldoutΔ >= -epsilon   (else REVERT)
    (--symmetric variant, for a held-out-driven candidate:
        KEEP iff trainΔ >= -epsilon AND heldoutΔ >= -epsilon AND max(both) > epsilon)
lever (b) per-repo:
    KEEP  iff  that case improved  AND  auditor ACCEPTED  AND  human approved
              (recorded as a per-repo recommendation; no held-out claim)
lever (c) gold/eval:
    APPLY iff  auditor ACCEPTED  AND  human approved  AND  evidence recorded
              (this changes what "correct" means — it's a dataset fix, not a score win)
```

If a split is missing (e.g. you forgot to run held-out), the helper says
INCONCLUSIVE / REVIEW rather than KEEP — don't keep on train alone.
