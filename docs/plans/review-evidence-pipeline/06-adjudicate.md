# WP6 — adjudication, the evidence packet, and the split verdict

**Goal.** Turn the hypothesis union plus its probe transcripts into
`findings.json` — ranked, tiered, with a split verdict and a per-finding evidence
packet — without reintroducing the suppressor that killed candidate v2.

**Depends on:** [WP3](03-seed-and-survey.md), [WP4](04-probe-oracle.md). **Both
are built and gate-green as of 2026-08-22**, so nothing blocks this — but see
[RESTART §2d](RESTART.md) for the two measured facts that change what you should
build, and the ordering that follows from them.

> **Three prerequisites verified against the tree 2026-08-22, because each is
> assumed below and none of them exists yet.**
>
> - **`existingCode` is not a finding field.** It appears only in the hypothesis
>   contract `lastlight-facts seed` renders (`seed-render.ts`); nothing in
>   `apps/server` knows it. `findings-schema.md` still makes `line` **required**
>   and model-produced. §"The model must stop emitting line numbers" is therefore
>   a real schema change, not a tightening.
> - **`maxInlineComments` does not exist anywhere.** §D11 already says so;
>   confirmed. `splitFindings` partitions on anchorability alone.
> - **`review_findings` does not exist** (`src/state/schema/sqlite.ts`). It is
>   [WP7](07-review-memory.md)'s table and WP7 depends on THIS work package, so
>   **AC1b's "written to `review_findings` with its reason" cannot be met as
>   written.** Decide deliberately: scope `internal` to `findings.json` and say
>   so, or pull that one table forward — remembering a schema change means BOTH
>   dialects regenerated (`src/state/CLAUDE.md`). Do not let it go quietly unmet.

## The constraint that shapes everything here

The obvious design — a ruthless judge that publishes only `PROVEN` and `STRONG`
— **is what v2 built, and it is what we reverted.** It worked mechanically and
micro-recall moved 1/25 → 2/25 while the precision canary regressed and cost went
2.4×. BitsAI-CR reproduces the result independently: its ReviewFilter raised
precision 54.5 → 67.1 and **cut recall 45.5 → 39.8**.

So the adjudicator's powers are deliberately asymmetric:

> **It may re-rank, re-tier, and demote a finding into the review body. It may
> delete a finding only when a probe transcript refutes it.**

Demotion is not suppression: `post-review` already renders off-diff findings into
the review body under an *"Additional findings"* heading
(`src/engine/github/review-poster.ts`), so a demoted finding is still **posted
and still visible** — it just is not an inline comment.

> **Note ([10-design-review.md](10-design-review.md) §D11).** `splitFindings`
> (`review-poster.ts:137`) partitions on **anchorability** — is the line on the
> diff — and there is **no inline cap today**, so `maxInlineComments` is
> genuinely new machinery rather than a reuse. After this WP, "Additional
> findings" would mean three different things: off-diff, below its family
> threshold, and overflowed the cap. Split the heading, or annotate each line
> with its reason — three causes under one heading is a worse review to read.

## The user-attention boundary

Preserving internal recall and spending a human's attention are two different
budgets, and conflating them is how a recall-first reviewer becomes unreadable.
**A candidate is never deleted for being noisy — but neither does every surviving
candidate earn an inline comment.**

So there are three destinations, and the boundary between them is explicit:

| Tier | Destination | Governed by |
|---|---|---|
| **inline** | a comment anchored to the diff line | above the family threshold **and** within `maxInlineComments` |
| **body** | the *"Additional findings"* list in the review body | everything else that passed adjudication |
| **internal** | `review_findings` only — never posted | below a floor, or a known-dismissed repeat ([WP7](07-review-memory.md)) |

`maxInlineComments` (default **8**) is a real budget: rank by confidence ×
severity, and everything past the cap goes to the body rather than being dropped.
The evidence is direct — *"Does AI Code Review Lead to Code Changes?"* (22k+ real
review comments) found **concise, hunk-level, actionable** findings substantially
more likely to lead to a code change. Twenty inline comments is not twenty times
the signal of eight; it is a muted bot.

Two properties this buys, both load-bearing:

