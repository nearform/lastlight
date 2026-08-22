# RESTART — pick this plan up in a new session

Say *"restart the plan in `docs/plans/review-evidence-pipeline/`"* and start
here. This file is the operational entry point: what state the tree is in, what
is built, what to do next, and which traps will silently waste money.

For *why* the architecture looks like this, read [README.md](README.md) (thesis +
locked decisions) and [TLDR.md](TLDR.md) (one page). For the execution protocol
and the human sign-off list, [HANDOFF.md](HANDOFF.md).

> **Rewritten 2026-08-22.** The previous version was 716 lines of accumulated
> archaeology, most of it describing work now done or premises since falsified.
> Everything cut is still in git history.

## 0. Tree state — READ THIS FIRST

**Nothing is committed.** Branch `feat/review-evidence-pipeline`, HEAD
`1e06e24f`, **56 modified/untracked files** spanning five distinct pieces of
work. They want to be separate commits, and the `pr-review` SKILL.md fix in
particular deserves its own — it is a **production correctness fix** that has
nothing to do with the speed work it arrived beside.

```bash
git -C ~/work/lastlight status --porcelain | wc -l   # expect 56
git -C ~/work/lastlight log --oneline -1             # expect 1e06e24f
```

If that count is 0, someone committed since; read the log instead of this
section.

## 1. Prove the tree is sane

```bash
cd ~/work/lastlight
pnpm turbo run typecheck test build            # expect 24/24
pnpm --filter lastlight-code-facts selfcheck   # 31 of 31 analysed, exit 0
```

`selfcheck` is the fastest honest signal on the deterministic layer. It is
deliberately **not** in CI — `actions/checkout` defaults to `fetch-depth: 1`, so
`HEAD~1` does not exist on a runner. **Run it against a clean tree**:
`facts`/`contracts` read head off the filesystem, so on a dirty tree the default
`HEAD~1..HEAD` invocation compares old blobs to new files and is meaningless.

**Environment the measurements assume.** `opengrep` 1.27.1 and `gitleaks` 8.21.2
on `PATH`, or the whole `patterns` family is stamped `missing` and silently
contributes nothing. `lastlight-facts toolchain` prints what actually resolved.

## 2. What is built

The whole pipeline is **off by default** (`review.analysis.enabled: false`), and
`false` reproduces the shipped two-phase review byte-for-byte.

```
prepare → facts → seed → survey (6 branches, CONCURRENT) → falsify
        → review → adjudicate → reconcile → post-review
```

| WP | Status |
|---|---|
| WP0 spec axis, WP1/1b code-facts, WP8 the eval instrument | landed earlier |
| WP3 seed + six surveys · WP4 prepare + falsify · WP6 adjudicate | landed earlier |
| **WP11 speed + the correctness defects it uncovered** | **landed 2026-08-22, uncommitted** — [11-speed.md](11-speed.md) |
| WP2 sandbox image | not started — **blocks production, not measurement** |
| WP5 parallel phases | **PARKED**, and its carve-out was taken — [05-parallel-phases.md](05-parallel-phases.md) |
| WP7 review memory · WP1c grammars · WP9 external validation | not started |

**WP2 is what stops this reaching production at all**: `lastlight-facts` is not
in the sandbox image, so the pipeline can be *measured* (the eval runs
`--sandbox none` on the host) but not *switched on*.

### What WP11 changed, in one list

- **`type: fanout`** — the six surveys are one DAG node running six concurrent
  agent sessions in one `withSandbox`, with per-branch ledger rows
  `<phase>_branch_<name>`. Backend ceiling `none`/`docker` 6, everything else 1.
- **A per-phase instrument** — `durationMs` / `agentMs` / `costUsd` on every
  `PhaseMetric`, so a run is readable off `scorecard.json` instead of by hand out
  of transcripts.
- **`--concurrency N`** on the eval harness (default 1, a no-op by construction).
- **Family-namespaced hypothesis ids** `<family>-NNN`, assigned deterministically
  at ingest.
- **`lastlight-facts findings --ledger`** — the conservation checklist the
  adjudicator runs for itself.
- **The `pr-review` skill no longer re-shallows the checkout** (§4, trap 1).
- **The spec axis works for the first time ever** (§4, trap 4).

### Measured, `prreview__skillspro-1587-r1`, Haiku, one case each

| | before WP11 | run C | run D | run E |
|---|---|---|---|---|
| total | **29m13 / $2.49** | 11m59 / $2.01 | 11m43 / $2.05 | **11m36 / $2.34** |
| six surveys | 851s (chained) | 242s span | 211s | 234s |
| `adjudicate` | 426s **+ 274s retry** | 272s, no retry | 328s, no retry | 311s, no retry |
| gold / posted | — | 1 of 3 / 3 | 1 of 3 / 7 | 1 of 3 / 4 |

