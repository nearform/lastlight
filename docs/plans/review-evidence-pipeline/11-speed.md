# WP11 — speed, and the four defects it uncovered

**Goal.** Make the pipeline cheap enough in wall clock that arms can actually be
run, so the quality questions become affordable.

**Status: BUILT 2026-08-22, uncommitted.** Gate green (24/24 turbo tasks).

**Depends on:** WP3, WP4, WP6. **Nothing in this plan depends on it** — it is
latency and instrumentation, not recall.

## Why it existed

WP6 had been run by a model exactly **twice, on one case**, and an 8-case arm was
killed after one case. The reason was not cost and not correctness:

| | baseline (pipeline OFF) | pipeline ON |
|---|---:|---:|
| per PR | 2m30, $0.38 | **29m13, $2.49** |
| 8-case arm | ~18 min | **~4 hours** |

97% of that was model time. And the eval harness ran an arm's eight cases
**serially** — provider families run concurrently and every arm is Anthropic — so
this plan's own discipline ("re-run the same case 2–3× to separate variance from
signal", "one ablation rung at a time") cost most of a day per question.

**The measurement loop was the thing that was broken.**

## What shipped

### The instrument (do this kind of thing first — it was free)

`PhaseMetric.durationMs` was **declared and never populated**; every scorecard on
disk read `"survey_contract:undefined"`. So the 29-minute breakdown had been read
by hand out of session transcripts.

Now populated, plus two things the plan never had:

- **`durationMs`** — the measured phase window (`onPhaseEnd` − `onPhaseStart`),
  so it includes provisioning, skill staging and the `until_bash` gate. **Absent
  means the phase never started**, not that it was instant.
- **`agentMs`** — summed `duration_ms` over that phase's result envelopes.
  Narrower, but derivable from artifacts a run already wrote, which is what let
  `scripts/rescore.ts` back-fill a per-phase split onto the two existing WP6 runs
  **with no re-run and no spend**. It reproduced the hand-read numbers to within
  rounding (850.3s of surveys against the 851 read by hand), which is what
  validated the instrument.
- **Per-phase `costUsd`** — new information. It showed `adjudicate` at **38% of
  case cost** in two calls, against the six surveys' 51% across six.

**Attribution is by a `phase` stamp on the session envelope, not by the clock.**
The original rule — *the last phase whose window opened at or before this
session's first line* — is a point lookup and **cannot express concurrency in
principle**; six branches opening within 35ms all resolve to whichever opened
last. Unstamped (pre-2026-08-22) sessions fall back to the window rule, so every
archived run reproduces its published numbers exactly.

### `type: fanout`

The six surveys are 49% of the wall clock, pairwise disjoint
(`hypotheses/<family>.jsonl`, append-only), and were chained only because
`scheduler.ts` runs `ready[0]` one node at a time.

**WP5 was not unparked.** This took the carve-out
[05-parallel-phases.md](05-parallel-phases.md) had already recorded: *"every hard
blocker exists because each phase provisions its own sandbox against a shared
workspace. A fan-out inside one agent has none of them."*

One DAG node, one `withSandbox`, N concurrent agent sessions, one dispose. B1–B4,
D1–D3, D5 and D7 are **inapplicable by construction** — there is only ever one
node, one provision, one `current_phase`, one harvest.

- Registered through the existing `PhaseTypeHandler` seam (`ports.handlers`), the
  same one `post-review` uses. `scheduler.ts` is untouched.
- Per-branch `executions` rows under `<phase>_branch_<name>`, so resume, dedup,
  per-branch cost attribution and the dashboard's longest-prefix grouping all
  come free — the cost WP5 warned an in-agent fan-out would pay.
- **`until_bash` branch gates run after the join, sequentially.** This is
  load-bearing: `InProcessSandbox.runCommand` is `spawnSync` and blocks the event
  loop, so an interleaved gate would serialise the entire fan-out on the `none`
  backend — which is the backend the evals use.
- **Backend ceiling**: `none`/`docker` 6, `gondolin`/`smol`/`kubernetes` **1**,
  clamped with a logged reason. Gondolin would be a QEMU micro-VM per branch,
  which is D7's hazard on a host with no swap. This costs nothing today: the
  pipeline cannot run in production at all until WP2.

### `--concurrency N` on the eval harness

Default 1, and a **no-op by construction** — `N === 1` falls through to the
original serial loop untouched. Intra-family serialism was a rate-limit choice,
not a correctness constraint; per-case isolation (fresh `mkdtemp` stateDir,
private fake-GitHub port, no `process.chdir`, env hoisted once) was already
complete and documented.

Two limits enforced in code: **arms never overlap** (the workflow asset root is a
process global — `apps/evals/docs/adr/0001-asset-root-is-process-global.md`), and
**gondolin clamps to 1**.

### `lastlight-facts findings --ledger`

`adjudicate` attempt 1 was failing the conservation gate and costing 426s + a
274s retry — 40% of the case.

The premise in the brief was wrong and the agent said so: **`seed` does not mint
hypothesis ids.** It mints *obligations* (`O-001`); the `H-` ids come from the
survey models at runtime, so there is nothing to render at template time. Hence a
deterministic command the prompt *invokes*, reading through the same `inspect` as
the gate so the two can never disagree about which ids exist.

Three deliberate properties: it **always exits 0** (its caller is the agent's own
bash tool, where the gate's non-zero "iterate again" would read as a tool
failure); **nothing is capped** (a checklist that elided entries would reproduce
the omission it exists to prevent); and an **unreadable `findings.json` means
every id outstanding, not zero**.

## What it measured