1. **Recall and attention are measured at different boundaries.** The eval
   measures *internal recall* over everything the pipeline generated, and
   *attention cost* over what was posted inline ([08-evals.md](08-evals.md)).
   An intervention that finds more and shows less is legible as exactly that,
   instead of looking like a regression.
2. **The `internal` tier is auditable, not a dark drop.** Every internal-tier
   finding is written to `review_findings` with its reason, so "what did we know
   and not say?" is a query, not a guess. That is the difference between an
   attention boundary and the v2 suppressor.

## Per-check calibration, not a global gate

AutoCommenter (Google Critique) found a global threshold catastrophic — at
`t = 0.98`, **~80% of below-threshold predictions were still correct** — and
per-URL thresholds raised recall without hurting precision.

Our prompts contain exactly the falsified pattern: a single global *"only report
if confident"* instruction in `skills/code-review/SKILL.md`. Replace it with a
threshold per **obligation family**, configured and tunable:

```yaml
review:
  analysis:
    thresholds:
      contract:    0.35    # converts; cheap to check; bias to surface
      enforcement: 0.35
      security:    0.30
      state:       0.50
      tests:       0.60    # mechanical provenance, but noisier as prose
      spec:        0.45
```

A finding above its family threshold is a candidate for **inline**; below it, the
**body**. The inline set is then capped by `maxInlineComments`. These numbers are
**initial guesses to be tuned on the train split**, not measurements — say so in
the config comment, and record each retune in the eval journal.

```yaml
review:
  analysis:
    maxInlineComments: 8       # the attention budget; overflow goes to the body
    internalFloor: 0.15        # below this, recorded but not posted
```

## The split verdict — issue #271's fix 7

`findings.json` gains a verdict per axis:

```jsonc
{
  "skip": false,
  "summary": "…",
  "verdict": { "spec": "pass" | "fail" | "unknown",
               "standards": "pass" | "fail" | "unknown" },
  "event": "COMMENT",
  "findings": [ … ]
}
```

*"A blended verdict lets the passing axis hide the failing one."* A change that
is clean by every standards check but does not do what the issue asked is the
case a single `event` cannot express. `resolveEvent`
(`src/engine/github/review-poster.ts`) takes **the worse of the two axes**;
`event` remains explicit-wins so a fork can override.

Backward compatibility: `verdict` absent ⇒ today's behaviour exactly (empty
findings → `APPROVE`, non-empty → `COMMENT`, never auto-`REQUEST_CHANGES`).

## The evidence packet

Each finding carries its provenance, so the finding is a record rather than a
sentence:

```jsonc
{
  "path": "src/server/auth.ts", "line": 73, "side": "RIGHT",
  "severity": "Critical",
  "title": "Token expiry is never enforced server-side",
  "body": "…concrete impact…",
  "suggestion": "…",

  "mechanism": "value set on one side of a boundary, never checked on the other",
  "bothEnds": { "introducedAt": "src/config.ts:12", "enforcedAt": null },
  "evidence": [
    { "type": "reference", "detail": "MAX_TOKEN_AGE: 1 reference, client-side only" },
    { "type": "transcript", "ref": "probes/H-021.txt", "result": "reproduced" }
  ],
  "confidence": 0.82,
  "obligation": "O-014"
}
```

`post-review.ts` **ignores unknown fields for rendering** — the human-facing
comment is still `**[Severity] Title**` + body + optional suggestion. The packet
exists for [WP7](07-review-memory.md), the dashboard, and the evals. Extend
`skills/pr-review/references/findings-schema.md` with the new fields and mark
them optional so a forked prompt that omits them still posts.

## The phase

```yaml
  - name: adjudicate
    label: Adjudicate
    prompt: prompts/review-adjudicate.md
    model: "{{models.review}}"          # the strong model; the only one here
    generic_loop:
      max_iterations: 1
      fresh_context: true
      until_bash: |
        test -s .lastlight/pr-review/findings.json \
          && node /opt/lastlight/code-facts/bin/validate-findings.js
```

`fresh_context: true` gives the fresh-context adjudication AnyPoC recommends —
it reads the hypothesis records, the quotes and the transcripts, **not** the
survey's reasoning.