Run C's survey span came from the harness log, not its scorecard — run C
predates the attribution fix, so its branch rows carry no durations. D and E read
off the scorecard.

**Conservation passed on the first attempt in all three runs, twice against the
honest 30-id gate.** That is the WP11d claim, and it is the one quality-adjacent
result here that is solid.

**Nothing in that table is a recall result.** One case, one run per
configuration. The detection floor is ≈0.24–0.28 micro-recall on a 25-finding
gold set; a single gold moving is McNemar **p = 0.50**.

## 3. What to do next

Ordered by what each buys, not by effort.

### 3a. Learn what is and is not working — the cheap experiments first

The instrument and the concurrency flag exist precisely so these are affordable
now. An 8-case arm was ~4 hours serial; at `--concurrency 4` it is well under
one, and per-case ~12 minutes rather than ~30.

1. **Re-baseline both arms.** Too much changed today for any pre-2026-08-22
   number to be a comparator — the conservation gate was passing falsely, the
   spec axis was off-axis, `post-review`'s attention boundary was inert in run A,
   and the diff-range instruction was corrupting the checkout. Run
   `overlays/baseline` and `overlays/wp3`, 8 cases each. ~$4, well under an hour
   for both. **This is the highest-value spend available.**
2. **Repeat one case 3× unchanged** to size generation variance now that the
   funnel is honest. Across runs A/B/C the union of matched gold was 3/3 and **no
   gold was ever found twice** — variance is large and it is the thing that makes
   single-case readings meaningless.
3. **Read the per-family funnel** off the re-baseline: obligations → hypotheses →
   findings → posted, per family, with the spec axis finally contributing. `spec`
   emitted 12 discharges in run E (6 QUOTE, 1 PARTIAL, **1 ABSENT**, 3 N/A) — the
   ABSENT is a criterion a human wrote on the issue that the PR did not
   implement, a class of finding that was structurally unreachable before.

### 3b. The quality levers — approved, designed, UNBUILT

All four were approved and none were built; WP11 went into speed and into the
correctness defects that surfaced. Each needs its own arm, one variable at a
time.

| # | Lever | Why it is worth it |
|---|---|---|
| **f1** | **Stage the diff once** | 93 bash calls across the six surveys, ~30 re-deriving one fixed range that `facts.json` (137 KB) already holds. `survey_branch_contract` at 234s **is** the whole survey span, and it is the branch doing the most re-derivation. Cuts turns, which cuts latency *and* spend |
| **f4** | **Reshape `review` when the pipeline is on** | It still runs a full independent review — 137s and $0.30 — and in run A produced `APPROVE` with **zero findings while 41 hypotheses sat unread beside it**. **It cannot simply be skipped**: `post-review` depends on it with `all_success`, and a skipped node is not `succeeded`. Change its brief under `{{#if analysisEnabled}}` instead |
| **f3** | **A stronger adjudicator** | `models.review-adjudicate`, falling through to `models.review`. Haiku-beats-Sonnet is a *recall* result about *discovery*; adjudication is ranking over an already-generated set, a different task |
| **f2** | **Thinking effort** | The survey phases declare **no `variant:` at all**, so they inherit agentic-pi's default. Wire `{{variants.review-survey}}` through and measure |

**The guardrail on all four.** If any shows precision up and recall down, that is
the fifth reproduction of locked decision 1, not a tuning opportunity. No
adjudicator has ever beaten keeping everything (AACR F1 0.825, two models, 2,145
labelled comments, neither beat it).

### 3c. Where the evidence says quality actually lives

**Seeding, not tiering.** Forensics on run C traced all three gold end to end:
both misses were **discovery failures**. `dropped: []`; no gold-bearing finding
was demoted, tiered `internal`, or deleted. The filters demonstrably kept their
hands off gold.

The sharpest single data point in this whole plan: for gold G2, the survey agent
**read the code containing the exact asymmetry the finding is about** — two maps,
one lowercased and one not — and never formed the question. That is not an
affordance gap and not a filter problem. It is [TLDR.md](TLDR.md)'s thesis at
close range: *the model's question set does not contain the human's questions.*

Tiering is not exonerated (run A cannot be read on it — see §4 trap 5), but it is
not implicated either.

### 3d. Open backlog

Tracked as tasks; none blocking.

