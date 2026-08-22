# RESTART — pick this plan up in a new session

Say *"restart the plan in `docs/plans/review-evidence-pipeline/`"* and start
here. This file is the operational entry point: what state the tree is in, what
to run to prove it is sane, what is next, and how to drive sub-agents on it
without repeating a mistake that has already been made once.

For *why* any of it is shaped this way, read [README.md](README.md) (thesis +
locked decisions), then [HANDOFF.md](HANDOFF.md) (traps + human sign-off), then
[01b-code-facts-hardening.md](01b-code-facts-hardening.md) (what measurement
found, and why several earlier claims in this plan are now marked corrected).

## 0. Before anything else — is the work committed?

```bash
git -C ~/work/lastlight log --oneline -1
git -C ~/work/lastlight status --porcelain | wc -l
```

**As of 2026-08-22 everything through the engine swap is committed** — WP1b in
five commits ending `948e25d1`, then `7602ef47` (the tsgo seam) and `5a79f2da`
(ts-morph removed). If `HEAD` is one of those and the tree is clean, skip to §1.

If `HEAD` is `c8530b83` (WP1) and the status count is large, you are on an older
checkout and a full day of WP1b work is uncommitted; the units it splits into
are in the git log of this branch.

## 1. Prove the tree is sane — three commands, ~2 minutes

```bash
cd ~/work/lastlight
pnpm turbo run typecheck test build            # expect 24/24 tasks, 417 code-facts tests
pnpm --filter lastlight-code-facts selfcheck   # real-commit census; expect 31 of 31 analysed, exit 0
cd ~/work/lastlight/apps/evals && npx tsx scripts/facts-corpus.ts --profile smoke \
  --dataset ~/work/lastlight-evals/datasets/pr-review/instances.json \
  --cache   ~/work/lastlight-evals/.eval-cache                      # 8 cases
```

The corpus scripts live in **`apps/evals/`** (this monorepo) while the 5.9 GB of
bare mirrors and the gitignored `instances.json` still live in the standalone
`~/work/lastlight-evals` checkout, hence the two flags. `lastlight-core#test`
has flaked twice under parallel load and passed standalone both times — see the
load-sensitive tests in §4 before concluding a red gate means a real break.

`selfcheck` is the fastest honest signal: it runs `all` against a real commit of
this repo and exits non-zero on a `removed` delta with no deletion in the diff,
on too many phantom-capable deltas, or past 90 s. It is deliberately **not** in
CI — `actions/checkout` defaults to `fetch-depth: 1`, so `HEAD~1` does not exist
on a runner.

**Environment the measurements assume.** `opengrep` 1.27.1 and `gitleaks` 8.21.2
must be on `PATH` (see HANDOFF sign-off item 10) or the whole `patterns` family
is stamped `missing` and silently contributes nothing. `lastlight-facts
toolchain` prints what actually resolved. The 50-PR corpus needs the bare
mirrors under `~/work/lastlight-evals/.eval-cache/repos/` (~4.9 GB) and the
gitignored `datasets/pr-review/instances.json`; regenerate with
`scripts/import-martian.ts` rather than assuming they are present.

## 2. What is next

The decision recorded as locked decision #14 is **TypeScript-first**: prove the
pipeline helps on TypeScript before buying polyglot. WP3's and WP4's gates are
read on the `skillspro` set, which is TypeScript; grammars move the *Martian*
corpus, so they raise the generality claim rather than the shipping path.

```
✅ the 2 GB agent-cap decision — RETIRED. cap raised to 8g, not engineered around
✅ the FACT ENGINE          — ts-morph replaced by the TS 7 API (docs/plans/fact-engine/)
             WP3  seed + six surveys          ← YOU ARE HERE. first model spend
             WP4  prepare + falsify           ← also the only thing that makes `coverage` live
             WP6  adjudicate + 7a/7b
   ── ship-capable on TypeScript here ──
             WP1c Stage 2 grammars (scoped)   ← generality, not shipping
             WP9  external validation         ← deterministic half is now free
             [R]  release → WP7c
WP2 parallel · WP5 PARKED
```

### The engine swap — 2026-08-22, after WP1b and before WP3

`packages/code-facts` no longer uses `ts-morph`. The type-aware tier runs on
`typescript@7.0.2`'s `unstable/sync` API (the Go compiler). The full argument,
the gates and the module-by-module end state are in
[`docs/plans/fact-engine/`](../fact-engine/README.md); what a WP3 reader needs:

- **Fidelity was the gate, and it held.** Entity sets compared as SETS on this
  repo's `HEAD~1..HEAD`: `facts` 44 = 44 symbols, 138 = 138 reference sites,
  contract keys 13 = 13, `consumersOutsideDiff` 32 = 32. Speed 3.2x (`facts`)
  and 2.6x (`contracts`); 9.6x / 6.9x against the old `--resolution full`.