> **The gate is a conservation check
> ([10-design-review.md](10-design-review.md) §D11).** "Existence-plus-schema"
> was not enough: AC2 below calls "may not delete without a counter-transcript"
> *the most important test in the work package*, and nothing enforced it. An
> adjudicator reading 30 hypotheses and writing 6 findings would have passed
> every gate in this plan — which is exactly v2, which *"worked mechanically"*
> and cost recall anyway. A unit test can check the plumbing; it cannot check a
> model's compliance.
>
> **Every hypothesis id across `hypotheses/*.jsonl` must appear in
> `findings.json` with exactly one disposition:**
>
> | Disposition | Requirement |
> |---|---|
> | `inline` / `body` / `internal` | carries its `obligation` and `family` |
> | `dropped` | carries `refutedBy` naming a probe transcript **that exists on disk** |
>
> A hypothesis in neither list fails the gate. Five lines, in the spirit v3
> proved sufficient — quote *resolution* is still checked, quote *semantics*
> still are not; v2's full validator remains overkill and is what made it
> expensive. Silent omission becomes impossible by construction rather than by
> instruction.
>
> It is also load-bearing for [WP8](08-evals.md): "internal recall" and the
> auditable `internal` tier are not computable unless every hypothesis has a
> recorded disposition.
>
> Per §D12 the gate has a **floor** — if it cannot pass within its iterations,
> write `findings.json` with every unresolved hypothesis at `internal` tier and
> continue. It must never take the run down.

Its instructions, in order of importance:

1. **Deduplicate across families.** The same defect will surface from
   `contract` and `enforcement`; merge them and keep the union of evidence.
2. **Rank.** Critical with a reproducing transcript first.
3. **Tier per family threshold**, not a global bar.
4. **Demote, do not delete.** Deleting requires naming the refuting transcript.
5. **Honour the existing hard constraints** from `skills/pr-review/SKILL.md`:
   never `APPROVE` over an open human `CHANGES_REQUESTED`; never `APPROVE` while
   one of our own prior findings is still open; on a re-review, open the summary
   with the §2b ledger (Fixed / Still open / Pinned by a test / Withdrawn).

## What `post-review` needs

Minimal, and mostly nothing:

- Read `verdict` and take the worse axis in `resolveEvent`.
- Pass unknown finding fields through untouched.
- **Keep every existing guard.** `staleAgainstCurrentHead`, `repeatOfLastReview`
  (APPROVE-only, because suppressing a duplicate `CHANGES_REQUESTED` would flip
  the check run from `failure` to passing), the per-head-SHA idempotency check,
  the three-dot → two-dot → API diff fallback chain for anchoring, and the
  body-only retry. None of them are affected and all of them are load-bearing.

### The model must stop emitting line numbers

**Added 2026-08-22, from `alibaba/open-code-review` (Apache-2.0).**

`findings-schema.md` today makes `line` a **required** field the model produces:
*"Line number on `side` that the comment anchors to. Must appear in the diff."*
`post-review` then computes a commentable line set from the local diff and
**demotes anything outside it** to the body.