- **#6** the same `--depth` hazard in `skills/demo/SKILL.md:123` and
  `workflows/prompts/demo.md:62`. Lower stakes — demo does not review forked PRs.
- **#8** an eval fixture with **real base divergence**. Today the gate is
  structurally blind to diff-range corruption (§4 trap 1).
- **#9** pin the `--ledger` mechanism in a test — nothing asserts the adjudicate
  prompt still instructs it, so a prompt edit could silently drop it.
- **#11** the dashboard's `processMessages` pairs a tool call with the next
  matching result *after it in the array*; it survives concurrency only because
  `tool_use_id` happens to be globally unique — a property of the id generator,
  not of that code.
- **#15** the evals dashboard has **no test infrastructure at all**. Two real
  bugs today were caught only by hand-inspecting live data.
- **#20** "Where the time went" sums branch durations; six branches sum to ~708s
  across ~234s of wall clock, a ~3× overstatement. Concurrent siblings need max.
  Rows sharing a `_branch_` parent are the signal — no new field needed.
- **#21** `rescore.ts` cannot recover `durationMs` (it sums result envelopes), so
  back-filled runs conflate "skipped" with "un-instrumented".
- **#23** `add-case` does not capture linked issues, so every new pr-review case
  reintroduces the dead spec axis.

Longer-standing, from WP1b and unchanged: fingerprint collisions silently drop
findings (13 corpus findings → 11 fingerprints); `patterns` scopes to changed
*files*, not hunks; `facts`/`contracts` read head off the filesystem while the
changed set comes from git, which diverges silently on a dirty tree.

## 4. Traps that silently waste money

Every one of these has already cost something. **Three of five attempts at
running an arm measured the wrong thing, and none of them failed loudly.**

**1. The `pr-review` skill used to re-shallow the checkout — and the eval cannot
see it.** `skills/pr-review/SKILL.md` instructed `git fetch origin <base>
--depth 50`. A depth fetch writes `.git/shallow` **even into a complete clone**,
re-cutting history at 50 commits and severing the merge base `ensureBaseAvailable`
had just paid to build — in **6 of 7 agent phases per review**. Corpus: 9 of 50
real PRs fork further back than that; one is 6125 files two-dot against 3 at the
merge base. **Fixed** (check-then-repair, deepening both sides — unshallowing the
base alone leaves HEAD with no reachable ancestor, which recurred twice in
production). **The 8-case gate is structurally blind to this class**: `add-case`
pins `base_commit` to the *merge base*, so two-dot ≡ three-dot in every fixture
and a depth cut cannot sever a tip. Task #8.

**2. Any conservation result from before 2026-08-22 is void.** Hypothesis ids
collided across families — `contract.jsonl` and `security.jsonl` both emitted
`H-001..` — so covering five strings "accounted for" eight hypotheses and the
gate reported **0 uncovered, exit 0**. After the fix the same artifacts report
**2 of 30, exit 3**. Compounding it: only **8 of 30** hypotheses carried an `id`
at all, so 22 were structurally invisible to the gate.

**3. The globally-installed `lastlight-evals` silently runs the BASELINE.** It
carries the same version string as the working tree. `--overlay overlays/wp3`
completes happily, at baseline cost, with every analysis phase skipped, and
reports itself as the wp3 arm. **One agent call and ~$0.21 is the tell**;
eight-to-nine is a real pipeline case. Run from source (§5).

**4. The spec family was worse than inert.** With no obligations it did not
no-op — it fell back to generic analysis and emitted 7 hypotheses in the
**contract family's shape**, counted as coverage while duplicating another axis.
Fixed: both ends now come from core's own `resolveSpecContext` against the fake,
the fixtures carry real linked-issue bodies (generator-derived), and
`maxSpecObligations` went 6 → 40 because it had become the binding constraint on
five of six linked cases the moment the axis started working.

**5. Run A (`2026-08-22_123348`) cannot be compared against.** Its `post-review`
read the process-global config while every gated phase keyed off the run context,
so the attention boundary was **inert**: the split verdict stripped, every
`internal`-tier finding posted, no inline cap. Fixed in `321634ec`. Its two gold
matches sat at ranks **#7 and #19 of 20 posted** — under a working boundary a
19th-ranked finding would very plausibly never have been posted. **Both its
precision and its recall describe a deployment that does not exist.**

**6. A measurement must never overlap a rebuild of what it measures.** A 50-case
corpus run was invalidated when `dist/cli.js` landed mid-flight. **Contention
counts**: a `none` run that should take seconds recorded **1933 s** beside a full
test gate. Sequence them, or say which half of a contaminated measurement you are
standing on.

