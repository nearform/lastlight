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

## Per-round entry

A round mines one pattern, explores K candidates (ranked on TRAIN), and keeps at
most one (confirmed on HELD-OUT once). A single-candidate round is just K=1.

```markdown
## Round <N> — <one-line hypothesis for the top pattern>

- Pattern: <the systematic failure named in §3, e.g. "misses security-relevant findings (recall·high, 4 train cases)"; from mine-failures.ts>
- Candidates (ranked on TRAIN only):
  | # | lever | change (file) | trainΔ | auditor |
  |---|-------|---------------|--------|---------|
  | 1 | (a)   | instance/skills/code-review/SKILL.md | +0.08 | ACCEPT |
  | 2 | (a)   | instance/workflows/prompts/reviewer.md | +0.03 | ACCEPT |
  | 3 | (a)   | instance/repo-context/AGENTS.md | -0.01 | REJECT (leak) |
- Winner: #1 — <why (highest trainΔ; tie-break rule if used)>
- Winner change:
    file: instance/skills/code-review/SKILL.md
    diff: |
      <the actual diff, or the injected-context text>
- Applied: auto | human-approved (<who/when>) | not applied (auditor rejected)
- Held-out confirmation (diff-runs.ts, winner only — held-out consumed ONCE):
    gate:    default | --symmetric
    train:   0.33 -> 0.41   (Δ +0.08)
    heldout: 0.31 -> 0.31   (Δ +0.00)
    per-case regressions: 0   (REGRESSED(train): none)
- Decision: KEEP | REVERT | (b) recorded as per-repo recommendation
- Reverted losers: #2, #3
- Running best: train F1 = 0.41, heldout F1 = 0.31
```

## Rules

- **One entry per round**, including all-revert rounds and auditor rejections — the
  tail of no-keep rounds is the plateau signal. Record every candidate's train Δ,
  not just the winner's, so the best-of-K selection is auditable.
- Paste the **actual diff / context text**, not a paraphrase — the point is
  reproducibility.
- Always record **both** train and held-out deltas. A missing held-out number
  means the decision is INCONCLUSIVE, not KEEP.
- For lever (b)/(c), record the **human sign-off** and, for (c), the **evidence**
  that the gold was wrong.
- Keep the **Running best** line current — it's the at-a-glance progress toward
  the target and the input to the plateau check.