- **Mechanisms deleted, not merely made faster.** `--resolution` entire,
  `--max-projects`, the cross-project file budget, `selectNeighbourhood`,
  `globCandidates`, and the second worktree for the base side. `project.ts`
  1252 → 296 lines. If a doc in THIS folder still reasons about a file budget
  or a resolution tier, it is describing something that no longer exists.
- **Bug 4 is fixed at the root**: a file under no tsconfig gets an inferred
  project with a working checker. On a real commit, 30 of 31 → **31 of 31**.
- **`--max-files` SURVIVES**, but it now means the ceiling on the repo-wide
  literal scan and the tier-2 name index (`DEFAULT_MAX_SCANNED_FILES` in
  `syntactic.ts`), never a compiler budget. It still backs the "an absence claim
  over a truncated file set is unsound" guard.
- **Envelope is `version: 2`**; `engine` is `["tsgo","ast-grep","none"]`. Safe
  only because `code-facts` still has **zero call sites in `apps/server`** —
  WP3 is what ends that, so schema changes get expensive from here.

**Two open items WP3 inherits.** Neither blocks it; both are the silent kind.

1. **Memory is UNMEASURED for the new engine, and the old figures do not
   transfer.** Any `process.memoryUsage.rss()` reading now excludes the compiler,
   which is a child process. Child-inclusive it is roughly 600 MB per open
   snapshot plus 200 MB of node. Do not quote this plan's older peak-RSS numbers
   against the current engine — they are ts-morph's.
2. **The base view diverges from the old one when the working tree is dirty.**
   The overlay serves base blobs for CHANGED files and falls through to the real
   filesystem for everything else; the old worktree served base blobs for
   everything. They agree exactly when the checkout is clean at head. Measured:
   a `languageBreakdown` delta the worktree reported and the overlay did not,
   because `schema.ts` was modified in the tree but absent from the changed set.
   This widens the caveat already in §4 below and wants a loud `degraded[]`
   entry on a dirty tree.

**Two bugs the swap surfaced, both fixed or pinned.** `.es6` panics the compiler
child and takes the whole snapshot with it, so it is kept analysable for
ast-grep and never handed to the compiler. And an unexecutable compiler binary
**wedges** rather than crashes — `spawnSync` had not returned after 50 s against
a 60 s timeout — which is worse than an OOM for a workflow phase, because it
burns the budget and fails anyway. Narrowed by a pre-flight, **not closed**;
§D12's shell-level catch stays mandatory.

**One thing to know before running `selfcheck` on your own work-in-progress:**
`facts`/`contracts` read head from the filesystem, so on a dirty tree the
default `HEAD~1..HEAD` invocation compares old blobs to new files and is
meaningless. Run it against a clean clone, or a `git stash create` snapshot.

Two gates are now available that this plan did not originally have, both free of
model spend, so use them *before* burning budget on a rung:

- **`pnpm selfcheck`** — does the substrate still behave on a real commit?
- **evidence coverage** (`apps/evals/scripts/facts-evidence.ts`) — an upper bound
  on recall attributable to code-facts as a seeder. If the envelope never names
  the identifier, no seeder can produce an obligation about it. Always read it
  with all three denominators and the candidate pool beside it; see
  [08-evals.md](08-evals.md).

## 3. Driving sub-agents on this work

What produced results today, worth reusing close to verbatim:

- **"A failing test is more likely a new bug than a bad assertion — investigate
  before you adjust."** Four of WP1b's seven bugs surfaced exactly this way.
- **"Report anything in this brief you found to be wrong."** This repeatedly
  caught errors in the *brief*: opengrep was available on darwin after all, the
  grammar weight was 90 % waste, one bug had already been fixed, one field was
  mis-specified. Agents that were not asked this quietly worked around bad
  premises instead.
- **"A measured *this does not work* is a successful outcome of this task."**
  The name-match gate came back with a conditional yes and three specific
  constraints rather than a rubber stamp.
- **Hand them the measured numbers.** Agents made to rediscover context spend
  their budget on exploration; agents given the numbers go straight to work.
- **Explicit, disjoint file ownership** — *"you own `src/project.ts`; another
  agent owns `rules/`"*. Two agents editing one file early on cost a merge.

The mistake, so it is not repeated: **never run a measurement agent concurrently
with an agent that rebuilds what it measures.** A corpus run was invalidated
when `dist/cli.js` was rebuilt mid-flight; 50 cases were thrown away. The guard
now in the briefs is to `stat` the binary before and after and confirm every
case artifact's mtime falls inside the run window — but the simpler rule is to
sequence them. Relatedly, start long measurements detached (`nohup`); an agent
that polls a foreground run stops and restarts repeatedly and wastes cycles.

