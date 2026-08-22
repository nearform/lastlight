# Evidence

Everything in this plan is downstream of measurements that have already been
paid for. This page is the record. **Do not re-litigate the falsified theories
in §6** — each cost a real arm or a real iteration.

Primary source: `~/work/nearform-evals/PR-REVIEW-INVESTIGATION.md` and the four
external sweeps in `~/work/nearform-evals/research/` (2026-08-20). The dataset
is described in `~/work/nearform-evals/evals/datasets/pr-review/README.md`.

## 1. The dataset and the baseline

Four `nearform/skillspro` PRs where Last Light signed off and the human reviewer
read **the same head SHA** and posted concrete, reproduced defects. Because the
human's review is anchored to a specific commit, each pair is an unambiguous
eval case with no argument about what was reviewable. Expanded to **8 cases / 25
gold findings**.

The split is locked, and rounds of the same PR stay on the same side (a later
round's seeded discussion legitimately contains the earlier round's findings, so
splitting them would leak blind gold into train context):

```
train    1587-r1  1587-r2  1587-r3  1641  1641-r2
heldout  1680-r1  1680-r2  1667
```

**Never diagnose on the held-out ids.**

Baseline (`2026-08-20_074355`, `claude-sonnet-4-6`, prod-faithful overlay, $5.65)
— **history, not a comparator.** It is retired as of 2026-08-22 (see
[HANDOFF.md](HANDOFF.md) → "Comparators"); the numbers below stand as the record
of what the shipped reviewer did, which is what this file is for:

| | P | R | F1 |
|---|---|---|---|
| Arm | 0.250 | 0.167 | **0.188** |
| TRAIN (5) | | | 0.300 |
| BLIND (3) | | | **0.000** |

**1 of 25 gold findings matched. Micro-recall 0.040. Five of seven recall cases
posted nothing at all.**

Two cautions that apply to every future read:

- `1641` has **empty gold** — posting nothing scores 1.00 and flatters every
  average. It is the **precision canary**, not a recall case. Micro-recall over
  the 25 gold findings is the honest headline.
- A single run is noisy. The baseline was decisive at one run only because the
  result was saturated at zero.

