# The three levers — what to edit, and the escalation ladder

All three levers change eval outcomes **without touching core** — the real
production workflow always runs unmodified. You only edit the deployment overlay
(`instance/`) and, with sign-off, the dataset. Prefer the lowest lever that can
move the whole failure cluster; escalate only with a written reason.

## Pattern → lever map

| Diagnosed pattern (from TRAIN traces) | Most likely lever |
|---|---|
| Posts noise / nits the rubric says to suppress (precision loss) | (a) tighten the severity/precision bar in `code-review` skill |
| Misses a whole class of real issues, e.g. security, concurrency (recall loss) | (a) add that class to the reviewer's what-to-check rubric/prompt |
| Reviews against the wrong conventions for a repo | (a) generic repo-context, or (b) per-repo context |
| Wrong-fit findings because it lacks a repo's build/test/domain norms | (b) per-repo `AGENTS.md` (a portable recommendation) |
| A gold comment is a non-actionable nit, or a clear real finding scores as a false positive because gold omits it | (c) fix the gold — rare, evidence required |

## (a) Prompts / skills / persona + generic repo-context — *generic, auto*

The preferred lever. A change here must generalize to every repo. Edit copies in
the overlay (fork with `lastlight fork <workflow>` / `lastlight fork agent-context`,
or create the shadowing file at the same logical path — see the **lastlight-overlay**
skill). Common targets:

- `instance/skills/code-review/SKILL.md` — the severity rubric + precision bar
  (what findings survive). The highest-leverage file for precision problems.
- `instance/skills/pr-review/SKILL.md` — the review procedure (confidence gate,
  findings-file contract).
- `instance/workflows/prompts/reviewer.md` — the reviewer prompt text.
- `instance/workflows/pr-review.yaml` — phase wiring (which skills a phase loads).
- `instance/agent-context/rules.md` / `soul.md` — global persona/rules the agent
  reads via the workspace `AGENTS.md`.
- `instance/repo-context/AGENTS.md` — **generic** synthetic repo context the
  harness injects into *every* seeded pr-review repo. Use for guidance that would
  help a reviewer on any codebase (e.g. "prefer concrete, line-anchored findings;
  suppress pure style nits"). Held-out gates a keep, so it must genuinely
  generalize.

## (b) Per-repo injected context — *portable finding, signed-off*

A dataset sidecar the harness injects **only for that case's repo**:

```
datasets/pr-review/context/<instance_id>/AGENTS.md      (or CLAUDE.md)
```

This is the *"add this to your repo and your reviews improve by X"* recommendation
— honest because it's exactly what a maintainer could commit. It is **case-scoped**,
so the held-out generalization gate doesn't apply; instead it needs human sign-off
and must pass the no-gold-leak auditor (it must NOT describe this PR's specific
findings — only standing repo conventions, architecture, and review priorities).

How injection works (so you can trust it lands): the harness writes the block into
the file the agent's runtime actually reads — it appends to an existing
`AGENTS.md`, else an existing `CLAUDE.md` (never creating an `AGENTS.md` that would
shadow it), else creates a fresh `AGENTS.md`. Pi auto-loads that file walking up
from the agent's cwd, so it reaches the model every phase with no prompt change.
Toggle off for a clean control run with `--no-inject-context` (or
`EVAL_INJECT_CONTEXT=0`). Provenance is recorded on each result
(`injectedContext`).

## (c) The eval itself — *rare, signed-off*

Edit the case in `datasets/pr-review/instances.json`:

- `review_gold[]` (`{ file?, line?, severity, description }`) — the correct answer.
- `pr.body` / `problem_statement` — what the agent is told about the PR.

Only when the gold is **demonstrably wrong or incomplete** — never to force a
failing case to pass. The justification must name the evidence (e.g. "the human
PR review made this exact point; gold omitted it, so a correct finding scored as a
false positive"). Martian's gold set is known-incomplete by design, so a
real-but-unlisted finding scoring as a false positive is expected — that is *not*
on its own grounds to edit gold; it's why the headline metric is F1, not F0.5.

## Escalation ladder

Try (a) first. Escalate to (b) only when the pattern is genuinely repo-specific
(a convention that doesn't generalize). Escalate to (c) only when the eval is
wrong. Record the reason for every escalation in the journal.