The second mistake, 2026-08-22: **an agent was killed mid-task for "scope creep"
that was not its doing.** Files well outside its brief were changing inside its
working window — a different work package entirely — and the obvious inference
was drift. They belonged to a concurrent human session in the same checkout. The
agent was in its lane, and the kill cost a half-finished `run.ts` rewire. So:
**a repo can have more than one writer, and `git status` does not name them.**
Before attributing a change to an agent, check it against the files you actually
gave it; if the two do not overlap, ask before you act. Note also that a stopped
agent could not be resumed in that session, which makes the cost of a wrong kill
the whole remaining task.

## 4. Open backlog

Small, none blocking, all measured rather than suspected.

**The 2 GB cap is RETIRED — the operator raised it 2026-08-22.**
`SANDBOX_MEMORY_LIMIT` defaults to **8g** now. Do not re-open the cap from a
stale reading of [HANDOFF.md](HANDOFF.md), and do not spend another hour
shrinking the tool to fit a number that no longer exists. What forced the
raise: **the "0.8–1.3 GB" figure was about this monorepo, not about real
repos.** On bare corpus trees `grafana-106778` peaks at **2449 MB off a
fourteen-file diff** and `sentry-greptile-5` at **2988 MB**, so the cost tracks
*repo* size through `--max-files`, and the only way to hold 2 GB was to go
blind again. > **All of that is now HISTORY, twice over.** `--resolution` does not exist —
> the engine swap (§2) deleted it along with the file budget it was rationing.
> Every number in this section is **ts-morph's**, and none of it transfers to
> the current engine, whose memory is UNMEASURED because the compiler is a child
> process. Kept because the *shape* is the lesson and the shape repeats: a knob
> can bound the wrong population entirely while looking like the relevant one.

The analysis, as it stood: `--max-files` bounded ts-morph's source-file count
(**637** on a three-file diff of this repo), while the `ts.Program` bound
**9,647** files, **8,947 of them under `node_modules`** — so the knob everyone
reasoned about was not the term that dominated. The fix was a `resolutionHost`
refusing bare specifiers into `node_modules` against an allow-list computed from
the changed files' own imports (`--resolution changed`, made the default):
**1022 / 1274 / 1600 / 1387 / 2157 MB** across five commits of an *installed*
tree where `full` cost **3699 / 3902 / 4347-OOM / 3481 / 4430**, at **zero
type-fidelity cost across 499 contract entries**. The full argument — including
why it was lossless *by construction*, and why that sweep's wall-clock figures
are contaminated and must never be quoted — is in
[01b-code-facts-hardening.md](01b-code-facts-hardening.md) → "Where the memory
actually goes".

Still open:

- **Fingerprint collisions.** 13 corpus findings yield 11 distinct fingerprints;
  two same-line matches at `topic.rb:382` cannot be separated by a 3-line
  context window, so a dedup consumer silently drops one.
- **`patterns` scopes to changed *files*, not *hunks*** — deliberate (evidence,
  not findings), but it means some hits are pre-existing code in a touched file.
  An `inChangedHunk` flag would let the seeder rank without the extractor
  filtering.
- **`facts`/`contracts` read head from the filesystem** while the changed set
  comes from git — and the engine swap **widened this**, so re-read it before
  assuming the old note still applies. The base side is now a virtual-FS overlay
  that serves base blobs for CHANGED files and falls through to the real
  filesystem for everything else; the old worktree served base blobs for
  everything. The two agree exactly when the checkout is clean at head. On a
  dirty tree they diverge silently — measured: a `languageBreakdown` contract
  delta the worktree reported and the overlay did not, because `schema.ts` was
  modified in the working tree but absent from the changed set. The old
  "2× cost" reason for deferring is void (there is no second worktree to double),
  so the cheap fix is now a loud `degraded[]` entry when the tree is dirty rather
  than a silent substitution. **Practical consequence: `pnpm selfcheck` on your
  own work-in-progress compares old blobs to new files and is meaningless — run
  it against a clean clone or a `git stash create` snapshot.**
- **Load-sensitive tests fail under CPU contention**, in two packages. In
  `code-facts` it was three (`constants` ×2, `fail-loud` ×1). In `lastlight-core`
  it is unidentified: `lastlight-core#test` failed under `turbo` twice on
  2026-08-22, both times immediately after parallel sub-agent load, and passed
  standalone on re-run both times — the failing name was not captured because a
  passing re-run overwrites `.turbo/turbo-test.log`. **If you hit it, capture the
  log before re-running.** Do not blanket-raise timeouts — that hides real
  slowdowns, which is the opposite of what this suite is for.
