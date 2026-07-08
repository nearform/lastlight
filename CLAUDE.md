# lastlight-evals — agent orientation

This file orients an agent working in this repo: how to use it (commands +
common tasks below) and the *why* — the seams and invariants to preserve when
changing the harness. The full human-facing reference lives in `README.md`.

This is a **standalone package** that depends on `lastlight` (npm). It used to
live inside the core repo at `lastlight/evals`; it now consumes core through the
public `lastlight/evals` barrel. Source is under `src/`; the shipped sample
`datasets/` and `models.json` sit at the package root.

## What this is, in one line

A CLI that runs Last Light's real workflows against a mocked GitHub for a set of
models and prints a deterministic, model-comparison scorecard. `run.ts` is the
entry; the subcommands are `run`, `init`, `add-case`, and `serve`.

## Related: the `lastlight-evals` skill (keep in sync)

The user-facing **agent skill** that teaches people to drive this CLI lives in a
**separate repo** — the `lastlight` plugin, at
`~/work/lastlight/plugins/lastlight/skills/lastlight-evals/SKILL.md` (+ its
`references/`). It documents this CLI's surface: the `run` / `init` / `add-case`
/ `serve` subcommands and their flags, defined here in `src/run.ts` (the `USAGE`
block), `src/init.ts` (the `init` flags), and `src/add-case.ts` (the `add-case`
flags + the PR/issue authoring flow, also in `references/authoring-from-pr.md`).

**When you change that surface — add/rename/remove a subcommand, flag, default,
or example — update the skill in the same change** so it doesn't drift. A
checked-in Claude Code hook (`.claude/hooks/check-cli-skill.sh`, wired in
`.claude/settings.json`) reminds you whenever `src/run.ts` or `src/init.ts` is
edited; it resolves the skill at `../lastlight` by default, overridable with
`LASTLIGHT_CORE_DIR`.

A sibling **`lastlight-evals-loop`** skill (same plugin dir) drives the
score-improvement loop *on top of* this CLI — it consumes `scorecard.json`, the
repo-context injection seam (below), `scripts/mine-failures.ts` (the read-only
TRAIN-only failure-signature miner — its diagnosis input) and `scripts/diff-runs.ts`
(the read-only two-run F1 diff + keep/revert verdict, now with an opt-in
`--symmetric` gate + a machine-readable `REGRESSED(train)/REGRESSED(heldout)` line).
It adds no CLI subcommands, but it relies on those two scripts, the
`--no-inject-context` flag and the `repo-context/` / `context/<id>/` convention, so
keep those in sync with it too. The loop's method (mine → propose a few candidates →
keep the best under a blind held-out gate) follows *Self-Harness*
(arXiv:2606.09498); see the skill's `references/approach.md`.

## Commands

```bash
npm install            # installs lastlight (core) + agentic-pi
npm run build          # build:harness (tsc → dist/, bin: dist/run.js) + build:dashboard (Vite → dashboard/dist)
npm test               # vitest — the AI-free mechanism.test.ts only
npm run typecheck      # tsc --noEmit (harness) + dashboard tsc --noEmit
npm run dev:dashboard  # Vite HMR for the SPA; proxies /api + /data to a running `serve` (port 4319)

# Dev (tsx, no build):
npx tsx src/run.ts run triage          # one tier
npx tsx src/run.ts run --compare       # cross-vendor (key-gated, see models.json)
npx tsx src/run.ts serve               # browse past runs in the dashboard
npx tsx src/run.ts init /tmp/my-evals  # scaffold an overlay+evals repo
npx tsx src/run.ts add-case --pr <url> --dry-run   # author a code-fix case from a real PR

# Installed:
lastlight-evals run [tier...] [--model X] [--runs N] [--overlay DIR] [--datasets DIR]
lastlight-evals run [tier...] --mode config [--overlay DIR ...] [--model X]  # per-step config run type
lastlight-evals add-case --pr <url> | --issue <url> [--datasets DIR | --overlay DIR]  # author a case from GitHub
lastlight-evals serve [--port N]       # dashboard over ./eval-results
```

**Two run types (the comparison axis), set by `--mode`:**
- `models` (default) — compare models, each FORCED across every workflow step
  (`--model`/`--compare` select the set). → `eval-results/<tier>[-compare]/`.
