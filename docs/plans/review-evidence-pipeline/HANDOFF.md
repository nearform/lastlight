# Execution protocol

How to run this plan as a series of sub-agent tasks. One work package per agent,
one at a time unless the dependency graph says otherwise.

> **Resuming after a break? [RESTART.md](RESTART.md) first** — it carries the
> tree state, the three commands that prove it is sane, the environment the
> measurements assume, and the sub-agent lessons (including the one mistake that
> cost a 50-case corpus run). This file is the protocol; that one is the entry
> point.

## Order and status

**Moved to [RESTART.md](RESTART.md) §2–3, 2026-08-22**, so there is one source of
truth for what is built. This file is the *protocol* — how to run an agent, what
it must never do, and what needs a human. It carries no status.

Two things from the old order block that are still policy, not status:

- **WP1c (Stage 2 grammars) is deliberately right of "ship-capable".** WP3's and
  WP4's gates are read on `skillspro`, which is TypeScript, where the facts
  already work. Grammars move the **Martian** corpus — 40 non-TypeScript cases of
  50 — so they buy the *generality claim*, which is
  [WP9](09-external-validation.md)'s job. Locked decision 14.
- **Cut, and staying cut:** `mutants`, `suite`, ablation rung 2b (§D13).

Every agent reads [10-design-review.md](10-design-review.md) and
[01b-code-facts-hardening.md](01b-code-facts-hardening.md) alongside their WP.
Where either contradicts a WP, it wins.

## Comparators — the old baseline is DEAD

**Rewritten 2026-08-22.** This section used to name
`2026-08-20_074355-8049410` (8/8 graded, $5.65, micro-recall 0.040) as the
comparator for every gate. **Do not use it, or anything else from before
2026-08-22.** Four independent changes moved what a run measures:

1. the conservation gate was passing falsely (colliding hypothesis ids);
2. the spec family was emitting contract-shaped hypotheses off-axis;
3. `post-review`'s attention boundary was inert on the `123348` run;
4. the `pr-review` skill was severing its own merge base.

[RESTART.md](RESTART.md) §4 has each in full. **The next arm is a
re-baseline, not a delta** — run `overlays/baseline` and `overlays/wp3` fresh,
8 cases each, and treat those as the new comparators.

**We are still deliberately not re-measuring candidates v1/v2/v3.** They are dead
ends — v1 moved train Δ ≈ 0.000, v2 was reverted and its machinery deleted, v3
was a regex prototype of what WP1 + WP3 build properly. What v3 remains is
**evidence for a design choice** ([00-evidence §3](00-evidence.md)), not a rung we
stand on.

## How to actually run a gate — do not use the global CLI

> **The command itself is [RESTART.md](RESTART.md) §5.** This section is the
> *why* — read it once, then use that command.

**Established 2026-08-21, while wiring up [WP8](08-evals.md).** Every gate in
this plan measures **unpublished** engine code, and the obvious way to run the
eval silently measures the *published* one instead.

`~/work/nearform-evals` runs the globally-installed `lastlight-evals@0.10.0`,
which bundles `lastlight-core@0.26.0` from npm. Its own investigation notes
record that the old `LASTLIGHT_CORE_DIR=~/work/lastlight` workaround is *"no
longer needed"* — true for measuring the shipped baseline, and **exactly wrong
for measuring this plan**. `LASTLIGHT_CORE_DIR` repoints only the **asset**
roots (`workflows/`, `skills/`, `prompts/`, `config/`); `bootstrap.ts` says so
explicitly, and *"the imported runner CODE still comes from
`node_modules/lastlight-core`"*. New phases, new context fields (`prBody`), a
changed `renderContext` — all engine code — would simply not exist in the run,
and the arm would report that the new pipeline did nothing.

**Version was not a discriminator, so we made it one.** Both cores reported
`0.26.0` — same string, different files. `lastlight-core` in the working tree is
therefore bumped to **`0.27.0-dev`** for the duration of this plan, so the
harness banner distinguishes them at the point of use:

```
lastlight-evals 0.10.0 (lastlight-core 0.27.0-dev)   ← working tree
lastlight-evals 0.10.0 (lastlight-core 0.26.0)       ← published
```

Roll it into the real version when the Release is cut.

So run the **workspace** harness, whose `node_modules/lastlight-core` is a
symlink to `apps/server` — but keep the cwd at `~/work/nearform-evals`, so
`.env`, `./evals/datasets` and `./eval-results` still resolve exactly as they did
for the baseline. Only the build behind the CLI changes:

