# WP6 — adjudication, the evidence packet, and the split verdict

**Goal.** Turn the hypothesis union plus its probe transcripts into
`findings.json` — ranked, tiered, with a split verdict and a per-finding evidence
packet — without reintroducing the suppressor that killed candidate v2.

**Depends on:** [WP3](03-seed-and-survey.md), [WP4](04-probe-oracle.md).

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

## Acceptance criteria

1. A finding below its family threshold **appears in the review body**, not
   nowhere. Unit-test the demotion path directly.
1b. With 20 surviving findings and `maxInlineComments: 8`, exactly 8 are inline
   and **12 are in the body** — none are lost. Every `internal`-tier finding is
   written to `review_findings` with its reason.
2. An `unprobed` hypothesis ([WP4](04-probe-oracle.md)) reaches the review; only
   a transcript-refuted one is dropped. **This is the v2 regression and the most
   important test in the work package.**
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