**7. `--never-fail` does not survive a hard crash.** It is an in-process
try/catch; an OOM or a native segfault exits 134 with no envelope. A phase that
fails hard writes no `assessedHeadShaByWorkflow`, and `cron-review.yaml`
re-dispatches every 30 minutes **forever**. Hence the shell-level `||` fallbacks
in `pr-review.yaml`. Do not simplify them away.

**8. The gold dataset is uncommitted and one keystroke from erasure.** On
2026-08-22 an agent ran `git checkout` on `instances.json` in
`~/work/nearform-evals` — a file with uncommitted work — destroying **5 of 8
cases, 25 gold findings down to 8**. It was recovered only because
`scripts/build-skillspro-cases.mjs` happened to exist, and verified against an
independently-recorded checksum. Backup:
`~/lastlight-prod-snapshots/instances-25gold-*.json`.

> **Checksum for that dataset: gold per case `3,5,0,4,3,5,4,1` = 25, across 8
> cases.** Verify it after anything that regenerates the fixtures.

**Never run `git checkout` / `restore` / `stash` / `reset` on a file without
first checking it for uncommitted work — and be deliberate about which repo you
are in.** Fixture data belongs in the **generator**, not hand-written into
`instances.json`: the linked-issue work was lost the first time precisely because
a regeneration silently dropped it.

## 5. Running an arm

Run from source, cwd in the eval workspace. Both matter: `LASTLIGHT_CORE_DIR`
must be `apps/server` (the monorepo root has no `workflows/`, and it fails at $0
with *"Workflow not found"*), and a cwd inside `apps/evals` finds no provider key
— the `.env` lives in the eval workspace.

```bash
cd ~/work/nearform-evals
LASTLIGHT_FACTS_BIN=~/work/lastlight/packages/code-facts/dist/cli.js \
  ~/work/lastlight/apps/evals/node_modules/.bin/tsx \
  ~/work/lastlight/apps/evals/src/run.ts run pr-review \
  --overlay overlays/wp3 --model anthropic/claude-haiku-4-5-20251001 \
  --limit 1 --keep-workspace
```

It prints `core → 0.27.0-dev (working tree)` when it is reading local source.
Add `--concurrency 4` for a full 8-case arm. Core is consumed as **built dist**,
so `pnpm --filter lastlight-core build` first, every time.

> **VERIFY THE ARM, DO NOT READ ITS LABEL.** Within the first minute the
> `--keep-workspace` path must hold `facts.json`, a populated `obligations.json`
> and per-family blocks under `obligations/`; by the end it must hold
> **`disposition.json`**, whose absence means the attention boundary never ran.
> Both checks are free and each one has caught a wasted arm.

The kept workspace is at
`<tmpdir>/sandboxes/<taskId>/<repo>/.lastlight/pr-review/` — note the two levels
of nesting; the artifacts are not at the workspace root.

**Every eval arm is human-authorised spend** ([HANDOFF.md](HANDOFF.md) §sign-off).
A sub-agent must never run one unprompted.

## 6. Driving sub-agents on this work

What produced results, worth reusing close to verbatim:

- **"A failing test is more likely a new bug than a bad assertion — investigate
  before you adjust."** Four of WP1b's seven bugs surfaced this way.
- **"Report anything in this brief you found to be wrong."** This repeatedly
  caught errors in the *brief*. On 2026-08-22 it corrected three load-bearing
  premises: the survey-time `git fetch` was an instruction and not a symptom;
  `seed` does not mint hypothesis ids (the survey models do, at runtime); and the
  eval-seed hypothesis for the dead spec axis was wrong.
- **"A measured *this does not work* is a successful outcome of this task."**
- **Hand them the measured numbers.** Agents made to rediscover context spend
  their budget on exploration.
- **Explicit, disjoint file ownership.** Six agents ran concurrently on
  2026-08-22 with no merge conflicts because each was given a directory.

**Disjoint files are not a disjoint contract.** The one real defect of that day
came from two agents whose files never overlapped: one wired a new `onPhaseEnd`
the eval had never passed, the other added a phase handler that did not fire it.
Result: six branch rows with no duration and **61% of the case cost
unattributed**, rendering as if the phases had been skipped. When parallel agents
touch **two ends of one contract**, name the contract in both briefs.

Two further cautions:

- **Never run a measurement agent concurrently with an agent that rebuilds what
  it measures** — including the full turbo gate, which is ~115s of CPU.
- **A repo can have more than one writer, and `git status` does not name them.**
  An agent was once killed for "scope creep" that belonged to a concurrent human
  session. Check a change against the files you actually gave it before acting.
