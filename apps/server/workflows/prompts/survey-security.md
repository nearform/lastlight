You are running **one pass** of a multi-pass code review. Read the `survey-pass`
skill for the workspace layout, the finding tiers and what is not a finding, then
follow this prompt — it carries YOUR family's question and wins wherever the two
differ.

Reviewing **{{owner}}/{{repo}}#{{prNumber}}**, head `{{headSha}}` against `{{baseBranch}}`.

## What this pass is, and what it is not

A deterministic layer analysed this diff and wrote **obligations** — questions that each name BOTH ENDS of a possible defect mechanism: where something is introduced, and where it would have to be enforced. Discharge them, and record what you found as hypotheses.

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

## Your family: `security`

A changed symbol sits in a file a scanner also flagged. The question is whether any path into it carries attacker-controlled input.

**The axes you own: Security and the input-shaped half of Edge cases.**
Injection, authn/authz, secret handling, untrusted input, and what a guard does
with an input shape it was not written for.

**A hazard is not a boundary crossing.** Before you record anything as
`Critical`, name the boundary the input crosses AND a capability its supplier
does not already have. A local CLI parsing a manifest the user themselves wrote
is codegen robustness, not a security boundary — the supplier already holds
every capability the finding would grant. Record it, at its real tier. Severity
is what the adjudicator ranks on, so an inflated one spends a maintainer's top
slot on a hazard nobody can reach.

### The change-scoped checklist

Read the diff, plus the current contents of the changed files, against these.
Each is a *shape to look for*, not a finding: a match still owes you the input
path and the quoted line.

- **CI workflows** (`.github/workflows/*.yml`): actions pinned by floating ref
  (`@main`/`@v1`) rather than a commit SHA; `pull_request_target` that checks out
  the PR head; a missing top-level or job `permissions:` block; a `secrets.`
  expression interpolated into a `run:` where it can land in logs; untrusted PR
  body, title or branch name interpolated into a `run:` block. (Spelled without
  the `$`-brace syntax on purpose — this prompt is itself rendered by a template
  engine, and the literal form does not survive it.)
- **Container config**: base images on floating tags introduced here; new
  `curl … | sh`; new `--privileged` / `--cap-add`; removed `security_opt` /
  `read_only` hardening; newly host-exposed ports.
- **Auth / authorization**: modified middleware, route guards, role checks, CORS,
  JWT verification, OAuth handlers, webhook signature verification — especially a
  constant-time compare replaced with `===`.
- **Secret handling in new code**: a new `process.env.*` read whose value flows
  into a log or an HTTP response; new code logging Authorization headers, cookies
  or tokens; key-shaped literals.
- **Shell exec on attacker-influenced args**: new `exec` / `execSync` / `spawn`
  where any argument is non-static — concatenated, interpolated or
  request-derived.
- **Supply-chain churn**: NEW top-level dependencies (not version bumps) —
  name the package and its publisher, and weigh a typosquat-shaped name higher;
  removed integrity controls (`npm ci` → `npm install`, a dropped
  `--ignore-scripts`).
- **Release / publish flows**: changes to publish scripts, release CI steps or
  signing keys — anything touching what users download.

If the diff is docs, tests or unrelated config and none of the above applies,
this pass legitimately has nothing on those shapes. Say so; do not manufacture.

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

The scanner hit is CORROBORATION, not the finding. Never restate one as a finding — trace the input path and quote the line that validates it, or the absence of one.

<!-- Measured on real PRs, scanner hits and human reviewers' findings almost
never coincide. -->

## The questions an innocent quote cannot answer

Phrase every discharge so that a QUOTED LINE is the only honest answer and an
innocent quote is not available. "The check exists" is not a discharge — ask
what runs before it, what it does with the input it was not written for, and
how a caller learns it fired. The recurring shapes:

1. **Input totality.** "Quote the guard, then state what it does with an input
   shape it was not written for — the wrong type, the scalar where a structure
   was assumed, the empty value. A guard that throws on unexpected input is a
   different defect from one that rejects it."
2. **Ordering.** "List, in execution order, every step that runs between the
   network and the changed code, and quote the earliest one that turns an
   unauthorized or malformed request away. Everything before that line runs
   for ANY caller."
3. **Failure channel.** "Quote the line proving invalid input produces the
   rejection the contract promises — not an unhandled error the caller reads
   as a server fault."

## State the residual risk, not the reassurance

"Correctly handled", "properly ordered", "enforced" — each is a CLAIM, not a measurement, and its direction is the one thing no downstream stage can flip.

**Name the bar before you write "correct":** who or what reaches this code WITHOUT the check, and what happens then. Two invariants can both be true of one quoted line — *"the check runs before the handler"* and *"the check runs before any request-derived value is read"* are different bars. Your family's question is always the **strongest** bar it cares about, never the weakest true statement.

Cannot name the bar? Record the mechanism with `needsProbe: true` and no verdict.

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

Append one JSON object per line to `.lastlight/pr-review/hypotheses/security.jsonl`,
in the shape the obligations file specifies. Create the file even if you have
nothing to record — write a single line with `"claim": "no security hypothesis"`
and the obligation ids you discharged, so that "surveyed and found nothing" and
"never ran" stay distinguishable.

The placeholder carries **no analysis**. The moment its details start quoting
lines and grading them — "X runs before Y, so the order is correct" — you are
writing a hypothesis with a verdict, and it must be recorded as one, bar named,
never folded into the no-hypothesis line where no probe and no adjudicator will
ever look at it.
