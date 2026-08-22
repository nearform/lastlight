# The spike — prove it before committing

**Goal.** Implement **`facts` and `contracts` only** on the `typescript@7.0.2`
API, behind `--engine tsgo`, and run it against the frozen baseline. Nothing
else changes; nothing is deleted; `ts-morph` remains the default for the
duration.

> **Tree state, 2026-08-22.** The seam itself has landed:
> `packages/code-facts/src/tsgo.ts`, 619 lines, **untracked**. What does *not*
> exist yet: `tests/tsgo.test.ts` (referenced from that file's header), the
> `--engine tsgo` flag in `src/cli.ts`, and any extractor rewired to use
> `openSnapshot`. So the spike below starts at "wire `facts` and `contracts`
> through the existing seam", not at zero.

**Why `facts` + `contracts` and nothing else.** They are the two extractors that
need a checker at all. `constants` needs only reference set A (which is
`facts`' machinery). `deps`, `patterns` and `coverage` load no project. And
`contracts` is where every phantom-delta bug in this package's history has
lived, so a spike that skipped it would prove the cheap half.

**Read before starting:**
[README.md](README.md) (the contract and the API-surface mapping),
[01b-code-facts-hardening.md](../review-evidence-pipeline/01b-code-facts-hardening.md)
(the measurement record and the house rules for quoting numbers),
[HANDOFF.md](../review-evidence-pipeline/HANDOFF.md) (traps + human sign-off),
and `packages/code-facts/CLAUDE.md` in full.

## The baseline

Everything below compares against one frozen run:

```
apps/evals/eval-results/facts-corpus/2026-08-21_140115-c8530b83/
├── report.json      meta + rollup + 50 cases
├── report.md
└── case/            one envelope per case
```

**Verified present, 2026-08-22.** `meta`: 50 cases, `profile: full`,
`gitSha: c8530b83`, `factsVersion: 0.1.0`, `platform: darwin-arm64`,
`node: v24.16.0`, `neverFail: false`, `concurrency: 1`.

Its rollup, which is what the gates are read against:

```
byTier      {"1": 21, "3": 29}          byCoverage {"degraded": 50}
byExitCode  {"3": 50}                   noEnvelope []
wallClockMs {p50 3302, p90 8423, max 26857, over90s 0}
peakRssMb   {p50 264.4, p90 1152.1, max 2987.8}
totals      symbols 318 · contracts 73 · consumersOutsideDiff 147
            referencesTotal 1566 · referencesInDiffTotal 423
            constants 0 · depChanges 7 · patternFindings 13
            coverageChangedLines 16436 · emptyEnvelopes 27
```

Two of those need reading correctly before anyone treats a change in them as a
result:

- **`constants: 0` is the honest answer, not a regression to chase.** 29 of 50
  cases are tier 3, where there is no reference set A at all, and the remaining
  tier-1 diffs changed no constants.
- **`byCoverage: degraded` on all 50 and `byExitCode: 3` on all 50** is the
  corpus's normal state — bare worktrees with no `node_modules`, which is
  production's shape. `coverage: "full"` on a corpus case would be the surprise.

## The gates

All five are **free of model spend**. Every instrument named below was verified
to exist on 2026-08-22; the command shown is the one to run.

| # | Gate | Instrument | Pass condition |
|---|---|---|---|
| **G1** | **no entity loss** | `apps/evals/scripts/facts-corpus.ts` — run it, then `--compare <new> --against 2026-08-21_140115-c8530b83` | the `facts.symbols` / `contracts` / `constants` **entity sets do not shrink**. Read the sets, not just the totals |
| **G2** | **no phantom deltas** | `pnpm --filter lastlight-code-facts selfcheck` | **exit 0**, and the phantom-capable delta count no higher than today's. This is the gate that matters most |
| **G3** | **the sensitivity floors still mean something** | `packages/code-facts/tests/noise-floor.test.ts` | all six assertions green — **and a recorded decision on cause 2**, which this change may make vacuous. See below |
| **G4** | **memory** | corpus peak RSS, from the new run's `rollup.peakRssMb` | **max < 500 MB** (baseline max **2987.8 MB**, p90 1152.1, p50 264.4). Report all three percentiles, not just the max |
| **G5** | **evidence coverage does not fall** | `apps/evals/scripts/facts-evidence.ts --run <new> --baseline 2026-08-21_140115-c8530b83` | **EC-strict does not fall.** Baseline: 14/99 = **14.1%** overall, 12/26 = **46.2%** on the TS/JS half; EC-loose 15/137 = 10.9%. Expected to *rise*, since monorepo tsconfig blindness is gone |
| **G-impl** | **the `getImplementations` question, answered either way** | a standalone probe; `API.fromLSPConnection` + `textDocument/implementation` | **either** a working implementations query over a shared snapshot, **or** a written "no" plus `implementations: null` + a `degraded[]` entry. A measured *no* passes this gate |

### G1 — the instrument, corrected

An earlier draft named `apps/evals/scripts/diff-runs.ts` for this gate. **That
script exists but is the wrong one**: it compares two **pr-review eval
scorecards** (`scorecard.json`, per-case F1, train/held-out KEEP-or-REVERT) and
knows nothing about a facts envelope.

The right instrument is built into the corpus harness:

```bash
# measure a new run
npx tsx apps/evals/scripts/facts-corpus.ts --profile full

# diff two STORED runs and measure nothing
npx tsx apps/evals/scripts/facts-corpus.ts \
  --compare <new-runId> --against 2026-08-21_140115-c8530b83
```

`--compare <old>` also works immediately after a live run. The harness resolves
its dataset via `--dataset` → `LASTLIGHT_EVALS_DATASETS`, and its mirror cache
via `--cache` → `LASTLIGHT_EVALS_CACHE` → `<cwd>/.eval-cache`; the baseline run
used `~/work/lastlight-evals/datasets/pr-review/instances.json` and
`~/work/lastlight-evals/.eval-cache`. Point the new run at the **same two**, or
the comparison is between different corpora.

**`--compare` reports counts. G1 is about sets.** A run that loses eight symbols
and gains eight reads as flat. Extract the `(file, name)` pairs from
`case/*.json` on both sides and diff them; a symbol present in the baseline and
absent in the candidate is a G1 failure whatever the total did.

### G2 — why `selfcheck` is a valid referee for an engine swap

```bash
pnpm --filter lastlight-code-facts selfcheck    # → tsx scripts/selfcheck.ts --repo ../..
```

`src/selfcheck.ts` cross-checks the envelope against **git** — `git show
<head>:<file>`, `git diff --name-status`, `git diff -U0` — **not** against
ts-morph. An oracle built from the same machinery as the thing under test cannot
see a plausible-and-wrong answer, because both halves are wrong in the same
direction. That is exactly why it was built, and it is why an engine swap is the
case it was built for.

It exits non-zero on a `removed` delta with no deletion or rename in the diff,
on more than 40 contract deltas **that could be phantom**, or past 90 s. Expect
~30 of 31 analysable changed files analysed today.

**Not in CI, deliberately** — `actions/checkout` defaults to `fetch-depth: 1`,
so `HEAD~1` does not exist on a runner.

### G3 — one of the three floors may become vacuous, and that needs a decision

`tests/noise-floor.test.ts` is three ceilings paired with three floors. Be
precise about what is pinned, because the numbers usually quoted are the
**measured** values and the **assertions** are looser:

| proof | assertion in the test | measured value quoted in `01b` / `CLAUDE.md` |
|---|---|---|
| cause 1 — the one-sided guard | `unguardedRemovals > 10`, `> guarded`; `oneSidedFiles > 10`; `guarded ≤ 3` | 41 deltas / 40 removed exports |
| cause 2 — the `node_modules` mirror | `unmirrored.contracts.length > 10` and `> document.contracts.length` | 17 |
| cause 3 — `canonicalType` | `rawTextDiffers > 10`, `canonicalAgrees === rawTextDiffers` | 24 |

Plus the ceilings: exactly **1** real delta, **≤ 3** total, **0** `removed`.

**Cause 2 is the one to watch.** `mirrorNodeModules` exists because the head
tree and the temp base worktree can disagree about what is on disk. Under a
single-tree overlay **both sides are the same tree**, so the asymmetry is gone
**by construction** — and the floor that proves the mirror is load-bearing
becomes unreachable.

This is the same hazard `01b` already named for `--resolution none`: *"a tier
that resolved nothing would make that floor unreachable and the proof vacuous,
which is the failure locked decision 6 exists to prevent, one layer down."*

**So G3 requires a written decision, not a green tick.** Either the cause-2
proof is re-expressed as something the new engine can still be wrong about (an
overlay that serves a base blob for a file whose *package* differs between the
sides), or it is deleted **with a note saying the cause is structurally
impossible and why**. Silently deleting a sensitivity proof because the fix it
guards became unnecessary is how a package loses the ability to detect the
regression that brings it back.

### G4 — measure on **bare** trees, and say so

The corpus runs on bare-mirror worktrees (`git worktree add --detach`, never a
clone) with **no `node_modules`**, which is production's shape. The 500 MB
target is against the baseline's bare 2987.8 MB max.

**An installed-tree number is a separate measurement and is currently
unknown.** `--resolution changed` exists because the JS checker followed bare
specifiers one layer below the API the file budget was expressed in; whether the
Go compiler's `node_modules` `.d.ts` cost behaves the same way has not been
measured on any tree. Run five commits of this monorepo installed, as
[01b](../review-evidence-pipeline/01b-code-facts-hardening.md) did, and record
the answer — it is what decides whether `--resolution` survives the migration
at all.

### G5 — read all three denominators

`facts-evidence.ts` is an **upper bound on the recall attributable to
`code-facts` as a seeder**: if the envelope never names the identifier a gold
finding is about, no seeder can produce an obligation about it. It is not
recall, not precision, and naming is necessary but not sufficient.

```bash
npx tsx apps/evals/scripts/facts-evidence.ts \
  --run <new-runId> --baseline 2026-08-21_140115-c8530b83
```

Report the discovery ceiling (EC-loose / all gold), the evidence coverage
(EC-strict / anchored), and the TS/JS split, with the candidate pool beside
them — per [08-evals.md](../review-evidence-pipeline/08-evals.md). Quoting one
number without its denominator is how the 35.52% / 2.80% mistake gets made.

Anchors are frozen and hand-audited (`apps/evals/datasets/pr-review/anchors.json`,
via `apps/evals/scripts/facts-anchors.ts`). **Editing them is human sign-off
item 2.** A spike that moves EC by editing the labels has measured nothing.

## What the spike deliberately does NOT do

- **No deletions.** `src/resolution.ts`, `withWorktree`, `selectNeighbourhood`,
  `--max-projects` all stay. The spike is behind `--engine tsgo`; the default is
  unchanged. Deletion is [02-migration.md](02-migration.md), after the gates.
- **No schema change.** `version: 1`, `EngineSchema` unchanged. A spike that
  changes the envelope cannot be diffed against the baseline.
- **No model spend.** Every gate here is deterministic.
- **No `constants`, `deps`, `patterns` or `coverage` work.** They do not need a
  checker; `constants`' set A rides on whatever `facts` proves.
- **No LSP build.** G-impl is a probe that answers a question. Building an
  LSP-backed reference provider is a follow-on with its own trigger.

## Traps, carried over verbatim from `HANDOFF.md`

Each of these has already cost someone a session. They are reproduced rather
than summarised because the summary is what gets ignored.

> **A measurement must never overlap a rebuild of what it measures.**
> *Generalised 2026-08-21 — it has now happened to two different instruments.*
> An earlier run of `facts-corpus.ts` was invalidated exactly that way: `pnpm
> build` landed a new `dist/cli.js` mid-run, so early cases measured one binary
> and late cases another, and nothing in the artifact said so. The guard is to
> `stat` `dist/cli.js` **before and after** and confirm every artifact's mtime
> falls inside that window; the simpler rule is to sequence them, and never to
> run a measuring agent concurrently with an agent that rebuilds. Same principle
> as `meta.core` on an eval scorecard — provenance is recorded, not remembered.
> **Contention counts as overlap, too:** the resolution-tier sweep in
> [01b](../review-evidence-pipeline/01b-code-facts-hardening.md) ran beside a
> full test gate and its peak-RSS numbers survived while its wall-clock numbers
> did not — one `bare/none` run that should take seconds recorded **1933 s**.
> Say which half of a contaminated measurement you are standing on, or re-run it
> clean.

> **A sub-agent that blocks on a long measurement gets killed by the stream
> watchdog.** *Added 2026-08-21 — two agents died this way in one day.* No output
> for **600 s** ends the agent, and a 50-run memory sweep produces nothing to say
> for far longer than that. Waiting is not the unit of work an agent is good for.
> Put the sweep in a **script that emits one line of progress per step**, start it
> detached (`nohup`), and drive it from the main loop — polling a foreground run
> from inside an agent burns cycles restarting and still dies.

> **Environment the measurements assume.** `opengrep` 1.27.1 and `gitleaks`
> 8.21.2 must be on `PATH` (see HANDOFF sign-off item 10) or the whole
> `patterns` family is stamped `missing` and silently contributes nothing.
> `lastlight-facts toolchain` prints what actually resolved. The 50-PR corpus
> needs the bare mirrors under `~/work/lastlight-evals/.eval-cache/repos/`
> (~4.9 GB) and the gitignored `datasets/pr-review/instances.json`; regenerate
> with `scripts/import-martian.ts` rather than assuming they are present.

> **Every diff is against the MERGE BASE, never the base branch's tip.**
> `base...head`, which is what GitHub's "Files changed" tab shows. Two-dot
> additionally contains every commit that landed on the base *branch* since the
> PR forked, and the author wrote none of it. **This is a production shape, not
> a dataset artefact** — the workflow reads `pull_request.base.sha`, the tip at
> event time. Measured, `sentry-greptile-1` is **6125 files two-dot against 3 at
> the merge base**. **Before adding any new git-range consumer, grep for the
> other ones and make them agree.**

One more, specific to this spike:

> **The overlay is a new git-range consumer.** It reads a **blob per changed
> file at the merge base** (`showFile(repo, baseSha, path)`), where `baseSha` is
> what `resolveDiffBase` produced. If it ever reads the working tree, or a
> different ref, the two sides of `contracts` are comparing different commits and
> every delta is suspect. `tests/merge-base.test.ts` is the existing guard on
> both halves.

## Definition of done

The spike is done when all six gates have been **read and written down** —
including the ones that failed. A measured *"this does not work"* is a
successful outcome of this task, and it is a cheaper one than discovering it in
[02](02-migration.md).

Specifically:

1. G1–G5 each have a number, a command, and a date.
2. G-impl has an answer, yes or no, with the probe kept.
3. G3's cause-2 decision is written down in this file.
4. The installed-tree memory question (G4's second half) has a number or an
   explicit "not measured, and here is why".
5. The CLI size delta is **measured**, not estimated — the ~21 MB → ~38 MB
   figure in [README.md](README.md) is an estimate and is labelled as one.
6. `pnpm turbo run typecheck test build` is green from the repo root with
   `--engine tsgo` present and **not** the default.
