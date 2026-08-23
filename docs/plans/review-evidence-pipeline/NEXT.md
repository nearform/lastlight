# NEXT — start a clean session here

Written 2026-08-22 at the end of the re-baseline day. This is the short,
self-contained entry point: what we know, what the artifacts say, and the small
experiments that are worth running before anything ambitious. Updated 2026-08-23
with E1's answer, the union/intersection numbers, and finding 9.

[RESTART.md](RESTART.md) remains the operational reference — tree state, the
commands, and §4's traps (all ten of which have already cost money). Read §2b
there for the measured numbers. This file is what to *do*.

## The state in five lines

- The pipeline works end to end and is **off by default**; `false` reproduces the
  shipped review byte-for-byte.
- It finds gold the shipped reviewer never finds — against the baseline's 0 of 25
  — and has never lost a baseline hit.
- **How much it finds on any given run is wildly unstable**: 0.320, 0.080 and
  0.200 from an identical configuration. The mean is 0.200, the **union across
  the three runs is 0.440 (11 of 25)** and the **intersection is 0.040 (1 of
  25)**. One gold in twenty-five is found reliably; ten more are found by
  *some* run and no run finds the same ten.
- **The seed layer is deterministic** — obligations are byte-identical across
  runs. All the variance is downstream of it, in the surveys. Not all of it is
  the *models*, though: about one survey branch in six never receives its
  obligations at all (finding 9), and which branch loses them is random.
- Everything is committed. Both repos clean.
- Nothing here has been validated outside eight `skillspro` cases. Any external
  claim is still [WP9](09-external-validation.md)'s, unmade.

## The four runs — KEEP THESE IDS

All in `~/work/nearform-evals/eval-results/pr-review/`.

| Run id | Arm | Result |
|---|---|---|
| `2026-08-22_183835-00cc469` | **baseline** | 0 of 25, 1 posted, $2.28 |
| `2026-08-22_184650-00cc469` | **wp3 run 1** | 8 of 25 (μrec 0.320), 47 posted, $15.65 |
| `2026-08-22_194234-00cc469` | **wp3 run 2** | 2 of 25 (μrec 0.080), 23 posted, $17.55 |
| `2026-08-22_201607-64862d5` | **wp3 run 3** | 5 of 25 (μrec 0.200), 44 posted |

A fifth set matters as much and is not in that table — the **2026-08-23
`--repeats 3` band** on `prreview__skillspro-1587-r2`, which is the hard
comparator for X1: `2026-08-23_053348-64862d5` (group), `054143`, `055425`.
Single case, 5 gold, **0 matched in all three**, and the first run in this
plan's history to carry real provenance (`meta.repeat`, `meta.overlay`,
`meta.argv`).

`TMPDIR` is purged periodically, so the kept workspaces are **copied out** to:

```
~/lastlight-run-artifacts/2026-08-22_184650-wp3-run1/             (run 1 — note: no sha in this one)
~/lastlight-run-artifacts/2026-08-22_201607-64862d5-wp3-run3/     (run 3)
~/lastlight-run-artifacts/2026-08-23_053348-64862d5-wp3-rep1/     (the band, copied out 2026-08-23)
~/lastlight-run-artifacts/2026-08-23_054143-64862d5-wp3-rep2/
~/lastlight-run-artifacts/2026-08-23_055425-64862d5-wp3-rep3/
  └── <instance_id>/pr-review/
        facts.json  obligations.json  obligations/*.md
        hypotheses/*.jsonl  findings.json  disposition.json
```

**The four 2026-08-22 runs carry NO overlay provenance** — `meta.overlay`,
`meta.overlays`, `meta.harness`, `meta.argv` and `meta.keepWorkspace` are all
absent; they predate the `RunProvenance` stamp. Their identity as
"baseline" vs "wp3 run 1/2/3" exists **only in this file**. Any tool that
re-analyses them must take the run ids as an argument and must never infer the
arm from disk — all four are the same tier, the same run type, the same arm
label and the same 8-case set, so anything grouping by those will fold the
*baseline* in with the candidates.

The **transcripts are not there** — they live beside the scorecards, under
`eval-results/pr-review/<run-id>/sessions/<instance>__<model>/trial-1/*.jsonl`,
and they exist for **all three** runs including run 2. The workspace copies and
the transcripts are separate preservation mechanisms; only the first needs
`--keep-workspace`.

