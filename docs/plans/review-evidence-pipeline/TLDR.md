# TL;DR — what `code-facts` is, and why it should improve review quality

> The short version, for someone who has not read the rest of this folder. The
> *why* in full is [README.md](README.md); the evidence behind every number
> here is [00-evidence.md](00-evidence.md) and
> [01b-code-facts-hardening.md](01b-code-facts-hardening.md); the operational
> entry point is [RESTART.md](RESTART.md).

## The problem it exists to solve

The reviewer today gets **a diff and a grep**. That is the whole apparatus: one
agent turn, `git diff`, `read`, `grep`.

Measured against eight real PRs where a named human reviewed the exact head SHA
Last Light had just approved:

- **1 of 25** gold findings caught — micro-recall **0.040**. The blind split
  scored **0.000**.
- In production over the same period: 94 `pr-review` runs across 43 PRs,
  **71% APPROVE**, and **58 of 59 approvals carried zero inline findings**.

And it is not failing from lack of effort. It runs 54–68 turns, writes a genuine
cross-file trace, then concludes "no findings" and discards the trace.

## The diagnosis — three obvious theories, each falsified by measurement

This is the load-bearing part, and the reason the architecture looks the way it
does rather than like a better prompt.

| Theory | What was tried | Result |
|---|---|---|
| It hallucinates; it needs verification | v2 — machine-checked evidence gate + fresh-context adjudicator | Posted findings 2 → 8, but recall only 1/25 → 2/25. F1 **halved** (0.188 → 0.092), precision canary 1.00 → 0.00, cost 2.4×. **Reverted, machinery deleted.** |
| It is a prompt-quality problem | Three rounds of instruction work | A 22-item checklist was acknowledged in one sentence and skipped; a 17-row ledger was honestly discharged and still produced 0 findings |
| It needs a bigger model | — | Haiku 4.5 *beats* Sonnet 4.6 on review recall (41.2% vs 22.1% on Martian) |

The conclusion, and the single sentence this plan turns on:

> **Discovery is the ceiling, not verification.** The model's question set does
> not contain the human's questions.

You cannot prompt your way to a question about a file you never knew was
connected to the diff.

## What `code-facts` actually computes

Deterministically, with no model spend, from the checkout we already have. It
answers the things an LLM should never be guessing at:

- **Impact cone** — which symbols changed, and every place that calls them.
  `referencesInDiff` against `referenceCount` is the single most productive
  field: it separates "changed and used only here" from "changed and used by
  forty callers you did not open".
- **Contract delta** — which public signatures changed, and who *outside the
  diff* consumes them.
- **Constants: references minus literals** — where a value is referenced
  properly against where somebody hard-coded it. **The subtraction is the
  insight**, and this is the only fact shape that has ever converted a gold
  finding.
- **Dependency delta** — what changed, plus the real library source staged on
  disk so it can be opened.
- **Scanner patterns** (opengrep, gitleaks) and **changed-line coverage**.

That "staged on disk" clause carries more weight than it looks. One documented
failure had the reviewer reference `WebClient` 32 times and **never open
`node_modules/@slack`** — because the seeded workspace had no `node_modules`.
"Open the library source" was not ignored; it was *structurally impossible*.
An affordance gap reads to a model as an instruction it cannot follow.

## Why the facts alone are not the answer

Facts are the substrate, not the verdict. The rule bought most expensively:

> **The deterministic layer generates hypotheses. It does not filter them.**

The reverse — static analysis feeding a ruthless judge — is exactly what v2
built and reverted. BitsAI-CR reproduced the same shape independently: precision
54.5 → 67.1, recall 45.5 → **39.8**. Post-hoc verification of an already
conservative reviewer costs recall.

So the pipeline runs the other way round:

```
facts   →   seed   →   survey   →   falsify   →   adjudicate   →   post
(free)      both       cheap        RUN a         strong model
            ends of    model,       probe         may DEMOTE,
            the        deliberately (the          may not DELETE
            mechanism  over-        oracle)       without a
                       produces                   counter-transcript
```

Two rules in there are counter-intuitive, and both were bought with evidence
rather than taste:

- **Every seed names both ends of the defect mechanism** — where a value is
  introduced *and* where it should be enforced. IRIS's ablation: both ends is
  roughly **2× recall**; a *half* mechanism scored **−3, actively worse than no
  seed at all**. A one-ended seed is not a weak seed, it is a harmful one.
- **Precision is not the guardrail.** Frontier precision on this task is 3–5%
  (CR-Bench GPT-5.2: 27.0% recall at 3.6% precision). We deliberately
  over-generate and let an executable oracle kill the wrong ones. The guardrail
  is signal-to-noise, not precision.

## Does the evidence say it will work?

There is a measurable upper bound on what seeding can contribute, and it is
already computed. *Evidence coverage* asks a narrow question: do the facts even
**name the entity** the human's finding was about?

- **TS/JS: 46.2%** — the facts name the right thing in nearly half of real
  findings.
- Non-TS: **2.7%** — which is why the plan is TypeScript-first, and why grammars
  moved right of "ship-capable".

So the deterministic layer is already pointing at the right code roughly half
the time, and converting essentially none of it. The one occasion a mechanical
seed was wired up by hand produced the first gold match ever recorded — a
Critical at `auth.ts:73`, a JWT `issuedAt` parsed but never compared
server-side.

Naming is necessary, not sufficient. 46.2% is a ceiling, not a forecast.

## The honest gaps

1. **Nothing consumes the facts yet.** `lastlight facts` runs and is measured,
   but there are **zero call sites in `apps/server`**. Wiring it into a phase is
   [WP3](03-seed-and-survey.md), and it is the plan's first model spend.
2. **Some defects cannot be read, only run.** One case had the model standing at
   the defect site with the dependency source open, judging a buggy Proxy shim
   correct. The human settled the same question by *running ESLint with a probe
   file*. That is [WP4](04-probe-oracle.md), and it is what makes deliberate
   over-generation affordable.
3. **Improvements below ~0.24 micro-recall are not distinguishable from chance**
   on a 25-finding gold set. That is why WP3's and WP4's gates are expressed as
   mechanism metrics, not as recall. See [08-evals.md](08-evals.md).
4. **The engine is heavier than it needs to be.** `ts-morph` vendors the
   JavaScript TypeScript compiler; peak RSS runs 1.0–4.4 GB against a 2 GB agent
   cap, and an OOM exits 134 with no envelope. That is a production-path safety
   problem rather than a quality one — a failing phase is re-dispatched every 30
   minutes forever. Being addressed separately.

## In one sentence

The reviewer fails because it never asks the right questions. `code-facts`
computes — deterministically and cheaply — what the change actually touches, so
the questions are *handed* to the model instead of guessed at; the rest of the
pipeline makes over-asking affordable by running probes to kill the wrong
answers.