```bash
# 1. Core is consumed as BUILT dist (`"./evals" → ./dist/evals-api.js`), so a
#    stale dist measures stale code. Build first, EVERY time — this is the trap
#    that survives every entry point below.
pnpm --filter lastlight-core build

# 2. Run from the evals workspace, with the monorepo's entry point.
cd ~/work/nearform-evals
npx tsx ~/work/lastlight/apps/evals/src/run.ts run pr-review \
  --overlay overlays/baseline --model anthropic/claude-sonnet-4-6
```

`tsx` runs the harness from source, so only core needs building. For the built
bin instead, `pnpm --filter lastlight-evals build` then
`node ~/work/lastlight/apps/evals/dist/run.js …`.

Use `EVAL_INSTANCE=<exact-id>` for the cheap single-case iteration unit (~$1–2.5)
and a full arm only for a gate (~$6–19).

**If you prefer the global `lastlight-evals` command**, link it — do not install
it. `npm i <dir>` and a packed tarball both have to resolve
`lastlight-core: workspace:*`: npm does not understand the `workspace:`
protocol, and `pnpm pack` rewrites it to a real version, which fetches core from
npm and reintroduces the bug this section exists to prevent. A link symlinks
rather than copies, so the workspace `node_modules` (and its core symlink) are
preserved. Remember to unlink afterwards — a globally-linked working tree that
outlives the measurement is its own silent trap.

**Two checks, one live and one after the fact.** The run logs `core → <version>
(working tree | published package) <path>` before it does anything. And every
scorecard now stamps `meta.core` with the same triple, so the question *"which
core produced this run?"* stays answerable weeks later — once `0.27.0` is
actually published, the version alone stops discriminating, and
`core.published: false` is what still says so. Same principle as §D3's toolchain
stamp: provenance is recorded, not remembered.

Note `meta.gitSha` does **not** answer this — it is the SHA of the *cwd's* repo,
which for these runs is `~/work/nearform-evals`, not the monorepo.

## Reaching production

A sandbox-image change **cannot** reach prod via an overlay push. Per
`docs/RELEASING.md`: `lastlight server update` *pulls* GHCR images and only a
**GitHub Release** builds them. The sequence is: cut a Release → bump
`deploy.version` in `nearform/lastlight-nearform` → push (the overlay's
auto-deploy Action runs `server update` on the host).

For iteration, `server update --local` builds from source on the host, and the
eval harness runs whatever images it is pointed at — so local builds cover every
measurement in this plan.

**Also a human decision.**

## Sub-agent brief template

Every agent gets this preamble. Fill in the WP.

> You are implementing **WP<N>** of the PR-review evidence pipeline in the
> `nearform/lastlight` monorepo.
>
> **Read first, in this order:**
> 1. `docs/plans/review-evidence-pipeline/README.md` — the locked decisions.
>    Four were decided against the obvious answer; do not quietly re-decide them.
> 2. `docs/plans/review-evidence-pipeline/10-design-review.md` — thirteen
>    decisions taken before implementation, and **four corrections to claims the
>    work packages assert as fact**. Where it contradicts a WP, it wins.
> 3. `docs/plans/review-evidence-pipeline/00-evidence.md` — what is already
>    falsified. §6 is a do-not-re-litigate list.
> 4. `docs/plans/review-evidence-pipeline/<NN>-<name>.md` — your work package.
> 5. The `CLAUDE.md` closest to the files you will touch.
>
> **Scope.** Implement only your work package. Its "Non-goals" section is
> binding — those items belong to other agents and doing them here creates merge
> conflicts and muddies attribution.
>
> **Stop and ask** rather than guessing if: a locked decision appears wrong; the
> work needs a schema change not described in your WP; you need to spend money on
> model calls; or an acceptance criterion cannot be met.
>
> **Finish with**: `pnpm turbo run typecheck test build` green from the repo
> root, and a summary naming which acceptance criteria you verified and how.

## Rules every agent must follow

These are house rules that a fresh agent will otherwise violate. They are not
optional.