- `config` (`--mode config`) — run a deployment's REAL per-step model config:
  `models`/`variants` from `--overlay`'s `config.yaml`, merged over core's
  `config/default.yaml` (via `src/config.ts`) and threaded to `runWorkflow`
  exactly as prod (`ctx.models` + the `models`/`variants` args) so core picks the
  model per phase. The arm is the config/overlay (repeat `--overlay` for
  side-by-side; `--model` overrides a config's `default`). →
  `eval-results/<tier>-config/` (own trend line). `examples/overlay/` is a
  ready-to-run sample. Both types share ALL downstream machinery (work-list →
  scorecard → dashboard); they differ only in model selection per step, keyed on
  the arm label (`InstanceResult.model`). A run with no model flags in a TTY asks
  which type.

The dashboard is a separate Vite app under `dashboard/` (its own `package.json`).
`npm run build` builds it and `dashboard/dist` ships in the package, so an
installed CLI serves the SPA with no Vite at runtime. `npm install` at the repo
root does NOT install the dashboard's deps — `npm run build` (→ `build:dashboard`)
runs `npm --prefix dashboard install` for you.

Needs a provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `FIREWORKS_API_KEY`
/ `OPENROUTER_API_KEY`) in env or a cwd `.env`. Each run lands in its OWN folder
→ `./eval-results/<tiers>/<runId>/` (`scorecard.json` + `predictions.jsonl`;
`runId` = `<timestamp>-<git-sha>`), so runs accumulate instead of overwriting.
**The report is a JSON-driven SPA, not generated HTML** — the harness only ever
writes `scorecard.json` (atomically, live-updated during a run). `run` starts a
tiny local server (`src/serve.ts`) and opens `http://localhost:PORT` deep-linked
at the run; `lastlight-evals serve` re-opens that dashboard to browse every past
run (overview = runs newest-first + per-model trend sparklines, per-run = the
model-comparison scorecard + per-instance rows). The dashboard SPA lives in
`dashboard/` (Vite + React + Tailwind/daisyUI + TanStack Query) and ships
prebuilt as `dashboard/dist`. The runner exits non-zero ONLY on harness error —
a weak model scoring badly is the measurement.

## Release dance

`lastlight-evals` is published to npm. Publishing is **gated on a GitHub
Release** (`.github/workflows/publish.yml` triggers on `release: published`), so
a bare tag push never publishes on its own — cutting the Release is the
deliberate trigger. The CI workflow re-runs typecheck + test + build before
`npm publish --provenance`, but run the gate locally first so a broken release
never reaches the Release step:

Before cutting a release, confirm the `lastlight-evals` skill (in the `lastlight`
plugin — see "Related: the `lastlight-evals` skill" above) still matches the
shipped CLI; the published surface and its skill docs should ship together.

```bash
# 0. On main, clean tree, in sync with origin. Gate locally:
npm run typecheck && npm test && npm run build

# 1. Bump version in package.json + package-lock.json (no git tag/commit yet).
#    patch = refactor/fix, minor = new user-facing capability, major = break.
npm version patch --no-git-tag-version

# 2. Commit + signed annotated tag (tag.gpgsign is on — the tag is SSH-signed).
git add package.json package-lock.json
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"

# 3. Push main + the tag together.
git push origin main --follow-tags

# 4. Cut the GitHub Release on that tag — THIS is what publishes to npm.
gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes "…"

# 5. Watch the publish run; confirm npm has the new version.
gh run list --workflow publish.yml --limit 1
npm view lastlight-evals version
```

The release commit is conventionally just the two version-file lines
(`chore(release): vX.Y.Z`); land the actual change in its own commit first.

## Where things live