Run 2 was run without `--keep-workspace` — **a mistake worth not repeating.**
Always pass it.

### Three runs, and the shape of the noise

| | run 1 | run 2 | run 3 | mean |
|---|---|---|---|---|
| arm | 0.320 | 0.080 | 0.200 | **0.200** |
| train (13 gold) | 0.462 | 0.000 | 0.154 | 0.205 |
| blind (12 gold) | 0.167 | 0.167 | 0.250 | 0.194 |

**The mean is 0.200; the union is 0.440 and the intersection is 0.040.** An
earlier draft of this file read "15 of 75 gold-instances pooled across three
runs" — that is 3 × 25 counted as 75 independent slots, which is a *mean* wearing
a pooled coat. The number that matters is over the 25 gold: **11 of 25 were
matched by at least one run, 1 of 25 by all three.** Never a baseline hit lost,
in any run.

Per case, gold matched by ≥1 run over gold:

| Case | union | Case | union |
|---|---|---|---|
| `1587-r1` | 1/3 | `1667` | **0/5** |
| `1587-r2` | 4/5 | `1680-r1` | 2/4 |
| `1587-r3` | 1/4 | `1680-r2` | 2/3 |
| `1641-r2` | 1/1 | | |

*Computing this yourself: `review.trace.gold[].matchedFinding` and
`review.falseNegatives` **agree**, and either reproduces 11/25. Checked on the two
cases where they were once claimed to diverge — in run 3 `1587-r2` carries
pointers at gold `[0, 4]` and `1680-r2` at `[0, 2]`, both matching their
`matched: 2` and both equal to `gold − len(falseNegatives)`. `goldHits()` reads
the `matchedFinding` field and is sound; `varianceRollup` is built on it.*

## What the deep scan of runs 1 and 3 found

Read off the two preserved workspaces and the four scorecards. No model spend.

**1. `prepare` and `falsify` were skipped 8/8 — in both runs.** The probe oracle
has *still* never been executed by a model, so the adjudicator's delete power is
inert by construction, exactly as [TLDR.md](TLDR.md) gap 2 says. This is not a
regression; it has never run. Two consequences follow, and the second is the
expensive one.

**2. The `tests` family is structurally dead, and says so.** Every case reports
`tests: measured: false — "no coverage artifact was read, so uncovered changed
lines are UNKNOWN rather than none — nothing produces one until WP4's prepare"`.
One of six families contributes nothing because the phase that would feed it is
skipped. The envelope is honest about it; nobody had read the envelope.

**3. The seed layer is DETERMINISTIC, and all the variance is downstream of it.**
*Established by run 3, and it retires the leading hypothesis of an hour earlier.*

Comparing run 1 and run 3 obligation-for-obligation: **byte-identical on all
eight cases** — same ids, same families, same mechanisms, same counts. `facts`
and `seed` do exactly what they are supposed to do.

The same eight cases then produced **wildly different hypothesis volumes from
that identical brief**:

| Case | Obligations (both runs) | Hypotheses r1 → r3 |
|---|---|---|
| `1587-r1` | 31 | 18 → **43** |
| `1667` | 7 | 10 → **23** |
| `1680-r1` | 1 | 10 → **19** |
| `1587-r3` | 40 | 45 → 45 |
| `1587-r2` | 33 | 42 → 39 |

**So the variance is entirely in what the survey models do with a fixed input** —
up to 2.4× the hypothesis volume from the same obligations. That is a much
sharper target than "the pipeline is noisy", and it points every remaining lever
at the survey stage rather than at the deterministic layer.

**4. Obligation supply does NOT predict recall — the under-seeding theory is
dead.** Written after run 1, it looked compelling: the blind cases drew 1, 1 and
7 obligations against the train cases' 31–40. Three runs kill it.

- `1680-r1` has **one** obligation and matches **1/2/1** across the three runs.
- `1667` has **seven** and matches **0/0/0** — it has never been cracked.
- `1587-r3` has **forty** and matches **1/0/0**.

