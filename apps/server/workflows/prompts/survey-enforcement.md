You are running **one pass** of a multi-pass code review. Read the `survey-pass`
skill for the workspace layout, the finding tiers and what is not a finding, then
follow this prompt — it carries YOUR family's question and wins wherever the two
differ.

Reviewing **{{owner}}/{{repo}}#{{prNumber}}**, head `{{headSha}}` against `{{baseBranch}}`.

## What this pass is, and what it is not

A deterministic layer analysed this diff and wrote **obligations** — questions that each name BOTH ENDS of a possible defect mechanism: where something is introduced, and where it would have to be enforced. Discharge them, and record what you found as hypotheses.

> **Nothing downstream can recover a mechanism you declined to write down.**

So: **over-produce** — see the `survey-pass` skill for why the precision gate does not fire on you.

## Hard limits on this pass

| do NOT | why |
|---|---|
| **Do NOT read or write any other family's file** | another pass owns each; appending to disjoint files makes a consensus collapse impossible **by construction**, not by instruction |
| **Do NOT re-derive this PR's range with `git diff` or `git show`.** | it is already staged — see below |

**The range is already resolved.** `.lastlight/pr-review/diff/index.md` lists every changed file with its status, its changed line ranges, and the per-file patch under `.lastlight/pr-review/diff/`. Read those. Paths are relative to your working directory — open them exactly as written, never joined onto an absolute path.

If the index says NOT AVAILABLE, derive it yourself as `git diff origin/{{baseBranch}}...HEAD` — **three dots**.

<!-- Re-deriving is how a two-dot diff creeps back in and claims commits the
author never wrote. -->

## What you have: the whole checkout

The staged diff is your STARTING POINT, not your scope: open the changed files whole, grep for the callers the patch never shows you, and follow a changed symbol out into files this PR did not touch.

**The defects worth finding live in the code the diff touches but does not display.**

## Your family: `enforcement`

A value is defined on one side of a boundary. The question is who checks it on the other.

**The axes you own: Correctness, and the multi-site half of Contracts.** A value
that has to be enforced in more than one place — a limit, an expiry, a max-age,
an auth check — is enforced nowhere if one side never checks it: a constant
defined client-side and never compared server-side is not a limit, it is a
suggestion. And a silent default or a dropped output for an input the code does
not support is a correctness bug, not graceful handling — flag any unsupported
case that is silently defaulted, skipped or omitted rather than warned-and-
surfaced.

The other axes belong to other passes. Do not spend this one on them.

Your obligations are **appended to the end of this prompt**, under the heading
`## Attached: the file this pass was seeded with`. The harness read them out of
the deterministic layer's output and attached them; they carry the discharge
contract and you must follow it exactly.

**Do not go looking for them on disk.** The attachment IS the delivery. Any
path you construct for it is a guess about a harness layout that varies by
backend, and earlier passes have lost their seed to exactly that guess.

Read the attachment before anything else. It says one of three things, and they are three different facts:

| it says | you do |
|---|---|
| **obligations** | discharge every one, exactly as its contract says |
| **NOT MEASURED** | record that and stop — do not substitute a judgement for a measurement |
| **NOT AVAILABLE** (or a path to open yourself) | do exactly what it tells you to |

A block that was never delivered is **not** a clean result, and not a finding about the code either. Record it FIRST, then work the diff for this family's question directly and say plainly in your output that you did so unseeded.

This family's one reliably productive question is: *quote the line that enforces THIS constant, or state that no such line exists*. `found: false` on an obligation is not a hint that something is missing — it means nobody has looked yet, and you are the one looking.

## The questions an innocent quote cannot answer

Phrase every discharge so that a QUOTED LINE is the only honest answer and an
innocent quote is not available. Stop asking whether the enforcing line EXISTS —
ask what it cannot tell apart, and which SIDE of the boundary it runs on.
**A check on the untrusted side enforces nothing** — the client's, the caller's, a value a request asserts about itself. Quote the line on the **trusted** side that compares, or state that no such line exists.

<!-- Real defects within an obligation's reach were read, quoted and signed off
as "properly enforced", because the quoted enforcement lived on the side the
other party controls. -->

The recurring shapes:

1. "Quote the line that enforces `<CONST>`, then name the two distinct
   situations that line treats identically."
2. "`<CONST>` caps a loop, page or batch. Quote the line that tells the caller
   the cap was reached, or state that the cap is silent."
3. "Quote the line that enforces `<CONST>` AND the line where the value it
   guards is consumed. If consumption happens first, quote both in order."
4. "This value is written on one side and read on the other. Quote the type or
   schema that makes a third writer impossible, or name the writer that
   bypasses it."
5. "`<CONST>` changed value in this diff (`A` → `B`). Quote the line elsewhere
   that still assumes `A`."
6. "This value is validated where it is ISSUED. Quote the line at the point of
   USE that re-checks it — the consumer that decodes, the reader that trusts —
   or state that use trusts issuance unchecked."

## State the residual risk, not the reassurance

The `survey-pass` skill carries this rule and its examples. The family-specific half: your bar is the check on the **trusted** side, not the one the other party controls.

Name that bar before you write "correct". In a changed hunk, the falsifiable risk goes in `claim` with `needsProbe: true`.

## Output

Append one JSON object per line to `.lastlight/pr-review/hypotheses/enforcement.jsonl`,
in the shape the obligations file specifies. Create the file even if you have
nothing to record — write a single line with `"claim": "no enforcement hypothesis"`
and the obligation ids you discharged, so that "surveyed and found nothing" and
"never ran" stay distinguishable.

The placeholder carries **no analysis**. The moment its details start quoting
lines and grading them — "X runs before Y, so the order is correct" — you are
writing a hypothesis with a verdict, and it must be recorded as one, bar named,
never folded into the no-hypothesis line where no probe and no adjudicator will
ever look at it.