| File | Role |
|---|---|
| `src/run.ts` | CLI entry + subcommand dispatch (`run` / `init` / `add-case` / `serve`); work-list, git-source cache prefetch, parallelism, live JSON writes, auto-serve. |
| `src/run-instance.ts` | Runs ONE instance through the real workflow (the only file importing `lastlight/evals`). |
| `src/bootstrap.ts` | `bootstrapAssets()` — wires core's asset roots. MUST run before any workflow access. |
| `src/discovery.ts` | Multi-root tier discovery (`tier.json` → `defaultWorkflow`). |
| `src/init.ts` | `init` — scaffold + `gh repo create` an overlay+evals repo. |
| `src/add-case.ts` | `add-case` — author an instance from a real GitHub PR/issue (`gh`+`git`: base/head SHAs, `test_patch`, red→green verdicts). |
| `src/fake-github.ts` | In-process fake GitHub REST API (seeds fixtures, records mutations). |
| `src/seed.ts` / `src/grade.ts` / `src/metrics.ts` | Workspace seeding (vendored fixture, git-source `base_commit` checkout, OR pr-review PR-head checkout — all from the `./.eval-cache/` mirror) / grading (execution TAP, behavioral, + `gradeReview` judge) / token-cost roll-up. |
| `src/judge.ts` | One-shot LLM client for `gradeReview` (pr-review only) — direct provider `fetch`, temp 0. `EVAL_JUDGE_MODEL` overrides `defaultJudgeModel()`. |
| `scripts/import-martian.ts` | Import Martian's Code Review Bench offline set (50 PRs) into the `pr-review` tier (`gh`+`git`: resolves base/head, pins SHAs). |
| `scripts/mine-failures.ts` | Read-only TRAIN-only failure-signature miner — clusters `review.falseNegatives`/`falsePositives` into ranked recall/precision signatures (the evidence bundle) for the `lastlight-evals-loop` skill's diagnose step. |
| `scripts/diff-runs.ts` | Read-only two-scorecard F1 diff (per-case + arm delta) + train/held-out keep/revert verdict (opt-in `--symmetric` non-regressive gate; split-partitioned `REGRESSED(...)` line) — the measurement step of the `lastlight-evals-loop` skill. |
| `src/report.ts` | Scorecard roll-up + JSON/JSONL artifacts + `buildIndex` (filesystem → the SPA's `/api/index`). |
| `src/serve.ts` | Tiny dependency-free server: `/api/index` (fs scan), `/data/*` (raw artifacts), the SPA + fallback. |
| `dashboard/` | The JSON-driven dashboard SPA (Vite + React + Tailwind/daisyUI + TanStack Query); ships prebuilt as `dashboard/dist`. |
| `.claude/hooks/check-cli-skill.sh` | PostToolUse hook: nudges a skill review when `run.ts`/`init.ts` (the CLI surface) change. |
| `datasets/<tier>/` | Shipped sample tiers (`instances.json` + `tier.json` [+ `repos/` `tests/`]). |
| `models.json` | Default + compare model registry. |

## Common tasks

- **Run a subset:** `EVAL_INSTANCE=<id[,id2]> lastlight-evals run <tier>` (same as
  `--instance`) filters by **exact** `instance_id` (comma-separated for several) —
  NOT a substring, so pass the full id (e.g. `prreview__discourse-graphite-6`);
  `--model haiku` (fuzzy) picks one model; `--runs 3` repeats (worst-case verdict,
  mean metrics).
- **Verifying the harness/UI (not a model):** when running an eval just to check
  the plumbing or dashboard works, pick the **cheapest, fastest** model available
  (e.g. `--model haiku`, or the cheapest entry in `models.json`) and the smallest
  scope (`EVAL_INSTANCE=<exact-id>` and/or one tier). Model quality isn't what
  you're testing — don't burn time/cost on a strong model for a smoke run.
- **Add a triage case:** append a `SweBenchInstance` to
  `datasets/triage/instances.json` (`instance_id`, `issue`, `triage_gold`,
  `expect_github`). See README "Add a case". Or scaffold from a real resolved
  issue: `lastlight-evals add-case --issue <url>` — pulls content + applied labels
  (via the issue events API, with who applied each) + reviewer comments, seeds the
  issue WITHOUT its triage labels, and sets `expect_github.labels_added` /
  `issue_closed`; you assign `triage_gold` (category/state) per the deployment's
  taxonomy.
- **Add a code-fix case (vendored):** `datasets/code-fix/instances.json` +
  `repos/<id>/` (fixture @ base) + `tests/<id>/` (held-out tests).
- **Add a code-fix case from a real PR (git-source):**
  `lastlight-evals add-case --pr <url>` (`src/add-case.ts`) extracts `repo`,
  `base_commit` (merge-base of base & head), `head_commit`, the `test_patch` (the
  PR's test diff), and auto-detects `FAIL_TO_PASS`/`PASS_TO_PASS` by running the
  tests at base (red) vs head (green). No `repos/<id>/` is written — at run time
  `seedWorkspaceFromGit` clones the repo into the gitignored repo-local
  `./.eval-cache/` and checks out `base_commit`. `--dry-run` prints the instance
  for the skill/agent to refine; `--no-validate` skips running the repo's tests.
  Suite mode (no TAP names ⇒ graded on the test command's exit code) covers
  non-`node --test` runners via `test_cmd`/`setup_cmd`.
- **Add a tier:** drop a dir with `instances.json` + `tier.json`
  (`{ name, defaultWorkflow, description }`). No code change — `discovery.ts`
  finds it. The workflow must be resolvable by core's `getWorkflow`.
- **Add a model:** add an entry to `models.json` `compare` (`id`, `label`,
  `envKey`); it runs only when its `envKey` is set.
- **Eval an overlay's own workflows + datasets:**
  `lastlight-evals run --overlay <repo>` (workflows shadow built-ins; datasets
  read from `<repo>/evals/datasets/`).

## Package architecture (the extraction seams)

- **The barrel — the ONLY core coupling.** `run-instance.ts` imports
  `getWorkflow`, `runWorkflow`, `ExecutorConfig`, `TemplateContext` from
  `lastlight/evals` (core's `src/evals-api.ts`). Never reach into
  `lastlight/dist/...` deep paths — the barrel is the stable contract. `init.ts`
  also pulls `detectGh` / `bootstrapOverlayRepo` from it.
- **The asset-bootstrap footgun (`bootstrap.ts`).** Core's `getWorkflow`
  resolves built-in workflows/skills/agent-context from `DEFAULT_ROOT =
  resolve(".")` (the cwd). In-repo that was the core checkout; here the cwd is
  wherever the user ran the CLI. So `run.ts` MUST call `bootstrapAssets()`
  (→ `configureWorkflowAssets({ builtInRoot, overlayRoot })`) **before any
  `getWorkflow`/`runWorkflow`**. `builtInRoot` is the installed `lastlight`
  package root (or `LASTLIGHT_CORE_DIR`). Forget the call and workflows silently
  fail to resolve. It is the first thing `runEval` does.
- **Discovery, not a hardcoded map (`discovery.ts`).** Tiers are directories
  with an `instances.json`, discovered from built-in (`<pkg>/datasets`), user
  (`--datasets`), and overlay (`<overlay>/evals/datasets`) roots —
  overlay-wins-by-name. `defaultWorkflow` comes from a per-tier `tier.json`
  (or the per-instance `workflow`). Adding a tier = dropping a directory; no
  code change.
- **Overlay parity.** `--overlay <dir>` (or `LASTLIGHT_OVERLAY_DIR`) wires BOTH
  the workflow/skill overlay (via `bootstrapAssets`) and the dataset overlay
  (via discovery) from one flag — a bootstrapped `init` repo is exactly such an
  overlay.

## The one invariant

These evals run the **real** production workflows (`issue-triage`, `build`, …)
— their actual YAML, prompts, and skills, unmodified. The only deviations from
production are the two we can't do unattended:

1. **GitHub is mocked**, not bypassed — the agent's `github_*` calls hit an
   in-process fake and are recorded.
2. **Approval gates are disabled** so runs never pause.

If a change makes the eval diverge from prod in any *other* way, it's wrong —
the whole point is to test what ships.

## How the mock actually works (don't break these)

- **The base-URL seam.** The `github_*` tools are agentic-pi's *built-in*
  extension (not a swappable MCP server). agentic-pi ≥ 0.2.11 exposes
  `githubApiBaseUrl`; Last Light threads it `ExecutorConfig.githubApiBaseUrl →
  agenticRun`. `run-instance.ts` sets it to the fake server's URL. This is the
  whole mechanism — our `mechanism.test.ts` guards the consumer side; core has
  its own slim guard (`src/engine/agent-executor.seam.test.ts`) proving it still
  forwards the URL.
- **Static-token mode.** The harness sets `GITHUB_TOKEN` (a dummy) and
  *unsets* `GITHUB_APP_ID`/`GITHUB_APP_INSTALLATION_ID`, so the GitHub
  extension loads but no real installation token is ever minted. The workflow's
  `profile` (issues-write / repo-write, derived from the workflow name) still
  decides which tools exist.
- **Seeding without a clone.** `runWorkflow` only clones from GitHub when
  `ctx.prePopulateBranch` is set. The eval **never sets it**, so no clone
  happens and the agent's cwd is the workspace root `<stateDir>/sandboxes/
  <taskId>` — exactly the dir `seed.ts` pre-populates (fixture @ base_commit +
  a local bare `origin`, so `git push` works offline). If you ever set
  `prePopulateBranch`, the runner will try to clone real GitHub.
- **Gates need a DB.** A phase only pauses when `db && workflowId && the gate is
  enabled`. The eval passes **no `db`** and an **empty `approvalConfig`**, so
  every gate is a no-op. Don't add a db just for metrics (see below).
- **Repo-context injection (pr-review).** `injectRepoContext` (`seed.ts`) writes a
  synthetic `AGENTS.md`/`CLAUDE.md` into the seeded checkout so the reviewing agent
  reads it (Pi auto-loads the first of `AGENTS.md`>`CLAUDE.md` walking up from the
  agent cwd = the repo dir). `run-instance.ts` resolves two sources — a GENERIC
  block from `<overlay>/repo-context/` (every repo) + a PER-REPO block from
  `<datasetDir>/context/<id>/` — and records `injectedContext` provenance on the
  result. It **appends** to a real `AGENTS.md`/`CLAUDE.md` (never shadows it) and
  git-excludes a freshly-created file. This is a **deliberate, opt-outable**
  (`--no-inject-context` / `EVAL_INJECT_CONTEXT=0`) deviation, faithful to what a
  maintainer could commit — so it doesn't break the "real workflow, unmodified"
  invariant. It's the lever the `lastlight-evals-loop` skill uses to prove
  "add this to your repo → better reviews".

## Metrics gotcha

Token/cost come from the session jsonl the executor's shim writes — and the
*final* result envelope is flushed **fire-and-forget** (`void shim.flush()` in
`agent-executor.ts`). So it can land after `runWorkflow` resolves.
`run-instance.ts` calls `drainSessions()` (wait for the jsonl tree to go quiet)
before `collectMetrics()` and before deleting the temp workspace. Remove the
drain and cost silently reads 0.

## Test vs script (keep the split)

- `src/mechanism.test.ts` — a **real test** in the default `npm test` suite:
  deterministic, AI-free (fake GitHub + the base-URL seam + seed/grade
  red→green). It *should* fail the build if the mock plumbing breaks.
- `src/run.ts` — a **script** (`lastlight-evals run`), a measurement. It exits
  non-zero only on harness error, never because a model scored badly.
- `datasets/**/*.test.ts` are **fixtures** (held-out tests run inside a seeded
  workspace), NOT harness tests — excluded from `vitest.config.ts` (and outside
  `tsconfig`'s `src` rootDir). Keep them excluded or the default suite tries to
  run raw fixture tests.

## Grading = deterministic signals (+ one scoped judge)

- **Execution** (`gradeExecution`): copy the held-out tests in, run them, require
  every `FAIL_TO_PASS` green and every `PASS_TO_PASS` still green — SWE-bench's
  resolved criterion. Held-out tests live in `datasets/<tier>/tests/<id>/`, kept
  out of the seeded repo so the agent can't edit them.
- **Behavioral** (`gradeBehavioral` / `gradeTriage`): assert the recorded
  GitHub mutations (labels, comments, PRs) against the instance's
  `expect_github` / `triage_gold`. Primary signal for triage. Includes a cheap
  `review_submitted` proxy for the pr-review tier.
- **Review** (`gradeReview`, `pr-review` tier only): the posted PR review is
  matched to a human-verified `review_gold` set by an **LLM judge** (`judge.ts`)
  → precision / recall / **F-beta**. The headline is **F1** (β=1, Martian's Code
  Review Bench leaderboard metric); `EVAL_F_BETA` reweights (0.5 → precision 2×),
  mirroring Martian's adjustable F-beta. This is
  the one, deliberately-scoped exception to the deterministic rule — matching a
  free-text review against semantic gold comments can't be done deterministically.
  Triage/code-fix stay judge-free. The judge model is independent of the models
  under test (`EVAL_JUDGE_MODEL`, else a strong default per provider key); a judge
  failure marks the case errored (ungraded), never a silent zero.

### The pr-review approach (Code Review Bench)

The full path, since it's the most involved tier (see README "PR-review tier" for
the user-facing version):

- **Source.** Cases are imported from Martian's **offline** Code Review Bench
  (`scripts/import-martian.ts` → 50 real merged PRs with inlined `golden_comments`,
  base/head SHAs pinned). The tier ships empty by design.
- **Seed.** `seedWorkspacePrReview` clones the real repo into `./.eval-cache/` and
  checks out the PR **head** (see "Seeding without a clone" — the PR head is
  anchored on a branch so the workspace clone carries it; a squash/rebase-merged
  head is off-branch otherwise).
- **Judge (two steps, `gradeReview`).** (1) *extract* the review's distinct
  concrete findings; (2) *match* each to a gold comment. precision = matched ÷
  posted, recall = matched ÷ gold, combined as **F-beta** at `beta` (`--f-beta`
  flag → `opts.judge.beta`, else `defaultBeta()` ← `EVAL_F_BETA`, else 1). The
  dashboard labels the column `F{β}` from `review.beta`.
- **Diff-blind by default (Martian-offline parity).** The judge reads only the
  posted review (body + inline comments from `fake.submittedReviews`), NOT the PR
  diff. `--judge-with-diff` (`opts.judge.withDiff`) makes `run-instance` compute
  `git diff base..head` in the seeded workspace and pass it to `gradeReview`,
  which feeds it to both judge steps (instructed to use it only to interpret
  comments, never to invent findings). Sets `trace.usedDiff` → a `diff-aware`
  badge in the JudgeModal. Off by default because it diverges from the leaderboard.
- **Trace.** `gradeReview` returns a `ReviewTrace` (judge model, the review text
  it read, extracted findings, the gold set, the finding↔gold pairing, raw
  replies). It rides in `InstanceResult.review.trace` → the dashboard's **judge**
  button (`JudgeModal`) renders it, so a score is inspectable, not a black box.
- **Caveat to preserve in docs.** Martian's gold set is **incomplete** (their own
  methodology: it caps at human performance, so a real-but-unlisted finding scores
  as a false positive → understates precision). That's *why* the default is F1,
  not F0.5. Don't re-attribute F0.5 to Martian — their leaderboard headline is F1.

## Models

The model list lives in `models.json` (`default` + a `compare` set); `env.ts`
reads it. Each `compare` entry is key-gated by its `envKey`, so
`npm run eval:compare` only runs models whose provider key is present — adding
an entry with no key is a silent no-op, not an error. `id` must be a spec
pi-ai's registry resolves (`provider/model`); Fireworks ids are the long
`fireworks/accounts/fireworks/models/<x>` form. Provider keys are read from
`process.env` by agentic-pi directly (the harness loads `.env`), so a new
provider just needs its key set + a registry id — no harness change.

## Adding a workflow/tier

When pointing the harness at a new real workflow, check:
- `gitAccessProfileForWorkflow` (in core, `lastlight`'s `workflows/runner.ts`)
  maps it to a profile → which `github_*` tools the agent gets. This lives in
  the installed `lastlight` package now, not here.
- `fake-github.ts` implements every REST endpoint that profile's tools call.
  Unimplemented routes return 404 on purpose (loud, not silent) — add the route
  rather than masking it.
- A tier is just a directory with `instances.json` + `tier.json` (its
  `defaultWorkflow`). No `TIERS` map to edit — `discovery.ts` finds it. The
  workflow itself must be resolvable by core's `getWorkflow` (a built-in, or an
  overlay workflow under `<overlay>/workflows/`).

## Parallelism (across provider families)

`run.ts` runs provider families (OpenAI / Anthropic / Fireworks — keyed by each
model's `envKey`) **concurrently**, serial within a family (so one provider's
rate limit is never hammered). Per-run workspaces were always isolated (a fresh
`mkdtemp` stateDir + a private fake-GitHub port each), so the *only* blocker to
in-process concurrency was shared `process.env`. The fix:

- **Hoist the GitHub env once per batch.** `applyEvalEnv()` installs the
  static-token env (`GITHUB_TOKEN=eval-fake-token`, App vars unset) ONCE around
  the whole run; every `runInstance` is called with `manageEnv: false` so it
  doesn't splice/restore env itself. Every eval run wants the *same* values, so
  a single stable baseline is race-free where per-run splicing would not be.
- **No `process.chdir`.** The `sandbox:"none"` executor threads a per-run `cwd`
  to agentic-pi + child processes; it never changes the process-wide cwd. (If
  that ever changes, in-process concurrency breaks.)
- **`console` is silenced once** for the parallel batch — the per-run `quiet()`
  swap is not concurrency-safe (nested save/restore), so parallel mode drops
  `console.*` for the batch instead. The clack spinner is unaffected (it writes
  via `process.stdout.write`).
- **Live `scorecard.json` writes don't race** despite concurrency:
  `summarize`/`writeScorecard` run synchronously to completion within one
  event-loop turn, so concurrent family loops never interleave a write (and the
  temp-file+rename keeps a polling dashboard from reading a half-written file).

Force serial with `--serial`; single-family runs (e.g. the default single
model) are serial anyway and keep the per-run spinner + captured logs.

## Known sharp edges

- The agent can pick the **wrong owner/repo** for GitHub calls on tiny synthetic
  fixtures (it has no real remote to infer from). That's a model/fixture-tuning
  matter, not a harness bug — surfaces as `behavioral✗` (no PR). Stronger models
  fare better; this is the kind of thing the eval is meant to reveal.
