# Approach & prior art — why the loop looks like this

This loop is a **self-improving harness**: it edits the reviewing agent's harness
(prompts, skills, persona, injected repo-context) — never its weights and never the
core workflow — and keeps only edits that a blind held-out split confirms.

## Prior art: *Self-Harness*

The structure follows ***Self-Harness: Harnesses That Improve Themselves***
([arXiv:2606.09498](https://arxiv.org/abs/2606.09498)), which runs a three-stage
cycle on a fixed model: **mine weaknesses → propose K minimal candidate edits →
validate on held-in *and* held-out under a non-regressive gate**, keeping only edits
that don't degrade either split. Its notable result: the retained edits are
concrete and evidence-grounded, "not generic instruction padding."

We adopt the parts that make our loop better-grounded and better-explored, and
deliberately *diverge* where our anti-gaming constraints are stricter than the
paper's.

| Self-Harness stage | Here | Where |
|---|---|---|
| Weakness mining (cluster failing traces by signature, ranked by impact) | `scripts/mine-failures.ts` → ranked recall/precision signature bundle from TRAIN traces | SKILL §3 |
| K diverse minimal candidate edits | Draft K=2–4 minimal candidates, each a different mechanism/formulation | SKILL §4 |
| Validate on both splits, non-regressive gate | **TRAIN selects, HELD-OUT confirms once**; default asymmetric gate, opt-in `--symmetric` for the paper's rule | SKILL §7, `diff-runs.ts` |
| Document each transition | The per-round journal (all candidates + winner + held-out Δ) | `journal-format.md` |

## Where we diverge from the paper (on purpose)

- **Held-out is consumed once per round, not once per candidate.** The paper gates
  each candidate on held-out. Because our loop can *see* the gold set, screening K
  candidates on the blind split and keeping the best would inflate it (max-of-K
  selection bias). So we rank on TRAIN only and give the single winner one held-out
  confirmation. See guardrails §2.
- **Generic-first, not model-specific.** The paper found value in *model-specific*
  harness edits. Our default lever must generalize across **repos** (the held-out
  split is a repo split), so we prefer generic overlay edits and gate them on
  held-out. A model-specific-but-repo-generic lever is a possible future escalation,
  but it is **not** part of this loop today — don't reach for it.
- **A leak/generality auditor gates every candidate.** The paper relies on the
  held-out gate alone; we add an adversarial auditor (guardrails §3) because a loop
  that can read the gold answer can encode it — a failure mode the paper's setup
  doesn't face.
- **Human sign-off on the game-able levers.** Per-repo context (b) and gold edits
  (c) are case-scoped with no held-out claim, so a human ratifies them.

The net: same mine → propose → validate skeleton, hardened for a loop that can see
the answers it is being graded against.
