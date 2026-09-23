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

## Your family: `security`

A changed symbol sits in a file a scanner also flagged. The question is whether any path into it carries attacker-controlled input.

**The axes you own: Security and the input-shaped half of Edge cases.**
Injection, authn/authz, secret handling, untrusted input, and what a guard does
with an input shape it was not written for.

**A hazard is not a boundary crossing.** The `Critical` bar is the `survey-pass` skill's. The half that is yours: a hazard that fails that bar is still **recorded, at its real tier** — demoting is not dropping — and an inflated one spends a maintainer's top slot on a hazard nobody can reach.

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


## What closes the mechanism, for `security`

The `survey-pass` skill's evidence record is shared by every pass; `control_site` is the
only field whose meaning is yours to fix. For this family the control is a **sanitiser, escape or authorisation check between the source and the sink** — the line that makes the tainted value safe, at a point the attacker does not control.

**Every row carries an `evidence` object**, in the shape the `survey-pass` skill defines. It is
how the verdict is computed, and a row without one cannot be ranked by anything — it falls back
to a guess. Add it to every row you write.

**You do not write `severity` or `needsProbe`.** If the attached block's example row shows them,
ignore those two fields: they are derived from your evidence, not chosen by you. Everything else
the attachment prescribes still applies.

Worked example — invented, for SHAPE only, showing the fields this family fills:

```json
{"id": "security-001", "obligation": "O-001", "family": "security", "evidence": {"subject": "req.query.next", "control_site": "src/routes/login.ts:88", "control_text": "const next = String(req.query.next ?? \"/\");", "authority": "advisory", "order_ok": true, "cannot_distinguish": "a relative path and an absolute URL to another origin", "bypass": "none found", "in_changed_hunk": true, "consequence": "a caller supplies an absolute URL and the redirect leaves the origin, carrying the session referer", "trigger": "input", "crosses_boundary": true, "capability_gained": "redirecting an authenticated user to an origin the attacker controls"}, "claim": "the redirect target is coerced to a string but never constrained to this origin, so an absolute URL passes through"}
```

## State the residual risk, not the reassurance

The `survey-pass` skill carries this rule and its examples. The family-specific half: your bar is the **trust boundary crossed**, not that a check exists somewhere.

Name that bar before you write "correct". In a changed hunk, the falsifiable risk goes in `claim` with `needsProbe: true`.

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