`prreview__skillspro-1587-r1`, Haiku, one run per configuration.

| | before | run C | run D | run E |
|---|---|---|---|---|
| total | **29m13 / $2.49** | 11m59 / $2.01 | 11m43 / $2.05 | 11m36 / $2.34 |
| six surveys | 851s chained | 242s span | 211s | 234s |
| `review` | 152s | 189s | 144s | 137s |
| `adjudicate` | 426s **+ 274s** | 272s | 328s | 311s |
| `adjudicate_iter_2` | present | **none** | **none** | **none** |

**~2.4× faster and cheaper**, from two mechanisms:

1. The fanout collapsed the survey block from a **sum** to its **slowest branch**.
2. The `--ledger` checklist got `adjudicate` through conservation first time.

Claim 2 is the one worth being careful about. Run C's "no retry" could **not** be
read as the ledger working — the id collision (below) meant the id space had
collapsed from 8 to 5, so there was simply less to check. Runs D and E passed
first-attempt against the honest **30-id** gate, at 328s and 311s against 272s.
That is the +21% load showing up and being absorbed. **The claim is now
supported; it was not before.**

**No recall claim.** One case, one run per configuration, gold 1 of 3 throughout.
Detection floor ≈0.24–0.28 micro-recall; a single gold moving is McNemar p = 0.50.

## The four defects it uncovered

The speed work was the smaller half of the day. Each of these was silent, and
each invalidates something previously believed.

**1. The `pr-review` skill was corrupting its own diff range.** `SKILL.md`
instructed `git fetch origin <base> --depth 50`. A depth fetch writes
`.git/shallow` **even into a complete clone**, severing the merge base
`ensureBaseAvailable` had just built — in **6 of 7 agent phases per review**.
Reproduced across four git states. Corpus: 9 of 50 real PRs fork further back
than 50 commits. **Production-affecting, and unrelated to speed.**

The 8-case gate **cannot regression-test this**: `add-case` pins `base_commit` to
the merge base, so two-dot ≡ three-dot in every fixture. Task #8.

**2. The conservation gate was passing falsely.** `contract.jsonl` and
`security.jsonl` both emitted `H-001..`, so `findings.json` covering five strings
"accounted for" eight hypotheses — **0 uncovered, exit 0**, while three security
hypotheses were never adjudicated. Fixed by `<family>-NNN` ids assigned
**deterministically at ingest** from filename + position, with model-minted ids
kept as unambiguous aliases and a new `ambiguous` gap kind naming both claimants.
Replaying the same artifacts: **5/5 accounted, exit 0 → 2/30, exit 3.**

**3. Schema compliance was 27%.** Only 8 of 30 hypotheses carried an `id` at all;
22 were structurally invisible to the gate. `probes` had the same hole from the
other side — it gated on `typeof row.id === "string"`, silently excusing every
free-form row from ever needing a probe, Criticals included. Both closed by the
same ingest-side identity.

*Instructing a model to emit an identifier is not a mechanism.* It complied 27%
of the time. The seed prompt's own phrase — **"impossible by construction rather
than by instruction"** — is the rule that was being violated.

**4. The spec axis had never run, anywhere.** `buildSpecObligations` refuses a
one-ended seed (locked decision 3: a half-mechanism scores −3, actively worse
than no seed), and the changed-file list was `null` because the eval built its
own `PrState` instead of calling core's `resolveSpecContext`. Worse than inert:
it emitted **7 hypotheses in the contract family's shape**, counted as coverage
while duplicating another axis.

Fixed by routing through core's own resolver against the fake (the fake grew the
GraphQL `closingIssuesReferences` route rather than the harness growing a second
resolver), with real linked-issue bodies in the fixtures — **generator-derived**,
because hand-written fixture data was silently dropped by a regeneration once
already. `maxSpecObligations` went **6 → 40**: it had been inert while the axis
produced nothing and became the binding constraint on five of six linked cases
the moment it worked, discarding the acceptance-criteria checklist a human wrote.

Run E, the first with a live spec axis: **12 discharges — 6 QUOTE, 1 PARTIAL,
1 ABSENT, 3 N/A** — against `S-N` obligation ids, in the discharge shape rather
than the contract fallback.

## What was approved and not built

The four quality levers — f1 stage the diff, f2 thinking effort, f3 a stronger
adjudicator, f4 reshape `review`. All approved, none built; the day went into
speed and into the four defects above. See [RESTART.md](RESTART.md) §3b.

## Lessons worth keeping

- **Read the free instrument before buying a model one.** The per-phase back-fill
  cost nothing and reproduced a hand-read measurement, which is what made every
  later number readable.
- **Disjoint files are not a disjoint contract.** The one real defect introduced
  that day came from two agents whose files never overlapped: one wired a new
  `onPhaseEnd`, the other added a phase handler that did not fire it. Six branch
  rows with no duration; 61% of case cost unattributed; the biggest win rendering
  as if it had never happened. It broke silently because the shared test reporter
  **takes no arguments and records nothing**, so no existing test could have
  caught a missing window.
- **A confident wrong label is worse than a weak true one.** Twice in one day: a
  lane labelled `process that DIES.` from a heading heuristic that matched a
  shell comment, and a "skipped" label that would have been applied to a phase
  that ran (because back-filled runs have no `durationMs`). Both were caught and
  replaced with the weaker, true claim.
- **Two agents self-corrected measurement bugs that would have become
  conclusions** — a probe using synthetic changed-file paths, and
  `Math.floor(undefined) → NaN → slice(0, NaN)` dropping every obligation. Both
  would have reported the spec axis still broken when it was not.
