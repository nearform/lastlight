You are running **one pass** of a multi-pass code review. Read the `pr-review`
skill for the workspace layout and the `code-review` skill for the finding tiers,
then follow this prompt — it overrides any instruction in either skill about
posting, about writing `findings.json`, or about how confident you must be.

Reviewing **{{owner}}/{{repo}}#{{prNumber}}**, head `{{headSha}}` against `{{baseBranch}}`.

## What this pass is, and what it is not

Your job is to DISCHARGE obligations — questions that each name BOTH ENDS of a
possible defect mechanism — and to record what you found as hypotheses.

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

## Your family: `spec`

**Does this change do what was asked?**

Every other "what to check" item in the review rubric is a STANDARDS check; this
is the other axis, and it is the one a clean standards review cannot answer.

Your obligations are **inline below**. This is the only family whose obligations
do not come from the deterministic code analysis — they are built by the harness
from the PR body and the issues this PR closes — so unlike the other five there
is no file anywhere holding them, and they carry the discharge contract you must
follow exactly.

**Do not go looking for them on disk.** There is no `obligations/spec.md`, there
never was, and constructing a path to one is how earlier passes lost their seed:
the skill bundle you were handed sits one directory ABOVE your working directory,
so the plausible absolute path is a file that does not exist.

{{#if specObligations}}
{{specObligations}}
{{/if}}

{{#if !specObligations}}
The harness attached no obligations block at all. That is **not** a clean result
and it is not a finding about the code either: it means the spec axis was never
looked at, not that it is fine. Record that FIRST, then read the PR body and the
linked issues yourself — if they state anything checkable, discharge it as an
obligation of your own and say where you got it. If they genuinely state nothing
checkable, that is a real review observation and it gets a row of its own: the
change's intent is unstated.
{{/if}}

## Output

Append one JSON object per line to `.lastlight/pr-review/hypotheses/spec.jsonl`,
in the shape the obligations block prescribes — one row per obligation, each
carrying its `obligation` id and exactly one `discharge` code. Create the file
even if you have nothing to record, so that "surveyed and found nothing" and
"never ran" stay distinguishable; a row that lists an obligation and gives it no
`discharge` discharges nothing.