That guard is correct and must stay. But notice what it does to a near miss. A
finding whose analysis is perfect and whose line number is off by two is not
corrected, it is **demoted** — and the attention boundary above exists precisely
because an inline comment at the defect site is worth much more than a body
entry (*"concise hunk-level actionable findings are substantially likelier to
cause a change"*). We are paying the full cost of a wrong answer for what is
actually an arithmetic slip. Open Code Review names this failure "position
drift" and lists it second of the three it built its architecture against.

**The fix is to stop asking the model to count lines.** Models quote code well
and count lines badly. So the finding record carries a verbatim excerpt, and the
line number is *derived*:

| # | Step | Model? | Behaviour |
|---|---|---|---|
| 1 | Match `existingCode` against the file's diff hunks | no | New side first (context + added → new-file numbers), then old side (context + deleted → old-file numbers) |
| 2 | Scan the full head-side file content | no | Fallback when the excerpt sits outside a hunk |
| 3 | **Relocate across files** | **no** | Plain string match of the excerpt over every in-memory diff. **Unique hit only**: re-file `path`, `line` and `endLine` together. Zero hits and multiple hits both decline and leave it unlocated |
| 4 | Ask a model to regenerate a precise excerpt, then retry step 1 | yes | Last resort only |
| 5 | Still unlocated | — | Demote to body, exactly as today |

**Step 3 must run before step 4, and the ordering is the whole insight.** Open
Code Review's source explains why, and it is worth quoting because it is a trap
we would otherwise walk into:

> The reviewing Agent reads related files through `file_read_diff`, so it can
> describe code from a file other than the one under review and still file the
> comment against the file under review — typically a declaration/implementation
> split. `ResolveComment` then fails, and the LLM re-location that follows is
> given only the wrong file's diff and a prompt that demands a code block back,
> so it answers with whatever token in that diff looks closest. That overwrites
> the one piece of evidence pointing at the real code, and the comment ends up
> **looking located while pointing at an unrelated line.**

A declaration/implementation split is not an exotic case for us. It is the
normal shape of a finding that came out of a **contract delta** or an **impact
cone**, which is to say the normal shape of everything WP1 exists to produce.
Handing a model the wrong file's diff and demanding a snippet back is a
finding-corruption machine, and it fails *silently* — the output is a
confidently anchored comment on unrelated code, which is worse than a demotion.

**Schema change.** `existingCode` (verbatim excerpt) becomes required on the
hypothesis record in [03](03-seed-and-survey.md) and on the finding;
`line` / `start_line` become **optional and advisory**, resolved by the cascade
and overwritten when resolution succeeds. This is a `findings-schema.md` change
and a `post-review` change, and it is worth doing even if nothing else in this
work package ships.

## The external instrument, and the floor it pins

**Added 2026-08-22.** This work package had no external gate. It now has one:
`apps/evals/scripts/aacr-adjudicate.ts` scores an adjudicator arm against
AACR-Bench's 1,505 valid / 640 invalid review comments
([09](09-external-validation.md) §"AACR-Bench" for the corpus and its biases).

The floor is the null adjudicator — keep everything, which is exactly what
production does today — and it is deliberately high:

| Arm | retention (label=1) | interception (label=0) | precision | F1 |
|---|---|---|---|---|
| `keep-all` (production today) | **100.0%** (1505/1505) | 0.0% (0/640) | 70.2% | **0.825** |
| `drop-all` | 0.0% (0/1505) | 100.0% (640/640) | n/a | n/a |

**An adjudicator that does not beat F1 0.825 while holding retention is worse
than not having one.** That is the whole asymmetry of this document expressed as
a number, and it is free to reproduce (no model calls, `--arm keep-all --all`).

### Measured 2026-08-22: two models, and neither beats doing nothing

Full 2,145 rows, both arms, `llm` arm prompt (which carries a deliberate
keep-when-unsure bias, so **these retention figures are the optimistic end**).

| Arm | retention (L1) | interception (L0) | precision | F1 |
|---|---|---|---|---|
| `keep-all` | **100.0%** (1505/1505) | 0.0% (0/640) | 70.2% | **0.825** |
| `anthropic/claude-haiku-4-5` | 91.3% (1371/1502) | 15.4% (98/638) | 71.7% | 0.803 |
| `fireworks/…/glm-5p2-fast` (reasoning off) | 76.3% (1143/1499) | 33.0% (211/639) | 72.8% | 0.745 |
| `drop-all` | 0.0% | 100.0% (640/640) | n/a | n/a |

Read the confusion matrices, not the rates. Haiku destroys **131 valid comments
to catch 98** invalid ones; GLM destroys **356 to catch 211**. That is 1.34 and
1.69 real findings burned per piece of noise removed, and precision barely moves
(70.2 → 71.7 → 72.8) because both drop valid and invalid at nearly the same
rate. **That is the signature of a filter that is not discriminating, only
shrinking.** Cost was ~$2 (Haiku) and negligible (GLM). Wall clock is not
reported here: the two runs overlapped, so both `elapsed` figures are
contaminated (`01b` house rule).

**The threshold sweep is the part that closes the question.** Haiku's confidence
axis is inert across its whole useful range — F1 sits at 0.825 from t=0.0 to
t=0.7 with interception under 1%, then collapses to 0.467 at t=0.8 and 0.070 at
t=0.9. **No threshold anywhere on the curve beats `keep-all`.** There is no
operating point to tune toward, so this is not a calibration problem that
[§"Per-check calibration"](#per-check-calibration-not-a-global-gate) can rescue.
The sweep's bracketing check passed (t=0.0 reproduces `keep-all`, t=1.0
reproduces `drop-all`), so the axis is monotone and this is a property of the
model, not of the instrument.

**The authorship split runs the wrong way for us**, on both models:

| | Haiku retention | GLM retention |
|---|---|---|
| AI-authored (n≈1590) | 94.4% (1049/1111) | 82.9% (919/1108) |
| **human-authored** (n=548) | **82.4%** (322/391) | **57.3%** (224/391) |

Both judge machine-written comments markedly better than human-written ones —
GLM discards **43% of valid human review comments**. The reviewer's job is to
find what human reviewers find, so the human column is the one that counts, and
it is the worse one on both arms.

### What this changes

Nothing in the design, and that is the point — it is the fifth independent
reproduction of locked decision #1, and the first run on a labelled **negative**
set (our v2, BitsAI-CR, Open Code Review's leaderboard, now these two). But it
sharpens the prohibition from a principle into a measured bound:

> **A cheap model asked "is this comment valid" is worse than useless here.**
> `adjudicate` earns its cost through **ranking and tiering** into
> inline/body/internal, and through **probe-backed deletion**
> ([WP4](04-probe-oracle.md)). It may not earn it by judging plausibility.

Two follow-ups this leaves open, neither blocking:

- **An unbiased-prompt arm** to bound the other side. The measured numbers are
  the optimistic end; a neutral prompt is very likely worse, and it should be a
  second arm rather than an edit so both numbers exist.
- **A strong model** has not been tried. `08-evals.md`'s Reflexion note says the
  FN hunt degrades badly on small models (SNR 2.89 → 0.91); the same may be true
  of adjudication, in which case the finding is about model class, not the task.
  Until that is run, "cheap adjudication does not work" is the honest claim, not
  "adjudication does not work".

Read it with two limits in mind. It measures judging a comment **when handed the
comment**, which is not review recall. And it **cannot supply SNR** — with no
generation step, SNR degenerates into precision — so AC6 below must still be
read on our own eval.

## Acceptance criteria

1. A finding below its family threshold **appears in the review body**, not
   nowhere. Unit-test the demotion path directly.
1a. **Added 2026-08-22.** A finding whose `line` is wrong but whose
   `existingCode` matches a hunk verbatim **anchors inline anyway**. Test the
   cross-file case explicitly: an excerpt filed against the header that lives in
   the source file re-files to the source file, and an excerpt appearing in two
   files declines rather than guessing.
1b. With 20 surviving findings and `maxInlineComments: 8`, exactly 8 are inline
   and **12 are in the body** — none are lost. Every `internal`-tier finding is
   written to `review_findings` with its reason.
2. An `unprobed` hypothesis ([WP4](04-probe-oracle.md)) reaches the review; only
   a transcript-refuted one is dropped. **This is the v2 regression and the most
   important test in the work package.**

   > **Note 2026-08-22: probe-backed deletion is the only sanctioned deletion,
   > and `falsify` has never run.** WP4 shipped it inert and no model has been
   > against it, so nothing has yet produced a transcript. If it turns out to
   > produce few or none on real cases, this adjudicator's delete power is
   > **inert by construction** — which is the safe direction, and it means WP6
   > lands as *connect the exit, rank and tier*. Expect that rather than
   > discovering it, and do not compensate by allowing deletion on any other
   > ground: the measured AACR result below is what happens when you do.
3. `verdict: { spec: "fail", standards: "pass" }` yields a non-`APPROVE` event.
4. Absent `verdict`, behaviour is identical to today.
5. Duplicate findings from two families collapse to one comment with merged
   evidence.
6. **Measurement gate:** recall does not fall relative to the WP4 arm, and
   **SNR** ([08-evals.md](08-evals.md)) is reported. Precision alone is not a
   gate — read [00-evidence §5](00-evidence.md) before arguing otherwise.

## Non-goals

- **No confidence model beyond a per-family threshold.** A learned ranker is
  attractive and needs [WP7](07-review-memory.md)'s outcome data first.
- **No suppression of whole reviews.** Issue #272's pre-flight screener stays
  parked — it is a suppressor on the same lever as the defect we are fixing, and
  its own issue argues against itself. Revisit only after recall moves.
- **No change to the review-trigger policy.** `resolveReviewTrigger` is the one
  implementation of `review.trigger` on every route and is out of scope.
