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

If `HEAD` is `c8530b83` (WP1) and the status count is large, **a full day of
WP1b work is uncommitted** and that is the first thing to fix. It splits into
these units — each carries a distinct *why*, so do not squash them into one:

```
fix(code-facts): diff the merge base, not the branch tip
fix(code-facts): canonicalType, stripImportPaths, @throws — three phantom-delta sources
feat(code-facts): one program per tsconfig the diff touches, with an allocated budget
feat(code-facts): enumerate from the git tree, honouring .gitignore
feat(code-facts): the language-agnostic layer — manifests, coverage formats, languages[]
fix(code-facts): rules/review.yaml was never valid YAML; 7 rules → 32 across five languages
feat(code-facts): selfcheck, the noise floor, and its sensitivity proofs
feat(code-facts): the syntactic engine and the name-match gate
feat(evals): the corpus harness, frozen anchors, and evidence coverage
docs(plan): WP1b — what measurement found, and the TypeScript-first reorder
```

## 1. Prove the tree is sane — three commands, ~2 minutes

```bash
cd ~/work/lastlight
pnpm turbo run typecheck test build            # expect 24/24 tasks, ~376 code-facts tests
pnpm --filter lastlight-code-facts selfcheck   # real-commit census; expect ~30 of 31 analysed, exit 0
cd ~/work/lastlight-evals && npx tsx scripts/facts-corpus.ts --profile smoke   # 8 cases
```

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
✅ the 2 GB agent-cap decision — SETTLED by measurement, not taken
             WP3  seed + six surveys
             WP4  prepare + falsify           ← also the only thing that makes `coverage` live
             WP6  adjudicate + 7a/7b
   ── ship-capable on TypeScript here ──
             WP1c Stage 2 grammars (scoped)   ← generality, not shipping
             WP9  external validation         ← deterministic half is now free
             [R]  release → WP7c
WP2 parallel · WP5 PARKED
```

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

## 4. Open backlog

Small, none blocking, all measured rather than suspected.

**The 2 GB cap is CLOSED — resolved 2026-08-21.** It was the one blocking item
and it is gone, so do not re-open it from a stale reading of
[HANDOFF.md](HANDOFF.md). It was never really a `--max-files` question:
`--max-files` bounds ts-morph's source-file count (**637** on a three-file diff
of this repo), while the `ts.Program` binds **9,647** files, **8,947 of them
under `node_modules`**. The fix is a `resolutionHost` that refuses bare
specifiers into `node_modules` against an allow-list computed from the changed
files' own imports — `--resolution changed`, which is being made the default,
with `full` kept as an escape hatch and `none` as an emergency. Measured: **1022
/ 1274 / 1600 / 1387 / 2157 MB** across five commits of an *installed* tree
where `full` costs **3699 / 3902 / 4347-OOM / 3481 / 4430**, at **zero
type-fidelity cost across 499 contract entries**. The full argument, including
why it is lossless *by construction* and why the sweep's wall-clock figures are
contaminated and must not be quoted, is in
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
  comes from git. Deferred: closing it needs a head worktree as well as the base
  one, 2× cost. Safe wherever the checkout is guaranteed at head.
- **Three load-sensitive tests** (`constants` ×2, `fail-loud` ×1) fail under CPU
  contention. Do not blanket-raise timeouts — that hides real slowdowns, which is
  the opposite of what this suite is for.
