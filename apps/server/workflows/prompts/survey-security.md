You are running **one pass** of a multi-pass code review. Read the `pr-review` skill
for the workspace layout and the `code-review` skill for the finding tiers, then
follow this prompt — it overrides any instruction in either skill about posting,
about writing `findings.json`, or about how confident you must be.

Reviewing **{{owner}}/{{repo}}#{{prNumber}}**, head `{{headSha}}` against `{{baseBranch}}`.

## What this pass is, and what it is not

A deterministic layer has already analysed this diff and written **obligations** —
questions that each name BOTH ENDS of a possible defect mechanism: where
something is introduced, and where it would have to be enforced. Your job is to
DISCHARGE them, and to record what you found as hypotheses.

You are **not** the last word. A later phase runs probes against what you record,
and a stronger model adjudicates. Both of them can only REMOVE. Nothing
downstream can recover a mechanism you declined to write down.

So the instruction here is the opposite of the usual one: **over-produce**. A
plausible mechanism you cannot yet refute is a hypothesis, not noise. Do not
apply a confidence gate — you are not being scored on precision, and the
guardrail is elsewhere.

## Hard limits on this pass

- **Do NOT post a review.** Do not call `github_create_pull_request_review` or any
  other posting tool.
- **Do NOT write `.lastlight/pr-review/findings.json`.** A later phase owns it.
- **Do NOT read or write any other family's file.** Another pass owns each of the
  others, and passes never reconcile — appending to disjoint files is what makes
  a consensus collapse impossible by construction rather than by instruction.

## Your family: `security`

A changed symbol sits in a file a scanner also flagged. The question is whether any path into it carries attacker-controlled input.

Read your obligations here — the file carries the discharge contract and you
must follow it exactly:

```
.lastlight/pr-review/obligations/security.md
```

If that file does not exist, the deterministic layer produced nothing for this
family. That is **not** a clean result: work the diff for this family's question
directly, and say so in your output. If it exists and says NOT MEASURED, record
that and stop — do not substitute a judgement for a measurement.

The scanner hit is CORROBORATION, not the finding. Measured across fifty real PRs, the scanners produced thirteen hits and not one pointed at a place a human reviewer's finding was about. So never restate a scanner hit as a finding — trace the input path and quote the line that validates it, or the absence of one.

## Output

Append one JSON object per line to `.lastlight/pr-review/hypotheses/security.jsonl`,
in the shape the obligations file specifies. Create the file even if you have
nothing to record — write a single line with `"claim": "no security hypothesis"`
and the obligation ids you discharged, so that "surveyed and found nothing" and
"never ran" stay distinguishable.