And the split means are **train 0.205, blind 0.194** — statistically the same.
The "blind is worse" reading was itself noise from a single run; blind is in fact
the *more stable* half (0.167 / 0.167 / 0.250 against train's 0.462 / 0.000 /
0.154). Do not build on it.

**The one durable per-case signal is `1667`: 5 gold, zero matched in all three
runs, and 3/0/4 posted.** That is not noise, and it is the only case where a
consistent story can be read off three data points.

**5. Identical effort, wildly different yield.** Per-phase totals across the two
runs are within ~10–20% everywhere (`survey_branch_contract` 1399 s vs 1382 s;
`adjudicate` 1551 s vs 1872 s; total $15.65 vs $17.55). The runs worked equally
hard and concluded differently. **The variance is in what the surveys decided,
not in how much they did** — which rules out "it ran out of budget" as the story.

**6. The funnel barely narrows.** Hypotheses → findings is close to lossless
(`1641`: 32 → 32; `1641-r2`: 30 → 25; `1587-r2`: 42 → 37). Almost all the
selection happens in the attention boundary's tiering, not in adjudication. On
`1641` — the zero-gold case — all 32 findings landed `internal` in run 1 and
nothing posted, which is the boundary working exactly as designed.

**7. `coverage: degraded` on all 8 cases**, every one a `tsgo` complaint that
some base-view files are covered by no `tsconfig` and were analysed in an
inferred project. Unquantified. It may be nothing; it is also the kind of thing
that silently costs an extractor its precision.

**8. The spec axis is genuinely live** — its hypotheses cite `S-1`/`S-2`
obligations with `QUOTE` claims. Note that spec obligations do **not** appear in
`obligations.json` or `obligations/`: they are built harness-side by
`review-spec.ts`, and `obligations.json` explicitly records why. Counting
families out of that file alone will make the spec axis look dead when it is not.
It looked exactly like [RESTART.md](RESTART.md) §4 trap 4 for about ten minutes.

**9. A survey branch silently loses its entire seed about one time in six, and
which branch loses it is random.** Found in the transcripts while answering E1,
and it is a bug, not a tuning question.

Each survey branch opens by reading `.lastlight/pr-review/obligations/<family>.md`.
It resolves that relative path against the **sandbox root** rather than the repo
checkout one level down, and when it does the read is `ENOENT`. Across the three
runs, **23 of 120 non-`spec` survey branches** read their obligations file and
got nothing:

```
ENOENT: no such file or directory, access
'…/sandboxes/skillspro-1667-pr-review-prreview__skillspro-1667/.lastlight/pr-review/obligations/enforcement.md'
```

The repo is at `…/sandboxes/<name>/skillspro/`. The *write* in the same branch
goes to `…/sandboxes/<name>/skillspro/.lastlight/pr-review/hypotheses/…` and
succeeds — so the read and the write disagree about the base directory, in one
branch, in one process.

What happens next is worse than the read failing. The branch does not stop; it
writes a hypothesis line saying **`"claim": "no obligations file was present",
"status": "NOT_MEASURED"`** and then free-styles the family off the raw diff. In
`1667` run 3 that is exactly what `enforcement` did — and `O-003`, the obligation
naming `slackService.ts:90`, which is one of the five gold **to the line**, was
never put in front of it. The `review` phase then stamped `O-001`/`O-002`/`O-003`
onto three findings that have nothing to do with `USERS_PAGE_SIZE`,
`SEND_SLICES` or `MAX_USER_PAGES`. **The `obligation` field on a finding is
therefore not trustworthy** — it is assigned positionally downstream, not carried
through.

This is a per-branch coin flip that deletes a whole family's seed, and it lands
on a different family every run. It is the best available mechanical explanation
for finding 3's "identical brief, 18 vs 43 hypotheses", and it should be fixed
before any more money is spent measuring the variance it causes. (`spec` reads no
`.md` at all — it is seeded inline, per finding 8 — so it is excluded from the
denominator, not a 24th failure.)

## 2026-08-23, later — internal recall exists now, and it moves the target

**The instrument that measures discovery separately from posting had never been
wired** (see [RESTART.md](RESTART.md) §2d). It is now, and back-filled onto every
preserved run for ~$0.66 of judge calls. What it says reframes most of this file.

