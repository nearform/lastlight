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

The user-facing **agent skill** that teaches people to drive this CLI lives in
the **same monorepo** — the `lastlight` plugin, at
`plugins/lastlight/skills/lastlight-evals/SKILL.md` (+ its
`references/`). It documents this CLI's surface: the `run` / `init` / `add-case`
/ `serve` subcommands and their flags, defined here in `src/run.ts` (the `USAGE`
block), `src/init.ts` (the `init` flags), and `src/add-case.ts` (the `add-case`
flags + the PR/issue authoring flow, also in `references/authoring-from-pr.md`).

**When you change that surface — add/rename/remove a subcommand, flag, default,
or example — update the skill in the same change** so it doesn't drift. A
checked-in Claude Code hook (`.claude/hooks/check-cli-skill.sh`, wired in
`.claude/settings.json`) reminds you whenever `src/run.ts` or `src/init.ts` is
edited; it resolves the skill at the monorepo root by default (four levels up
from the hook), overridable with `LASTLIGHT_CORE_DIR`.

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
| `src/fake-github.ts` | In-process fake GitHub REST API (seeds fixtures, records mutations) **plus** the non-REST `fetchRepoConfigTree` seam for a repo's `.lastlight/`. |
| `src/repo-config.ts` | Per-repo config layer (#180): reads a case's fixture tree and drives core's OWN resolver over it. The one file with deep `lastlight-core/dist/...` imports — see below. |
| `src/pr-context.ts` | PR state machine (#251/#252): builds the `PrState` snapshot a case seeds and hands it to core's OWN `renderContext`. Same shape as `repo-config.ts` — the harness supplies what core normally reads from live GitHub, core does the projection. No second copy of it here. |
| `src/seed.ts` / `src/grade.ts` / `src/metrics.ts` | Workspace seeding (vendored fixture, git-source `base_commit` checkout, OR pr-review PR-head checkout — all from the `./.eval-cache/` mirror) / grading (execution TAP, behavioral, + `gradeReview` judge) / token-cost roll-up. |
| `src/judge.ts` | One-shot LLM client for `gradeReview` (pr-review only) — direct provider `fetch`, temp 0. `EVAL_JUDGE_MODEL` overrides `defaultJudgeModel()`. |
| `scripts/import-martian.ts` | Import Martian's Code Review Bench offline set (50 PRs) into the `pr-review` tier (`gh`+`git`: resolves base/head, pins SHAs). |
| `scripts/mine-failures.ts` | Read-only TRAIN-only failure-signature miner — clusters `review.falseNegatives`/`falsePositives` into ranked recall/precision signatures (the evidence bundle) for the `lastlight-evals-loop` skill's diagnose step. |
| `scripts/diff-runs.ts` | Read-only two-scorecard F1 diff (per-case + arm delta) + train/held-out keep/revert verdict (opt-in `--symmetric` non-regressive gate; split-partitioned `REGRESSED(...)` line) — the measurement step of the `lastlight-evals-loop` skill. Also prints the MICRO section (micro-recall / SNR / paired McNemar) and refuses a verdict when the two runs graded different case sets. |
| `scripts/facts-anchors.ts` | Builds `datasets/pr-review/anchors.json` — the **frozen, versioned** deterministic anchor labels (tokenizer `v1`) that give the code-facts evidence-coverage metric its denominator. No model anywhere. Freeze the labels, not the tokenizer: the artifact stamps `tokenizer`, so a better tokenizer ships as `v2` rather than rewriting past numbers. Carries a hand-audit block (seed + verdicts) that is the metric's error bar. Never commits gold text — `instances.json` is gitignored for a reason. |
| `scripts/rescore.ts` | Read-only (unless `--write`) offline re-score: back-fills micro-recall / SNR / the attention boundaries onto an EXISTING scorecard with no model spend, and refuses to write if a published number changed. Plus `--repeat-judge N` — the ONE mode that spends (2 judge calls per case per repeat): it re-runs the judge N times over the stored review text + gold and reports the spread, separating GRADER noise from pipeline noise. Never runs by default, prints its cost estimate first, and refuses `--write` (a re-judge measures the grader, it does not correct the run). |
| `src/review-metrics.ts` | The recall-first metrics — micro-aggregation, SNR, the detection floor + exact McNemar, the attention boundaries, per-family attribution. Pure arithmetic over stored fields, which is what makes the back-fill possible. |
| `src/report.ts` | Scorecard roll-up + JSON/JSONL artifacts + `buildIndex` (filesystem → the SPA's `/api/index`). |
| `src/serve.ts` | Tiny dependency-free server: `/api/index` (fs scan), `/data/*` (raw artifacts), the SPA + fallback. |
| `dashboard/` | The JSON-driven dashboard SPA (Vite + React + Tailwind/daisyUI + TanStack Query); ships prebuilt as `dashboard/dist`. |
| `.claude/hooks/check-cli-skill.sh` | PostToolUse hook: nudges a skill review when `run.ts`/`init.ts` (the CLI surface) change. |
| `datasets/<tier>/` | Shipped sample tiers (`instances.json` + `tier.json` [+ `repos/` `tests/` `context/<id>/` `lastlight/<id>/`]). |
| `models.json` | Default + compare model registry. |

## Common tasks

- **Run a subset:** `EVAL_INSTANCE=<id[,id2]> lastlight-evals run <tier>` (same as
  `--instance`) filters by **exact** `instance_id` (comma-separated for several) —
  NOT a substring, so pass the full id (e.g. `prreview__discourse-graphite-6`);
  `--model haiku` (fuzzy) picks one model; `--runs 3` repeats each CASE (worst-case
  verdict, mean metrics).
- **Never report one arm as a number — `--repeats N`.** Three *identical* runs of
  one pr-review arm measured micro-recall 0.320 / 0.080 / 0.200 (union 0.440,
  intersection 0.040), and `diff-runs` returned KEEP on one and REVERT on the other
  two *from one configuration*. `--repeats N` re-runs the whole ARM N times,
  strictly sequentially, as N **sibling** run dirs — each a normal run tagged
  `meta.repeat = {group, index, of}` (`group` = the first repeat's `runId`), which
  `varianceRollup` (`review-metrics.ts`) folds into a band with union/intersection
  recall. Repeats are siblings and never nested because `indexTier`/`buildIndex`
  and `clean.ts` all walk exactly two levels. It implies `--keep-workspace` (when
  repeats disagree the question is always *which* evidence each produced) and
  `--no-open` (a finished run holds its dashboard server open forever — a repeat
  loop would leak one per repeat), printing the standalone `serve` command once
  instead. Distinct from `--runs`, which folds a case's trials into one worst-case
  result and destroys the per-trial hit vectors a band is computed from. Pair it
  with `scripts/rescore.ts --repeat-judge N` for the grader's own band: a
  candidate's Δ has to clear both.
- **Run provenance (what the run actually was).** Every scorecard now stamps the
  invocation beside the numbers, flat on `meta` alongside `gitSha`/`core` (grouped
  as the `RunProvenance` type, which `RunMeta` extends) — `overlay`/`overlays`,
  `datasets`, `sandbox`, `fBeta`, `judgeWithDiff`, `injectContext`, `keepWorkspace`,
  `instances`, `limit`, `repeats`, `judgeModel`, the resolved `factsBin` + its
  `toolchain` stamp, `harness` (version + root), and raw `argv`. `meta` used to
  record model/gitSha/core but not
  the overlay, so a `models` run recorded its `review.analysis.enabled` policy
  nowhere at all; a globally-installed harness once ran the *baseline* while
  reporting itself as the pipeline arm and nothing in the artifact could contradict
  it. Every field is optional — absent means "not recorded", never "off".
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
- **Give a case a committed `.lastlight/` (issue #180):** drop the tree at
  `datasets/<tier>/lastlight/<instance_id>/` — `lastlight.yml`,
  `workflows/prompts/*.md`, `skills/<name>/SKILL.md`, `agent-context/*.md`, laid
  out exactly as the repo commits it. No instance field, no flag. Files the
  bounds reject (a `workflows/*.yaml`, an out-of-bounds key, a symlink) are seeded
  verbatim on purpose, so a case can measure the rejection path; what survived
  lands on the result's `repoLayer`. The shipped `repo-config` tier is the worked
  example.
- **Add a tier:** drop a dir with `instances.json` + `tier.json`
  (`{ name, defaultWorkflow, description }`). No code change — `discovery.ts`
  finds it. The workflow must be resolvable by core's `getWorkflow`.
- **Add a PR-scoped case (fix / dependency-merge):** give it a `pr_state` block.
  The harness projects it through **core's own** `renderContext`
  (`src/pr-context.ts`), which is where `{{ciSection}}`, `{{attempt}}`,
  `{{mayMerge}}` and `{{priorNotes}}` come from in production — a case without
  one runs those workflows with every `{{#if}}` guard on the empty branch.
  Grade the verdict with `expect_markers` (`diagnosis_class`,
  `assessment_impact`, …): for those tiers the marker line IS the deliverable,
  and a wrong diagnosis touches no GitHub state, so `expect_github` alone scores
  it green.
- **Give a vendored case a real PR commit:** `repos/<id>/` is the base tree,
  `repos-head/<id>/` is the PR's commit applied on the branch. Without the
  second, base and head are identical and an agent that checks whether `main` is
  broken too correctly answers yes — every red-dependency case then reads as
  `upstream-broken`.
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
  also pulls `detectGh` / `bootstrapOverlayRepo` from it, and `src/repo-config.ts`
  pulls `resolveRepoRunConfig` / `invalidateRepoLayer` / `RunRepoConfig` (issue
  #180). `"./dist/*"` is in core's `exports` map and so a deep path *would*
  resolve — don't; add the symbol to `evals-api.ts` instead.
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

- **Auto-merge is GraphQL, not REST.** `github_enable_auto_merge` has no REST
  equivalent — GitHub exposes `enablePullRequestAutoMerge` only through
  GraphQL — so `fake-github.ts` serves `POST /graphql` for that one mutation. A
  REST-only fake 404s the merge workflow's *preferred* path and the agent
  silently falls back to a direct merge, which would make every
  dependency-merge case measure the fallback.
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
- **The per-repo config layer is NOT a REST route (issue #180).** A managed repo's
  committed `.lastlight/` is read by the HARNESS, not by an agent tool, through
  `GitHubClient.fetchRepoConfigTree` — core's own seam for exactly this ("lives on
  the client rather than raw octokit at the call site because the evals harness
  swaps this whole seam for fixtures"). So `fake-github.ts` implements that
  *method*, not the git-tree + blob endpoints underneath it, and a `FakeGitHub` is
  structurally a `GitHubClient` for the one call `fetchRepoLayer` makes. A case
  declares a layer by dropping the tree at `<datasetDir>/lastlight/<instance_id>/`
  (presence IS the declaration — same zero-config spirit as `context/<id>/`); no
  fixture ⇒ `status: "absent"` ⇒ **no layer**, which is the path every pre-#180
  case takes and must stay bit-identical. `run-instance.ts` then hands the
  resolved `RunRepoConfig` to `runWorkflow`'s 10th argument exactly as
  `dispatchWorkflow` does in prod. Everything in between — bounds, unpack, merge,
  provenance, warnings, the per-run asset resolver — is core's, unmodified; the
  harness only supplies the two things core normally reads from boot state (the
  base config to merge onto, projected from the ARM, and a per-run cache root).
  See `src/repo-config.ts` and the shipped `repo-config` tier.
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
#### Micro-recall + SNR (the recall-first headline)

The per-case F1 mean is the right metric for the Martian leaderboard and the
**wrong** one for steering recall work, so `src/review-metrics.ts` adds a second
set of numbers alongside it (never instead of it). Both ride on `ModelSummary`.

- **Micro-recall** = matched ÷ gold, summed over cases — not the mean of per-case
  recalls. The mean weights a 1-gold case like a 6-gold one, and hands a free
  1.00 to a case with **no gold at all**, which one of the eight `skillspro`
  cases is. `renderTable` names every empty-gold case under the table as a
  precision canary for exactly that reason.
- **SNR** = matched ÷ (posted − matched) — true positives per false positive. It
  replaces precision as the guardrail when the pipeline is deliberately tuned to
  over-produce: it is the number that degrades when a recall intervention goes
  wrong, and that degradation is invisible in F1. **Do not redefine it silently**
  — every rung of the ablation ladder is read against it.
- **The detection floor.** On a 25-finding gold set, one extra hit is McNemar
  p = 0.50 — a coin flip; the floor is ≈ 0.24–0.28 micro-recall, at or above the
  published frontier. `diff-runs.ts` prints the exact paired p beside every Δ so
  nobody reads noise as progress, and `DETECTION_FLOOR_MICRO_RECALL` carries the
  full table. **Gate on mechanism metrics** (obligations, discharge rate, the
  per-family funnel — n in the hundreds), report micro-recall.
- **Three boundaries, not one.** Once an arm emits an evidence packet, recall is
  measured over everything *generated* (internal recall), precision/SNR over
  everything *posted*, and attention cost over what went *inline*. An
  intervention that finds more and shows less then reads as exactly that instead
  of as a regression. All of it degrades to posted-only for an arm that emits no
  packet (the shipped baseline) — `undefined`, never zeros.
- **A missing analyser is not a null result.** A family whose scanner was absent
  is reported `notMeasured`, never "did not convert".

All of it is arithmetic over `posted`/`gold`/`matched`/`trace`, so
`scripts/rescore.ts` back-fills these onto runs measured before they existed —
with no re-run and no spend. It refuses to write if re-scoring changes a
published number, because the comparator for every gate is an old run.

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

## Parallelism (two axes)

**Across provider families** — `run.ts` runs provider families (OpenAI /
Anthropic / Fireworks — keyed by each model's `envKey`) **concurrently**.

**Within one arm** — `--concurrency N` (default `1`) runs N of that arm's cases
at once, via the shared order-preserving `mapPool` in `src/pool.ts` (also used by
`scripts/aacr-adjudicate.ts`). Serialism within a family was only ever a
rate-limit choice, never a correctness constraint — every case is already
isolated (see the list below). This is what makes an 8-case `pr-review` arm
affordable: serial it is hours, because a pipeline-on case is ~30 minutes.

Two hard limits, both enforced in code:

- **Arms never overlap.** The workflow asset root is a process global
  (`docs/adr/0001-asset-root-is-process-global.md`), so the concurrent branch
  opens and closes the pool *inside* each arm's `activate()` /
  `releaseOverlayGuard()` window, and asserts every pooled item belongs to that
  arm. Two overlays live at once would either throw or — worse — measure one
  arm's cases against another arm's prompts.
- **`--sandbox gondolin` clamps to 1** (a QEMU micro-VM per case).

`--runs N` trials stay serial within a case. With no `--concurrency` flag the
runner takes the original serial branch unchanged, so the default is a no-op by
construction rather than by argument.

Per-run workspaces were always isolated (a fresh
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

Force serial with `--serial`; a single-family run at the default
`--concurrency 1` keeps the per-run spinner + captured logs.

## Metrics gotcha (per-phase)

**`PhaseMetric.durationMs` / `agentMs` / `costUsd` are the latency instrument.**
Without them a scorecard says a case took 30 minutes and nothing about where they
went, which is why the review pipeline's breakdown had to be read by hand out of
transcripts. Two different quantities, deliberately not merged:

- **`durationMs`** — the measured phase window (`onPhaseEnd` − `onPhaseStart`),
  so it includes workspace provisioning, skill staging and the `until_bash` gate.
  **Absent means the phase never started** (it was skipped), not that it was
  instant.
- **`agentMs`** — summed `duration_ms` over that phase's own `result` envelopes,
  i.e. agent + gate time only. Narrower, but derivable from artifacts a run
  already wrote — which is what lets `scripts/rescore.ts` back-fill a per-phase
  split onto runs measured before any of this existed, with no re-run and no
  spend.

Attribution is one function, `bucketSessionsByPhase` (`src/metrics.ts`) — the
per-phase cost roll-up and the archived `NN-<phase>.jsonl` split read that one
implementation, so they cannot disagree about which phase owned a session. It
applies **two rules, in order**:

1. **The stamp.** The event shim writes a `phase` field onto each session's
   opening and closing envelopes (`apps/server/src/engine/event-shim.ts`), and a
   fan-out branch is stamped with its own branch label (`survey_branch_contract`),
   not its parent's. Present ⇒ that is the answer.
2. **The window**, only when a session carries no stamp: the last phase started
   at/before the file's first line.

**The window rule is a fallback, not a peer.** It is a point lookup, so it cannot
express concurrency *at all* — a `fanout` phase opens six windows within 35 ms and
every one of its sessions resolves to whichever branch opened last. On a measured
run that put $1.23 of a $2.01 case onto one branch, or onto no row at all where
the bucket key was the parent and the `PhaseMetric` rows were the branches.
Widening the slack cannot help: the branches are genuinely simultaneous. It also
mis-files *sequential* phases whose session is written late — `writeCommandSession`
writes a command's session after the command finishes, so `facts`' session landed
at roughly `seed`'s start and billed a model-free bash phase for agent time.

The fallback exists because every run archived before 2026-08-22 lacks the stamp,
and those runs must keep bucketing exactly as they did.

**Summing a fan-out's branch durations does not give wall clock.** Six branches of
16/64/93/101/192/242 s sum to ~708 s across ~242 s of real time. A consumer tells
concurrent siblings from sequential phases by their labels — `PhaseRef` emits
`<parent>_branch_<name>` (`packages/workflow-engine/src/core/phase-ref.ts`), so
rows sharing a `_branch_` parent overlap and want max, not sum.

## Known sharp edges

- The agent can pick the **wrong owner/repo** for GitHub calls on tiny synthetic
  fixtures (it has no real remote to infer from). That's a model/fixture-tuning
  matter, not a harness bug — surfaces as `behavioral✗` (no PR). Stronger models
  fare better; this is the kind of thing the eval is meant to reveal.