Production over the same period, independently: 94 `pr-review` runs / 43 PRs,
**2.2 reviews per PR, 71% APPROVE, 58 of 59 approvals carried zero inline
findings** (issue #271).

## 2. Candidate v2 — verification was fixed, and recall did not move

v2 was, almost exactly, the architecture the standard advice recommends:
generate → machine-checked evidence gate → fresh-context adjudicator → ruthless
judge.

**It worked mechanically.** Every disposition became quote-backed and the quotes
were machine-verified against the repo. The reviewer provably opened files and
quoted them. Surfacing quadrupled, 2 → 8 posted findings.

**And micro-recall went 1/25 → 2/25.** Arm F1 *fell* to 0.092. The empty-gold
canary regressed 1.00 → 0.00. Cost went 2.4× ($13.40). **Reverted; the machinery
was deleted.**

The struck-through line in the investigation is the conclusion:

> ~~"the failure is at the verification step, not the discovery step"~~ —
> **falsified. Discovery is the ceiling.**

Independently confirmed by BitsAI-CR ([arXiv:2501.15134](https://arxiv.org/abs/2501.15134)):
its ReviewFilter raised precision 54.5 → 67.1 and **cut recall 45.5 → 39.8**.

The generalisation, which locked decision 1 encodes: **post-hoc verification of
a conservative reviewer costs recall.** Verification only *raises* recall where
the oracle is cheap enough that generation is deliberately re-tuned to
over-produce against it. The two existence proofs — PropertyGPT (a prover, 12
zero-days) and Meta ACH (mutants, 73% engineer acceptance) — are **both
hypothesis-seeding machines first, verifiers second**. v2 built the wrong half
of the pattern.

## 3. Candidate v3 — mechanical seeding, and the first gold match

v3 put a deterministic `type: script` enumerator in front of the agent: parse
the diff, enumerate specific obligations, stage dependency sources on disk,
require a written ledger.

On train case `1587-r2` — 0.00 in every previous arm — it posted the **Critical**
gold finding (`auth.ts:73`: `issuedAt` parsed but never compared server-side;
expiry enforced only by a browser cookie `maxAge`) for **F1 0.286**, and the
empty-gold canary held at **1.00**.

The iteration record is the useful part:

| Iter | Change | Result |
|---|---|---|
| 1 | 22-item checklist in the prompt | **Acknowledged in one sentence and skipped.** Opened all four gold files, asked nothing. *Reading is not the constraint; asking is.* Also surfaced the affordance gap — no `node_modules` on disk |
| 2 | Mandatory written ledger + staged package sources | Ledger written and **honestly discharged** — 17 rows, real quotes from staged sources, the enumerator's two noise items correctly dismissed — and **still 0 findings**. The seeds were *near* the gold, not *at* it |
| 3 | Obligations O6/O7 + "values, not just types" phrasing | **F1 0.286 — the first gold match, and it is the Critical.** Converted directly from the O6 seed (ledger row 20 → FINDING → posted) |

**The four transferable lessons:**

1. **Seeding works only at question granularity.** *"Check this area"* → an
   honest CLEAN. *"Quote the line that enforces THIS constant"* → the Critical,
   posted. An obligation one abstraction level too high gets discharged **at
   that level**, and the defect lives below it.
2. **Affordances beat instructions.** Staging the dependency source (`npm pack`
   at the locked version) turned "open the library" from *impossible* into a
   one-`read` action, and the model then genuinely quoted implementation lines.
3. **The written artifact is the compliance floor, and it must be
   machine-checked.** Two runs claimed "N obligations discharged" in prose
   **without writing the ledger file**. A five-line existence gate suffices —
   v2's full quote validator is overkill.
4. **Precision survives.** The canary held at 1.00 with recall-first calibration
   in place. The one false positive so far was a mild test-mock type nit.

Cost: ~$2.4/case, ≈3× baseline — the discharge costs turns. Trimming (item caps,
shorter templates) is untried.

**Status: unvalidated at arm scale, and we are not going to validate it.**
Everything above is single-train-case (n=1 per change, changes 2–4 shipped
stacked; only O6→Critical is cleanly attributed). The full 8-case arm and the
blind read were never run.

**That is deliberate.** v3 is a regex prototype of the mechanism
[WP1](01-code-facts.md) and [WP3](03-seed-and-survey.md) build properly, and its
enumerator is being deleted. Spending ~$15–19 to characterise it would describe a
machine we are not shipping. v3's role here is **evidence for a design choice**;
the hypothesis it supports — mechanical seeding at question granularity — is
validated at arm scale by WP3's own gate, against the **shipped baseline** in §1.

## 4. `1641-r2` — the negative result that names the missing capability

The pivotal case. Every mechanical fix worked:

- the enumerator surfaced the ESLint plugin (after the O2 denylist's `^eslint`
  prefix was narrowed — it had been swallowing `eslint-plugin-require-extensions`,
  the exact package the gold lives in);
- the `createRequire(...)("pkg")` load pattern was added to the import scan;
- the ledger was written — 14 rows, all discharged;
- the model **opened the plugin source and the shim**.

And its summary says *"All plugin usages are verified at source… the Proxy
restores the removed `context.getFilename()` API"*. **It stood at the defect site
and judged the buggy shim correct.**

The human closed the same question this way:

> *"Verified on this branch: with that change the probe file reports correctly"*

They **ran ESLint with a probe file**. Executing the linter on the branch would
have thrown the `TypeError` deterministically.

This is the whole argument for [04-probe-oracle.md](04-probe-oracle.md): for
*behaviour-of-code* questions there is a fourth lever beyond seeds, affordances
and artifacts — a **dynamic oracle** that turns a semantics judgement the model
cannot make into an observation it can.

Independent support: AnyPoC ([arXiv:2604.11950](https://arxiv.org/abs/2604.11950))
triaged **~2700 candidate reports → 121 new bugs, 108 developer-confirmed, 92
fixed** across Chromium/OpenSSL/SQLite/Redis, by making validation mechanical —
an Analyzer summarises the mechanism, a Generator builds a PoC, and a **Checker
re-executes it in a fresh environment with no access to the generator's context,
instructed to trust its own execution over the generator's claims**. Baseline
agents fail to reject 96% of false reports; AnyPoC rejects 85–96%.

## 5. Calibration — we are behind the field, and the field's ceiling is ~1/3

| Benchmark | Best result |
|---|---|
| CR-Bench ([arXiv:2603.11078](https://arxiv.org/html/2603.11078v1)) | GPT-5.2 single-shot: **27.0% recall / 3.6% precision** |
| c-CRAB ([arXiv:2603.23448](https://arxiv.org/abs/2603.23448)) | Claude Code 32.1%; Devin Review 24.8%; PR-Agent 23.1% |
| Martian Code Review Bench (offline, 2026-06-24) | Cubic F1 61.8%; Qodo Extended 57.9%; CodeRabbit 35.2% |
| **Us** | **micro-recall 0.040** |

Two things follow.

**Frontier precision is 3–5%.** Every serious reviewer over-generates massively
and eats the noise. Our baseline posted 2 findings across 8 PRs. The instinct to
protect precision is the opposite of what the field does — hence locked decision
2, and hence **SNR replaces precision as the guardrail** (see
[08-evals.md](08-evals.md)).

**Nobody is near solved.** Even the best dedicated products miss a third or more
of known defects, and Martian's own set has only 50 underlying bugs — treat the
exact rankings cautiously and the direction as solid.

### The three external findings that most change the design

1. **Half a mechanism is worse than none — measured.** IRIS
   ([arXiv:2405.17238](https://arxiv.org/abs/2405.17238)) ablation: CodeQL
   sources + LLM sinks = 36/120 (+9 over CodeQL's 27); **LLM sources + CodeQL
   sinks = 24 (−3, actively harmful)**; both ends = 55 (+28, ~2× recall). This
   is v3's lesson 1 at the level of a controlled ablation, and it is why
   **every obligation must name both ends** (locked decision 3).
2. **An executable oracle is what makes over-generation affordable.** AnyPoC,
   above.
3. **Post-hoc verification of a conservative reviewer costs recall.** BitsAI-CR,
   §2 above.

### Deterministic tooling — the honest answer

**No OSS tool answers "the diff changed a constant — where is it enforced?" out
of the box.**

- **CodeQL** can express it as a custom data-flow query, but its CLI licence
  forbids non-open-source codebases without paid GHAS — legal in the eval
  harness over public gold PRs, **illegal in the product against a private
  customer repo**. Locked decision 7.
- **Semgrep CE** is single-file/single-function (cross-file is Pro), and its
  registry rules moved to a licence that plausibly excludes a review product →
  **Opengrep** is the safer engine slot.
- **Infer** has no JS/TS. **Joern**'s JS frontend has documented dataflow holes.

What survives is unglamorous and mostly ours to build — see
[01-code-facts.md](01-code-facts.md). Expect the deterministic layer to
*directly* catch **2–4 of 25**; its real job is fact-generation to seed the LLM.

**The landmine:** TypeScript 7 has no programmatic compiler API (`tsgo` is
CLI+LSP only; the matrix says "API: not ready"). Locked decision 5.

**The design rule, learned here:** every tool must **fail loud, not exit 0** —
dependency-cruiser silently exited 0 on TS≥7 and the gate went green while
seeing nothing. Locked decision 6.

## 6. Falsified — do not re-litigate

| Theory | How it died |
|---|---|
| *"It anchors on the prior discussion and treats auditing the old list as the review."* | Killed by `1667`: zero prior reviews, 54 turns, still 0 of 5. A cold review fails the same way |
| *"A two-phase split (cold review, then reconcile) makes anchoring structurally impossible."* | Two problems. There is **no per-phase tool allow/deny** in `PhaseDefinitionSchema`, so phase 1 cannot be denied the GitHub read tools. And phase 1 *is* the `1667` condition, which already fails |
| *"The existing 1641 case is pinned to the wrong SHA."* | No. `54912872` and `d8be71d6` are an amend pair (same parent, same author date) and that is what the bot approved twice |
| *"Bigger model."* | Haiku 4.5 beats Sonnet 4.6 on review recall on two independent evals (41.2% vs 22.1% on Martian). Martian shows a ~28-point **scaffolding** gap at fixed model class. The Opus probe is dead |
| *"More context."* | Targeted slices beat bulk context. SWE-PRBench found that progressively larger repository context made review performance *worse* across all eight models tested |
| *"The failure is verification, not discovery."* | §2 |

### One correction the investigation makes to its own record

**"LLM-mediated merge destroys recall (0.293→0.226)" is contradicted.**
SWR-Bench v2's Self-Agg is exactly LLM-mediated merging and raised recall
**13.9% → 30.4% at n=10**, monotonically over n∈{1,3,5,10}
([arXiv:2509.01494v2](https://arxiv.org/html/2509.01494v2)); c-CRAB separately
shows a **union of four tools = 41.5% vs 32.1% best single** (+9.4pts from
complementarity alone). Our number is most likely an artifact of a
consensus-collapsing merge prompt.

This is why [03-seed-and-survey.md](03-seed-and-survey.md) mandates a
**union-preserving, append-only** merge rather than banning aggregation.

## 7. Unimplemented from issue #271, and still unclaimed

#271 is the founding document (its prompt fixes are *already shipped* and are
therefore inside the 1-of-25 baseline). Two of its eight numbered fixes were
never implemented, and both are **orthogonal** to everything the investigation
tried — all of which targeted the Standards axis:

- **Fix 6 — add a Spec axis.** All nine "what to check" items in
  `skills/code-review/SKILL.md` are standards-flavoured. **Nothing asks whether
  the change does what the issue asked.**
- **Fix 7 — split the verdict**, so a spec failure cannot be masked by clean
  standards. *"A blended verdict lets the passing axis hide the failing one."*

Both are picked up in [03-seed-and-survey.md](03-seed-and-survey.md) and
[06-adjudicate.md](06-adjudicate.md).

## 8. Open ground

The sweep found **no published study** of per-PR mechanically-generated
checklists raising recall, and none of mining a repo's own review history into
defect mechanisms. [07-review-memory.md](07-review-memory.md) is therefore
defensible original ground — and it is the one part of this plan a competitor
cannot copy from a public benchmark, because the data is the customer's own
private history.