| run | posted recall | **internal recall** |
|---|---|---|
| `2026-08-22_184650` (wp3 run 1) | 0.320 (8/25) | **0.480 (12/25)** |
| `2026-08-22_201607` (wp3 run 3) | 0.200 (5/25) | **0.480 (12/25)** |
| `2026-08-23` band, rep 1 / 2 / 3 | 0.000 / 0.000 / 0.000 | **0.400 / 0.400 / 0.000** |

**The two 8-case runs discovered exactly the same amount — 12 of 25, both — and
said 8 and 5.** The whole 0.120 posted-recall difference between the two runs
that this file has spent pages characterising as *"the pipeline is noisy"* sits
**downstream of discovery**. Discovery was stable; what happened to it afterwards
was not.

Decomposing the 12 → 8 and 12 → 5 gaps:

| | run 1 | run 3 |
|---|---|---|
| found | 12 | 12 |
| …on a posted tier | 9 | 9 |
| …withheld by the boundary | 1 | 3 |
| …tier unknown (no `disposition.json`) | 2 | 0 |
| **credited by the posted-review judge** | **8** | **5** |

So the attention boundary is **not** the main channel. Nine matched findings were
on a posted tier in both runs, and the judge credited 8 and 5 — meaning
**something loses a true finding between "tiered for posting" and "recognised in
the review text"**, and in run 3 that channel is larger than the boundary. Two
candidate causes, and they are not the same problem:

- **The body buries it.** Run 3 posted 44 findings; the 08-23 rep1 posted 27 body
  bullets of which 17 were anti-findings. The judge's extract step is instructed
  to ignore *"praise, approvals, meta commentary"* — a real finding in that
  company may read as confirmation. If this is it, anti-findings do not merely
  cost attention, **they camouflage the findings that matter**, and the
  clean-discharge demotion is a recall lever rather than a precision one.
- **Grader noise** between two matching passes over different inputs (structured
  findings vs prose). `scripts/rescore.ts --repeat-judge N` measures exactly this
  and is the cheapest next thing in this file.

**Consequences for what to run.** Read every arm on internal recall first —
posted recall now has a measured, large, and previously unattributed loss stack
in front of it. And the 08-23 regression is **not purely a discovery regression**:
two of its three repeats found 2 of 5 and posted none of them.

**This also retires [RESTART.md](RESTART.md) §3c as written.** *"Both misses were
discovery failures … the filters demonstrably kept their hands off gold"* was
traced on one run's three gold. Over 25 gold it does not hold.

## Five experiments, cheapest first

Deliberately small. Each answers one question, and **the first two spend nothing** —
do those before authorising any arm.

### E1 — Why has `1667` never been cracked? — **ANSWERED, $0**

The prediction held on content: `1667`'s gold *is* the auth-ordering and
rate-limit material. The prediction about the classification did not. It is
**split roughly half (1) and half (2), and (3) is zero** — and the half that is
(2) is the more damning half, because the pipeline *visited the line and cleared
it*.

Gold by gold, against the seven obligations (identical in both preserved runs):

| # | Gold | Break |
|---|---|---|
| 1 | `notifications.ts:436` — `'dryRun' in body` 500s on a scalar body | **(1)** `security` family: **zero obligations**. Nothing named it. |
| 2 | `notifications.ts:448` — `bearerTokenAuth` as `preHandler`, so auth runs after validation | **(1)** same: zero security obligations, and no `state` obligation covers hook registration order. |
| 3 | `slackService.ts:19` — `rejectRateLimitedCalls` removes 429 retry while `SEND_SLICES` goes 1→5 | **(1)** `contract` family: **zero obligations**, because `createSlackClient`'s `consumersOutsideDiff` is `[]`. Both halves were seen separately — `O-002` *is* `SEND_SLICES` — and nothing asked the joint question. |
| 4 | `notifications.ts:111` — dry run returns before the report/upload path | **(2)** `O-006` anchors `postRunSummary` at `:104` and its changed hunk is `111–121`. The obligation covers the line. Its **question points outward** at the untouched call site at `:577`, so `state-003` answered that instead and closed clean. |
| 5 | `slackService.ts:90` — the `MAX_USER_PAGES` guard cannot tell truncation from a 25-page workspace | **(2)**, unambiguous. `O-003` lists `slackService.ts:90` as a candidate, **delta 0**. Run 1's `enforcement-003` *quoted line 90* and concluded "enforced as a break condition… preventing runaway pagination". Confidence 0.99. |