| Rule | Why |
|---|---|
| **Never `console.*` in runtime code.** `lastlight-core`: `logger("component")`. `workflow-engine`/`shared`: the injected `LoggerPort` (they are pino-free — the CLI depends on them). The `lastlight` CLI is the one place `console.*` is correct | Root `CLAUDE.md` — all operational output is structured JSON on stderr |
| **A state-schema change means editing BOTH `schema/sqlite.ts` and `schema/pg.ts`, regenerating BOTH dialects, and never `drizzle-kit push`** | `apps/server/src/state/CLAUDE.md`. A parity test and a PGlite leg enforce it |
| **Nothing under `src/` may import `schema/pg.ts`** except `pg-client.ts` | Pinned by `tests/state/driver-isolation.test.ts` |
| **No import edge from `shared`/`workflow-engine` back to `core`; the CLI never gains an edge to `core`** | `scripts/lint-import-boundaries.mjs`, runs in `typecheck`. It replaced dependency-cruiser, which exited 0 on TS≥7 while seeing nothing |
| **Run the `docs-sync` skill** before committing changes to `workflows/`, `skills/`, `config/default.yaml`, `src/state`, `src/config/` | There is a pre-commit hook, and the `apps/server/spec/` pages are rebuild-grade |
| **Do not hard-wrap Markdown in GitHub issues or PR bodies** — one line per paragraph. In-repo docs under `docs/` already wrap; match the file you are editing | Rendered Markdown re-wraps; hard wraps look broken |
| **`AGENTS.md` files are thin pointers to the co-located `CLAUDE.md`.** Never duplicate content into them | Root `CLAUDE.md` |
| **Version bumps:** `pnpm --filter <name> exec npm version …`. A bare `pnpm --filter … version` bumps nothing | It is read as a missing script and exits quietly |

## Known traps

Each of these has already cost someone a debugging session. **These are the
code-level ones.** The traps that waste *money* — silently measuring the wrong
thing — are [RESTART.md](RESTART.md) §4, and an agent about to run or read an
eval must read that instead of this.

- **A tool that exits 0 on a parse failure is worse than no tool.**
  dependency-cruiser refused to parse TS≥7 and exited 0 anyway, so the
  import-boundary gate was green while seeing nothing. Every extractor in
  [WP1](01-code-facts.md) must fail loud.
- ~~**TypeScript 7 has no programmatic compiler API.**~~ **Expired 2026-08-22 —
  superseded by [`docs/plans/fact-engine/`](../fact-engine/README.md).**
  `typescript@7.0.2` ships `exports["./unstable/sync"]`, and it is already in
  this workspace. The second half of the trap still stands: **never resolve
  `typescript` from the repo under review** — the engine must be pinned by this
  package, whichever engine it is.
- **A phase skipped on resume contributes nothing to `outputs`.** Hand large
  context between phases through **workspace files**, never
  `{{phaseOutputs.X.output}}` across a resume boundary
  (`src/workflows/CLAUDE.md`).
- **`skip_if` on `.contains()` against a whole agent output is a substring match**
  that matches prose and replayed journal lines, and is empty across a resume
  boundary — so it fails open on exactly the verdicts it guards. Read a parsed
  value out of `scratch` instead.
- **A correct "nothing to do" must not paint the run red.** A red run posts
  `messages.on_failure`, offers a Retry that cannot succeed, pollutes cost stats
  and defeats the SHA dedup.
- **A failed run is re-dispatched every 30 minutes, forever.** `cron-review.yaml`
  is `*/30 * * * *`, and `assessedHeadShaByWorkflow` — the only thing that stops
  the loop — is populated **from succeeded runs only** (`pr-decisions.ts:918`,
  which documents the 1260-execution / $1.30-an-hour incident). This plan turns
  one model phase into eight, so **no analysis phase may fail the run**: `facts`
  exit 2 writes `coverage: "none"` and returns 0, survey phases carry
  `on_soft_failure: { retries: 1, then: complete }`, and the adjudicate gate has
  a floor. "Fail loud" means loud *in the artifact*. See §D12.
- **`--never-fail` does not survive a hard crash, and §D12 depends on it.**
  Measured on landing WP1: an *ordinary* failure (not a git repo) exits **0** and
  writes the `coverage: "none"` envelope, exactly as designed. But `--never-fail`
  is an **in-process try/catch**, so an OOM — reachable today by raising
  `--max-files` on a large monorepo, and by any segfault in the `@ast-grep/napi`
  native binary — kills V8 before the catch runs: **exit 134, no envelope**. That
  is precisely the shape §D12 exists to prevent: the phase fails, the run fails,
  `assessedHeadShaByWorkflow` is not written (SUCCEEDED runs only), and
  `cron-review.yaml` re-dispatches every 30 minutes forever at 2–3× the cost of
  the $1.30/hour incident. **So [WP3](03-seed-and-survey.md)'s phase must do the
  catching in the SHELL** — `lastlight-facts all … || <write a fallback
  envelope>` — rather than trusting the flag. A wrapper inside the crashing
  process cannot be the guarantee. The default 6000-file ceiling degrades
  gracefully and is what keeps this off the normal path; do not raise it without
  the shell-level catch in place.
