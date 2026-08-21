# Execution protocol

How to run this plan as a series of sub-agent tasks. One work package per agent,
one at a time unless the dependency graph says otherwise.

## Order

**Revised 2026-08-21** — see [10-design-review.md](10-design-review.md), which
every agent must read alongside their WP. Where it contradicts a WP, it wins.

```
  WP8  the instrument                   offline, no spend; write the DETECTION FLOOR down
   │
  WP0  spec axis + split verdict        ← NEW (§D7). rung 0.5, no infrastructure
   │                                      first model spend
  WP1  code-facts (ships in the CLI)    + coverage in place of mutants (§D13)
   │
  WP3  seed + SIX survey phases         gate: MECHANISM metrics, not recall (§D6)
   │
  WP4  prepare + falsify                gate: mechanism metrics + the latency number
   │
  WP6  adjudicate  +  7a/7b record      gate: recall flat-or-up, SNR reported
   │                 (ungated, §D10)
  WP9  external validation              MANDATORY before any general claim
   │                                    (freeze the architecture; do not tune on it)
  [R] release + overlay enable          ← human decision required
   │
  WP7c review-memory mining             needs the history 7a/7b accumulated

  WP2  sandbox image                    parallel; any time before the Release (§D1)
  WP5  parallel phases                  PARKED (§D5) — S2 and S3 land now regardless
```

**Cut:** `mutants`, `suite`, ablation rung 2b (§D13).

**WP5 is not on the critical path.** It buys latency and observability, not
recall. Its sub-package 5a contains two real bug fixes under today's run-level
concurrency and can land at any time.

## The baseline already exists — no measurement run before code

The comparator for every gate in this plan is the **shipped `pr-review`**, and it
has already been measured: `~/work/nearform-evals/eval-results/pr-review/2026-08-20_074355-8049410/`
— 8/8 graded, $5.65. Its scorecard stores `posted` / `gold` / `matched` per case,
which recompute to exactly the published headline:

```
TOTAL posted=2  gold=25  matched=1   →  micro-recall 0.040
```

So [WP8](08-evals.md)'s new metrics — micro-recall, SNR, per-family attribution —
**back-fill onto the existing baseline offline, with zero model spend**. That is
WP8's first task, and it is why WP8 runs first.

**We are deliberately not re-measuring candidates v1/v2/v3.** They are dead ends:
v1 moved train Δ ≈ 0.000, v2 was reverted and its machinery deleted, and v3 is a
regex prototype of the mechanism [WP1](01-code-facts.md) + [WP3](03-seed-and-survey.md)
build properly. An arm number for v3 would describe a machine we are deleting,
and it would cost ~$15–19 to learn it. Every gate here compares the **new
implementation against the shipped baseline** — a cleaner comparison than
prototype-vs-new anyway.

What v3 remains is **evidence for a design choice** ([00-evidence §3](00-evidence.md)),
not a rung we stand on. Its hypothesis — mechanical seeding at question
granularity — is validated at arm scale by WP3's own gate, using the real
implementation.

**The first model spend in this plan is the WP3 gate.** Everything before it is
offline.

## How to actually run a gate — do not use the global CLI

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

So **run the harness from the monorepo**, where `apps/evals/node_modules/
lastlight-core` is a workspace symlink to `apps/server` and both the assets and
the code are the working tree:

```bash
# 1. Core is consumed as BUILT dist (`"./evals" → ./dist/evals-api.js`), so a
#    stale dist measures stale code. Build first, every time.
pnpm --filter lastlight-core build

# 2. Run from apps/evals, pointing at the nearform-evals datasets + overlay, and
#    write the scorecard beside the baseline so diff-runs.ts can reach both.
cd apps/evals
set -a; . ~/work/nearform-evals/.env; set +a       # ANTHROPIC_API_KEY et al
LASTLIGHT_EVALS_OUT=~/work/nearform-evals/eval-results \
npx tsx src/run.ts run pr-review \
  --datasets ~/work/nearform-evals/evals/datasets \
  --overlay  ~/work/nearform-evals/overlays/baseline \
  --model anthropic/claude-sonnet-4-6
```

`--overlay` wires the asset overlay *and* the dataset overlay from one flag;
`LASTLIGHT_EVALS_OUT` overrides the cwd-relative `eval-results/` default. Use
`EVAL_INSTANCE=<exact-id>` for the cheap single-case iteration unit (~$1–2.5)
and a full arm only for a gate (~$6–19).

**The confirming check, before trusting any arm:** the scorecard's `meta.gitSha`
is the monorepo working-tree SHA. If a gate's scorecard carries `8049410` — the
`nearform-evals` SHA the baseline runs carry — it was produced by the global CLI
against published core, and it measures nothing this plan built.

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

Each of these has already cost someone a debugging session.

- **A tool that exits 0 on a parse failure is worse than no tool.**
  dependency-cruiser refused to parse TS≥7 and exited 0 anyway, so the
  import-boundary gate was green while seeing nothing. Every extractor in
  [WP1](01-code-facts.md) must fail loud.
- **TypeScript 7 has no programmatic compiler API.** `ts-morph@28` vendors its
  own; never resolve `typescript` from the repo under review.
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
- **Evals:** `bootstrapAssets()` must run before any `getWorkflow`/`runWorkflow`,
  and `drainSessions()` before `collectMetrics()` — otherwise cost silently
  reports 0.
- **Evals:** do not measure against `./instance` in `~/work/nearform-evals`. It
  is the wrong deployment (gpt-5.1, forked skills). Use `overlays/baseline`.
- **`appendPhase` and `mergeScratch` are unguarded read-modify-write today** and
  bypass the op serializer. Relevant to [WP5](05-parallel-phases.md), and a
  latent bug under the run-level concurrency we already ship.

## What needs human sign-off

Never done by a sub-agent unprompted:

1. **Spending on model calls** — every full eval arm (~$6–19 each).
2. **Editing the gold answers** in `~/work/nearform-evals/evals/datasets/`. The
   eval-loop skill requires human sign-off here and it is the one defence against
   writing a skill to the answer.
3. **Reading the held-out split** while iterating. Consume it once per round, at
   the gate.
4. **Cutting a Release** or enabling `review.analysis` on a live deployment.
5. **Any change to `review.trigger` policy** — `resolveReviewTrigger` is the one
   implementation on every route and carries a locked product decision (#212).
6. **Curating a tier-2 validation repo** ([WP9](09-external-validation.md)) —
   same reasoning as gold edits.
7. **Any external claim about review quality** before WP9 has run. The eight-case
   set is a development instrument, not evidence of generality.

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