**(3) is zero, and `disposition.json` settles it outright.** Nothing gold-shaped
was suppressed. Every `internal` entry in both runs is an *anti*-finding — a
confident CLEAN at the gold's own address:

- run 1, `notifications.ts:436` (gold #1, to the line): *"Security: no injection
  issues found; input validation is properly enforced"*, confidence 1.0
- run 1, `notifications.ts:433`: *"Spec obligation S-1 fully implemented: strict
  dryRun validation…"*, 0.99
- run 3: *"Security: Type coercion attack on dryRun parameter prevented"*, 1.0 —
  the exact opposite of gold #1
- run 1, `slackService.ts:34`: *"Constant MAX_USER_PAGES properly enforced at
  multiple boundaries"*, 0.99 — covering gold #5 at `:90`
- run 3, `notifications.ts:110`: *"State: postRunSummary signature extended with
  dryRun"*, 1.0 — gold #4 is at `:111`
- run 3: *"Contract: createSlackClient exported"* — gold #3's function, noted for
  its export surface and not its retry policy

**Six of six gold locations were read, and six of six were cleared.** The
pipeline is not failing to look. It is looking, asking a question that the code
answers innocently, and filing the innocent answer.

The reason is legible in the two question templates. Every `enforcement`
obligation asks *"Quote the line that compares or enforces `X`, or state that no
such line exists"* — which any use of `X` satisfies. Every `state` obligation
asks *"Quote the line at each untouched call site that still holds after `S`'s
change"* — which points away from the changed body, where four of `1667`'s five
defects live. Neither template can express "the guard exists and cannot
distinguish two cases", "the check is in the wrong lifecycle phase", or "the
concurrency went up in the same diff that removed the retry".

**Why the surveys never even saw `O-003` in run 3:** finding 9. That branch went
obligation-blind. But run 1's `enforcement` branch read the file fine and *still*
cleared line 90 — so finding 9 is a compounding factor here, not the cause.

**Is `1667` representative?** In kind, yes. Of the **14 gold no run ever
matched**, the same split holds and **(3) is 0 of 14**:

- **(1), no obligation touches the file at all — 4:** `1587-r1`
  `users.ts:115` (netsuite fallback returning `200 []`); `1680-r1`
  `strip-public-photo-permissions.ts:57` and `:58` (both — that case draws
  exactly **one** obligation, in a different file); `1680-r2` `AGENTS.md:345`
  (a stale-documentation finding — no extractor produces facts about prose).
- **(1)/(2) boundary, an obligation is in the file but on a different
  mechanism — 8**, including all four of `1667`'s.
- **(2), an obligation names the line and the survey cleared it — 2:** `1667`
  `slackService.ts:90` (delta 0) and `1587-r3` `users.ts:103` (`O-003` candidate
  at `:104`).

And the clear-it-and-file-it pattern is not special to `1667`. Sweeping every
never-matched gold for a finding within ±8 lines in either preserved run turns up
only CLEANs: `1587-r2` `secureRouteHandler.ts:16` → *"skips token refresh for
ID-token sessions"* (internal); `1587-r3` `users.ts:103` → *"Spec S-8: Graceful
degradation **verified**"*; `1587-r3` `auth.ts:141` → *"Spec S-2: Email-keyed
identity preservation **verified**"*, *"Spec S-4: Same cookie shape
**verified**"*, *"Spec S-6: Client ID matching **verified**"*.

`1667` is exceptional only in **degree**: it is the one case where all five gold
land in the blind spots simultaneously, and where the surveys reached every one of
them and confidently signed it off.

**So the fix is not more obligations. It is better questions on the obligations
we already mint**, plus two narrow seeding gaps. That is the brief for the
question-catalogue work; see [E1a](#e1a--the-question-catalogue-0) below.

### E1a — The question catalogue ($0 to draft)

6–10 recurring question shapes per family, each phrased so that a **quoted line**
is the only honest answer and an innocent quote is not available. Derived
directly from the 14 misses above; the `state` family carries `1667`'s gold and
gets the most.

**`state` — ordering, lifecycle, concurrency.** Replaces "quote the line at each
untouched call site", which produced four clean discharges on `1667` and found
nothing.

1. *Hook / phase ordering.* "This route registers `<hook>` at `<line>`. Name the
   framework's phase order, then quote the earliest line that rejects an
   unauthenticated caller. List every check that runs before it." → gold #2.
2. *Early return coverage.* "The changed function returns early at `<line>`. List
   every statement between that return and the end of the function, and quote the
   line that still runs them on the early path — or name the ones it skips." →
   gold #4.
3. *Guard vs natural terminal.* "This loop stops when `<counter> >= <CONST>`.
   Quote the line that distinguishes *the source was exhausted* from *the cap was
   hit*, or state that one line is true in both cases." → gold #5, first half.
4. *What happens after the guard trips.* "When `<guard>` trips, quote the line
   that propagates it to the caller. If a partial result is returned and the
   caller's success path is unchanged, quote the response line that reports
   success on truncated data." → gold #5, the more serious half.
5. *Concurrency × retry conjunction.* "This diff changes a parallelism constant
   from `A` to `B`. Quote the line that bounds or retries the resource the extra
   concurrency contends for. If that line was **removed or weakened in this same
   diff**, quote both." → gold #3, and the only shape that spans two facts.
6. *Partial-failure legibility.* "For a run where some items fail: quote the line
   that makes it a non-2xx, or the line that carries the failed items into the
   summary. If neither exists, quote the line that returns success with an error
   count."
7. *Cross-request lifetime.* "The changed symbol keeps state across requests.
   Quote the line that invalidates it **and** the line where its clock starts." →
   this shape already works: `1680-r1`'s TTL-clock finding is the **only gold
   matched by all three runs**.
8. *Revalidation ceiling.* "This early return skips revalidation. Quote the line
   that bounds how long a stale credential stays accepted." → `1587-r2`
   `secureRouteHandler.ts:16`.
9. *Two-path divergence.* "This branch selects between two data sources. Quote
   the line proving both return the same set, or name the field on which they
   differ." → `1587-r3` `users.ts:103`.
10. *Failure-path cleanup.* "On the error or null-return path, quote the line
    that burns the single-use token or nonce, or state that the failure path
    leaves it replayable." → `1587-r3` `auth.ts:141`.

**`enforcement`** — same disease, one-line cure: stop asking whether the line
exists, ask what it cannot tell apart.

1. "Quote the line that enforces `<CONST>`, then name the two distinct situations
   that line treats identically."
2. "`<CONST>` caps a loop, page or batch. Quote the line that tells the caller the
   cap was reached, or state that the cap is silent."
3. "Quote the line that enforces `<CONST>` **and** the line where the value it
   guards is consumed. If consumption happens first, quote both in order."
4. "This value is written on one side and read on the other. Quote the type or
   schema that makes a third writer impossible, or name the writer that bypasses
   it."
5. "`<CONST>` changed value in this diff (`A` → `B`). Quote the line elsewhere
   that still assumes `A`."

**`security`** — owns two of `1667`'s five gold and minted **zero** obligations
for it, so these need a seeding change as well as a question.

1. "Quote the line that rejects a request body that is not an object. If the only
   guard is a property test (`'x' in body`, `body.x`), state what it does for a
   scalar body." → gold #1.
2. "Order the lifecycle phases this route registers. Quote the earliest phase
   that rejects an unauthenticated caller." → gold #2.
3. "Quote the line proving malformed input answers 4xx and not 5xx."

**`contract`** — currently fires only when `consumersOutsideDiff` is non-empty,
which is why `1667` drew zero.

1. "This symbol is new or changed and every consumer is inside the diff. Quote
   the line inside it a caller cannot see and would be surprised by — a retry
   policy, a timeout, a swallowed error class." → gold #3.

**Two seeding changes for `code-facts`**, both narrow, both read straight off
`facts.json`:

- **Mint for all-in-diff symbols.** Obligations are minted exactly when
  `referenceCount − referencesInDiff > 0`. `strictDryRun` (declared `:433`, sole
  reference at `:448` — gold #1 and #2 *are* those two lines) has 1 of 1 in diff
  and mints nothing. `createSlackClient` has 2 of 2 in diff and mints nothing. A
  defect entirely inside a new hunk is invisible to the current rule.
- **Mint on route/hook registration.** Nothing in `facts.json` represents "this
  handler registers checks in phases, and here is their order", which is the
  whole of gold #2.

### E1b — Fix the ENOENT before measuring anything else ($0 to fix)

Finding 9. One path resolution, 23 lost seeds in 120 branches, and a plausible
share of the variance E3 proposes to spend ~$34 characterising. Fix it, then run
E3, or E3 measures a bug.

### E2 — Why does one brief produce 18 hypotheses once and 43 the next? ($0 first)

Finding 3 is the sharpest lead in this file. Two halves: whether the extra volume
is dilution or genuinely different questions, and whether unioning runs would buy
recall.

**The union half is now measured, and the answer is encouraging.** Over
the 25 gold: mean 0.200, **union 0.440, intersection 0.040**. Three samples of
the same configuration more than double the recall of one, and only one gold in
twenty-five is found reliably — so the runs are near-independent draws, not one
capability plus noise. That 0.440 is the ceiling a three-way sampling strategy
would buy *at three times the cost*, and it is a real ceiling: it says the
capability to find those eleven is already present and is simply not being
exercised consistently.

What is still open is the mechanism, and finding 9 now offers a cheaper
explanation than sampling: if a sixth of survey branches lose their seed at
random, three runs union to more than one run **because between them they manage
to deliver every seed at least once** — not because the models genuinely
disagree. Fix E1b first. If the union collapses toward the intersection
afterwards, sampling was never the lever; if it holds, it is.

The qualitative half is unrun and still free: `1587-r1` has identical obligations
in both runs and 18 → 43 hypotheses. Diff the two `hypotheses/*.jsonl` sets. Is
the extra volume *more of the same*, or genuinely different questions?

### E3 — Put an error bar on the band (~$17 per repeat)

Three runs give 0.320 / 0.080 / 0.200 — a mean of 0.200 and a range that
straddles the ≈0.24 detection floor. Two more would make the mean meaningful;
until then no lever below a large effect is measurable. Always
`--keep-workspace`. Sequential, never overlapping a build ([RESTART.md](RESTART.md)
§4 trap 6).

Cheap variant: repeat **one** case 5× instead of 8 cases 3×. `1587-r2` (5 gold,
the best-performing case at 3/0/2) is the natural subject.

### E4 — Turn `prepare` on ($ ~1 arm)

It is skipped 8/8 today, which means the probe oracle is inert *and* the `tests`
family is dead. Turning it on is the only change that could plausibly move a
family from "structurally silent" to "contributing". Measure it as its own arm,
one variable.

### E5 — Reshape `review` when the pipeline is on (~1 arm)

[RESTART.md](RESTART.md) §3b lever f4, still unbuilt and still the most obviously
wasteful thing in the DAG: `review` runs a full independent review costing ~$2.30
per arm while 40+ hypotheses sit unread beside it. It cannot simply be skipped —
`post-review` depends on it with `all_success` — so change its brief under
`{{#if analysisEnabled}}`.

**Do E5 after E3.** It is the one most likely to be swamped by variance.

## The guardrails that still apply

- **Never seed a bot review over gold** ([RESTART.md](RESTART.md) §4 trap 9).
  `prreview__skillspro-1641` is the one sanctioned exception and its gold must
  stay empty.
- **A fixture replays the moment the review happened.** Everything after it is
  the future, and the gold review lands *after* ours.
- **If any lever shows precision up and recall down, that is locked decision 1
  reproducing for the fifth time**, not a tuning opportunity.
- **Gate on mechanism metrics** — obligations, discharge rate, the per-family
  funnel, conservation. Report micro-recall; do not steer on it. The detection
  floor is ≈0.24 and we now know the run-to-run spread straddles it.
- **Every eval arm is human-authorised spend.** A sub-agent never runs one
  unprompted.

## The honest summary, for anyone tempted to quote a number

The pipeline finds real defects that the shipped reviewer misses entirely, at
roughly 7× the cost, with run-to-run variance wide enough that a single arm
cannot tell you how well it works. The mechanism is sound and measured; the
magnitude is not yet established; the generality is not even in evidence.