- **Every diff is against the MERGE BASE, never the base branch's tip.**
  `base...head`, which is what GitHub's "Files changed" tab shows. Two-dot
  additionally contains every commit that landed on the base *branch* since the
  PR forked, and the author wrote none of it. **This is a production shape, not
  a dataset artefact** — the workflow reads `pull_request.base.sha`, the tip at
  event time. The codebase was already **inconsistent with itself**:
  `post-review.ts:415-455` did three-dot with an unshallow retry while
  `code-facts` did two-dot. Measured, `sentry-greptile-1` is **6125 files
  two-dot against 3 at the merge base** — one case that was simultaneously the
  50-PR corpus's entire over-90 s count (157.9 s), its 2.7 GB RSS ceiling, 68 of
  its 72 constants and 96 of its 102 dependency changes. **Before adding any new
  git-range consumer, grep for the other ones and make them agree.**
- **A green suite proves nothing about an argument list no shipped code ever
  passes.** `tests/rules.test.ts` invoked opengrep with `--no-rewrite-rule-ids`
  by hand; production never did. The suite was green against a configuration
  that did not exist anywhere else, while the shipped path had **never parsed
  the ruleset at all**. When a test constructs the tool's arguments, assert that
  the *production* argument builder is the thing under test — or the test is
  measuring a machine nobody runs.
- **A measurement must never overlap a rebuild of what it measures**, and
  **contention counts as overlap**. Full statement in
  [RESTART.md](RESTART.md) §4 trap 6. The code-level guard, if you must run them
  together: `stat` `dist/cli.js` before and after and confirm every artifact's
  mtime falls inside that window. Same principle as `meta.core` on an eval
  scorecard — provenance is recorded, not remembered.
- **A sub-agent that blocks on a long measurement gets killed by the stream
  watchdog.** *Added 2026-08-21 — two agents died this way in one day.* No output
  for **600 s** ends the agent, and a 50-run memory sweep produces nothing to say
  for far longer than that. Waiting is not the unit of work an agent is good for.
  Put the sweep in a **script that emits one line of progress per step**, start it
  detached (`nohup`), and drive it from the main loop — polling a foreground run
  from inside an agent burns cycles restarting and still dies. This is the same
  lesson as [RESTART.md](RESTART.md) §3's "start long measurements detached",
  arrived at from the other direction: the agent is the wrong place for the
  *waiting*, not just the wrong place for the *running*.
- **Evals:** `bootstrapAssets()` must run before any `getWorkflow`/`runWorkflow`,
  and `drainSessions()` before `collectMetrics()` — otherwise cost silently
  reports 0.
- **Evals:** do not measure against `./instance` in `~/work/nearform-evals`. It
  is the wrong deployment (gpt-5.1, forked skills). Use `overlays/baseline`.
- **`appendPhase` and `mergeScratch` are unguarded read-modify-write today** and
  bypass the op serializer. [WP5](05-parallel-phases.md)'s **S2**, and a latent
  bug under the run-level concurrency we already ship. Still outstanding — the
  fan-out did not touch it. Its sibling **S3** is also still live:
  `serviceContainerName(taskId, name)` has no phase component, so one phase's
  `dispose()` kills another's service containers.
- **A fan-out phase is one node with many sessions, and consumers must not
  assume otherwise.** *Added 2026-08-22.* Rows sharing a `<phase>_branch_<name>`
  parent ran **concurrently**: their durations must be combined with `max`, not
  `sum`. Six branches sum to ~708s across ~234s of real time — a ~3×
  overstatement for anything that adds them.

## What needs human sign-off

Never done by a sub-agent unprompted:

1. **Spending on model calls** — every full eval arm (~$6–19 each).
2. **Editing the gold answers** in `~/work/nearform-evals/evals/datasets/`. The
   eval-loop skill requires human sign-off here and it is the one defence against
   writing a skill to the answer.

   **That file is also uncommitted and one keystroke from erasure.** On
   2026-08-22 an agent ran `git checkout` on `instances.json` to undo a
   formatting mistake, without checking it for uncommitted work, and destroyed
   **5 of 8 cases — 25 gold findings down to 8**. It survived only because
   `scripts/build-skillspro-cases.mjs` happened to exist. **No agent runs
   `git checkout` / `restore` / `stash` / `reset` on a file it has not checked,
   ever — and least of all in a repo other than the one it was asked to work
   in.** Checksum for that dataset: gold per case `3,5,0,4,3,5,4,1` = **25**
   across 8 cases; verify it after anything that regenerates fixtures. Backup at
   `~/lastlight-prod-snapshots/instances-25gold-*.json`.

   Corollary: **fixture data belongs in the generator, not hand-written into
   `instances.json`.** The linked-issue fixtures were lost once precisely because
   a regeneration silently dropped hand-written data.
