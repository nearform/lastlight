# Journal format — the auditable ledger

The loop appends one entry per iteration to a single Markdown file, by default
`eval-results/loop-journal.md` in the workspace (next to the runs it references).
It is the record that lets a human reconstruct every change and why the score
moved — keep it complete even for reverted iterations (a revert is a result).

## Header (write once, at the top)

```markdown
# pr-review improvement loop

- Model under test: anthropic/claude-sonnet-5   (iterating cheap: haiku)
- Judge model: <EVAL_JUDGE_MODEL or default>
- Target: F1 >= 0.55  (or: improve until 3 consecutive no-keep iterations)
- Split (FIXED for this loop):
  - TRAIN   (n): id1, id2, id3, ...
  - HELDOUT (n): idA, idB, ...
- Baseline: train F1 = 0.33, heldout F1 = 0.31   (runIds: <train>, <heldout>)
```

## Per-iteration entry

```markdown
## Iteration <N> — <one-line hypothesis>

- Pattern: <the systematic failure named in §3, e.g. "posts style nits the rubric suppresses (precision loss across 4 train cases)">
- Lever: (a) generic | (b) per-repo | (c) gold   — <why this lever; why not lower>
- Change:
    file: instance/skills/code-review/SKILL.md
    diff: |
      <the actual diff, or the injected-context text>
- Auditor: ACCEPT | REJECT — <one-line reason>
- Applied: auto | human-approved (<who/when>) | not applied (auditor rejected)
- Result (diff-runs.ts):
    train:   0.33 -> 0.41   (Δ +0.08)
    heldout: 0.31 -> 0.31   (Δ +0.00)
    per-case regressions: 0
- Decision: KEEP | REVERT | (b) recorded as per-repo recommendation
- Running best: train F1 = 0.41, heldout F1 = 0.31
```

## Rules

- **One entry per iteration**, including reverts and auditor rejections — the tail
  of no-keep iterations is the plateau signal.
- Paste the **actual diff / context text**, not a paraphrase — the point is
  reproducibility.
- Always record **both** train and held-out deltas. A missing held-out number
  means the decision is INCONCLUSIVE, not KEEP.
- For lever (b)/(c), record the **human sign-off** and, for (c), the **evidence**
  that the gold was wrong.
- Keep the **Running best** line current — it's the at-a-glance progress toward
  the target and the input to the plateau check.
