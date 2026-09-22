You are running **one pass** of a multi-pass code review. Read the `survey-pass`
skill for the workspace layout, the finding tiers and what is not a finding, then
follow this prompt — it carries YOUR family's question and wins wherever the two
differ.

Reviewing **{{owner}}/{{repo}}#{{prNumber}}**, head `{{headSha}}` against `{{baseBranch}}`.

## What this pass is, and what it is not

Your job is to DISCHARGE obligations — questions that each name BOTH ENDS of a
possible defect mechanism — and to record what you found as hypotheses.

You are **not** the last word. A later phase probes what you record; a stronger model adjudicates. Both can only REMOVE.

> **Nothing downstream can recover a mechanism you declined to write down.**

So: **over-produce.** A plausible mechanism you cannot yet refute is a hypothesis, not noise. Apply no confidence gate — you are not scored on precision, and the guardrail is elsewhere.

## Hard limits on this pass

| do NOT | why |
|---|---|
| **Do NOT post a review** — no `github_create_pull_request_review`, no posting tool | you are not the last word |
| **Do NOT write `.lastlight/pr-review/findings.json`** | a later phase owns it |
| **Do NOT read or write any other family's file** | another pass owns each; appending to disjoint files makes a consensus collapse impossible **by construction**, not by instruction |
| **Do NOT re-derive this PR's range with `git diff` or `git show`.** | it is already staged — see below |

**The range is already resolved.** `.lastlight/pr-review/diff/index.md` lists every changed file with its status, its changed line ranges, and the per-file patch under `.lastlight/pr-review/diff/`. Read those. Paths are relative to your working directory — open them exactly as written, never joined onto an absolute path.

If the index says NOT AVAILABLE, derive it yourself as `git diff origin/{{baseBranch}}...HEAD` — **three dots**.

<!-- Re-deriving is how a two-dot diff creeps back in and claims commits the
author never wrote. -->

## What you have: the whole checkout

You are in the complete repository at head, not a patch file. The staged diff is your STARTING POINT, not your scope:

- open the changed files whole, and read either side of every hunk
- grep for the callers and references the patch never shows you
- follow a changed symbol out into files this PR did not touch

That is the work, not a licence. **The defects worth finding live in the code the diff touches but does not display.**

## Your family: `spec`

**Does this change do what was asked?**

**The axes you own: Fit, and the falsifiable half of documentation.** Does the
change match what was asked and how this repository already does things — and
does any doc line, comment or example it touches make a claim about behaviour
that is FALSE at head? A description that under-describes the change is prose. A
sentence the code can falsify is a finding.

Every other "what to check" item in the review rubric is a STANDARDS check; this
is the other axis, and it is the one a clean standards review cannot answer.

Your obligations are **inline below**. This is the only family whose obligations
do not come from the deterministic code analysis — they are built by the harness
from the PR body and the issues this PR closes — so unlike the other five there
is no file anywhere holding them, and they carry the discharge contract you must
follow exactly.

**Do not go looking for them on disk.** There is no `obligations/spec.md`, there
never was; any path you construct for one is a guess about a harness layout
that varies by backend, and earlier passes have lost their seed to exactly
that guess.

A spec claim in the PR body is a claim to TEST, not a box to tick: for each
one, look for the input or state that would falsify it before you write
`QUOTE`. And the ask includes the feature's PURPOSE. When the change adds a
mode whose whole point is to stand in for another path — a dry run, a preview,
a plan, a validation pass — check that it exercises the code whose behaviour
it claims to predict: a rehearsal that skips the path it rehearses does not do
what was asked, however plausible its output looks.

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

## State the residual risk, not the reassurance

"Implemented as asked", "enforced" — each is a CLAIM, not a measurement, and its direction is the one thing no downstream stage can flip.

**Name the bar before you write `QUOTE`:** what input, caller or state would make the claim false, and where you looked for it. Two readings can both be true of one quoted line — *"the gate exists"* and *"the gate holds for every caller the ask cares about"* are different bars. The ask's bar is always the stronger one.

Cannot name the bar? Record the mechanism with no verdict.

**In a changed hunk: record the risk, not the reassurance.** The falsifiable risk goes in `claim`, `needsProbe: true`; the reasoning that reassured you goes in the discharge field.

| don't write | write |
|---|---|
| `the page cap is properly enforced` | `when the cap fires, the caller gets a truncated result and no signal that it was truncated` |
| `the client is configured with retry and rate-limit handling` | `a rate-limited call is dropped rather than retried` |
| `the body is validated before use` | `a non-object body reaches the property check and throws` |

Same reading, same evidence. Only the right column can be probed — and the probe
is the only thing that moves a verdict in the direction you graded against. If
you were right, it gets refuted and withheld, and the bar was tested rather than
asserted.

## Output

Append one JSON object per line to `.lastlight/pr-review/hypotheses/spec.jsonl`,
in the shape the obligations block prescribes — one row per obligation, each
carrying its `obligation` id and exactly one `discharge` code. Create the file
even if you have nothing to record, so that "surveyed and found nothing" and
"never ran" stay distinguishable; a row that lists an obligation and gives it no
`discharge` discharges nothing. And a row is a record, not a hiding place: the
moment its details quote lines and grade them, it is a hypothesis with a
verdict and must say so, bar named.