3. **Reading the held-out split** while iterating. Consume it once per round, at
   the gate.
4. **Cutting a Release** or enabling `review.analysis` on a live deployment.
5. **Any change to `review.trigger` policy** — `resolveReviewTrigger` is the one
   implementation on every route and carries a locked product decision (#212).
6. **Curating a tier-2 validation repo** ([WP9](09-external-validation.md)) —
   same reasoning as gold edits.
7. **Any external claim about review quality** before WP9 has run. The eight-case
   set is a development instrument, not evidence of generality.
8. **Adding `lastlight-code-facts` as a trusted publisher on npmjs.com**, before
   the first Release that includes it. WP1 shipped it **published** rather than
   `private: true` as the WP specified: `pnpm pack` rewrites `workspace:*` to a
   concrete version, so a published `lastlight` CLI cannot depend on an
   unpublished package. It is wired into `publish.yml` ahead of `lastlight`, but
   OIDC trusted publishing needs a **one-time human entry per package** — without
   it that single package 404s and takes the Release with it. This is the first
   new published package since the monorepo consolidation, so nothing else in the
   pipeline has ever exercised the path.
9. ~~**The 2 GB agent-cap decision**~~ — **DISCHARGED 2026-08-21 by
   measurement, then RETIRED 2026-08-22 by the operator**, who raised
   `SANDBOX_MEMORY_LIMIT` to **8g** rather than keep paying to fit 2 GB. Both
   halves matter and they say different things. The original item asked a human
   to choose between three levers: lower `--max-files` (`sentry-greptile-5` is
   **2.14 GB with identical output at `--max-files 3000`**), raise the cap, or
   accept the OOM path. Measurement found a fourth that dominates all three —
   and then the corpus showed the fourth was not sufficient either: on **bare**
   trees `grafana-106778` peaks at **2449 MB off a fourteen-file diff**, so the
   cost tracks *repo* size through `--max-files` and no diff-scoped lever
   reaches it. Lever two was the honest answer, and it was taken.
   `--max-files` bounds **ts-morph's** source-file count — 637 on a three-file
   diff of this repo — while the `ts.Program` binds **9,647** files, **8,947 of
   them under `node_modules`**; peak RSS follows the second number. A
   `resolutionHost` with an allow-list of the specifiers the changed files import
   (`--resolution changed`) fits the cap at **zero type-fidelity cost across 499
   contract entries**, and is being made the default. See
   [01b-code-facts-hardening.md](01b-code-facts-hardening.md) → "Where the memory
   actually goes". **What still stands is `tests/oom.test.ts`'s point**: whatever
   the tier, an OOM exits 134 with no envelope and the wrapper cannot save you,
   so §D12's shell-level catch stays the guarantee.
10. **Installing `opengrep` and `gitleaks` on any measuring host** — *added
    2026-08-21.* Neither is installable from npm (§D2: the `opengrep` npm name is
    a 145-byte empty stub, the `gitleaks` name is an unrelated package), so a
    machine without them measures the `security` family with its `patterns` half
    missing, and [WP8](08-evals.md) must label that **"not measured"** and never
    "did not convert". `lastlight-facts toolchain` prints the per-platform
    install commands from `toolchain.json`. This is not optional busywork: the
    ruleset had **never been valid YAML** and nobody found out for a release,
    precisely because no machine that ran the suite had the binary.

## Definition of done, per work package

A WP is done when:

- every acceptance criterion in its file is verified, and the agent says **how**;
- `pnpm turbo run typecheck test build` is green from the repo root;
- the feature is **inert by default** (`review.analysis.enabled: false` still
  reproduces today's review byte-for-byte);
- new behaviour has a test that would fail without it;
- its measurement gate has been read on the eval, or the agent states explicitly
  that it was not run and why.

**A WP that improves a number without a measurement is not done.** That is the
mistake candidate v1 made — four changes shipped as one, train Δ ≈ 0.000, and a
`diff-runs` verdict that turned out to be wrong because an incomplete run had
silently changed the split denominator.

## Open questions — the honest backlog

**Moved to [RESTART.md](RESTART.md) §3d, 2026-08-22.** It is status, and status
lives in one place. The 2 GB agent-cap item that used to head this section is
**retired** — the operator raised `SANDBOX_MEMORY_LIMIT` to 8g, and every memory
number that motivated it was `ts-morph`'s, an engine this plan no longer uses.
Do not re-open it from a stale reading; the current engine's memory is
**unmeasured**, because the compiler is a child process.
