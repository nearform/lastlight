---
name: lastlight-evals
description: Scaffold, configure and run a Last Light EVALS workspace — the harness that runs Last Light's real workflows against a mocked GitHub and grades them deterministically. Use when the user wants to "set up / scaffold Last Light Evals", "create an evals workspace or instance", "run evals", "compare models", or author new eval cases — including "create an eval dataset/case from this PR/issue <github url>" (triage / code-fix instances). GitHub is mocked when running, so no real GitHub token is needed — only a model provider API key (the one exception is `add-case`, which reads real PRs/issues via `gh`).
version: 1.2.0
tags: [lastlight, evals, benchmark, models, swe-bench]
---

# Set up & run Last Light Evals

`lastlight-evals` runs Last Light's **real** production workflows (issue-triage,
build, …) end-to-end against a mocked GitHub, grades the results deterministically
(no LLM-as-judge), and compares models on pass rate, cost, and latency. It's a
thin CLI on top of the `lastlight` core package (via the `lastlight/evals`
barrel), so it exercises the same workflows/skills production does. SWE-bench
compatible. **Node 24+.**

## 1. Check prerequisites

```bash
node --version    # need >= 24
command -v lastlight-evals >/dev/null && echo "installed" || npm i -g lastlight-evals
lastlight-evals --version   # prints the evals version + the bundled lastlight core version
# Optional: for `--sandbox gondolin` (isolate the agent in a QEMU micro-VM so it
# can't read host gold data) you also need QEMU natively: `brew install qemu`
# (macOS) or your distro's `qemu-system` package. The default `--sandbox none`
# needs nothing extra.
```

## 2. Scaffold a workspace

`init` is **non-interactive** when there's no TTY (piped/agent/CI) — it never
blocks on a prompt. Two layouts:

### Recommended — Separate (point evals at your existing deployment overlay)

If you already have a deployment overlay repo (e.g. `your-org/lastlight-instance`),
this is the default. It runs your **real** overlay (its config, workflows, skills,
persona) and keeps the eval datasets out of your deployment repo:

```bash
lastlight-evals init my-evals --clone your-org/lastlight-instance
cd my-evals && lastlight-evals run        # bare run — overlay + datasets auto-detected
```

This produces:
- `instance/` — your overlay, cloned as its **own git checkout** (git-ignored
  here; `cd instance && git pull` to update it)
- `evals/datasets/` — seeded from the built-in `triage` + `code-fix` samples (this
  is what you edit; **always created from defaults at init**)
- `evals/models.json` — a copy of the built-in model registry
- `.gitignore` (ignores `instance/` + `eval-results/`), `README.md`

The runner **auto-detects** `./instance` as the overlay and `./evals/datasets` as
the dataset root, so a bare `lastlight-evals run` "just works" — no `--overlay` flag.
Re-running `init --clone` is idempotent: it won't re-clone an existing `instance/`.

### Plain — self-contained overlay + evals (no existing overlay repo)

```bash
lastlight-evals init my-evals       # or: lastlight-evals init  (→ ./lastlight-evals-workspace)
```

The workspace **is** its own overlay: it gets `workflows/`, `skills/`,
`agent-context/` placeholders + its own `config.yaml` alongside `evals/`. Run it
with `--overlay .`. In a TTY it offers `git init` + a private `gh repo create`
(`--no-git` to skip, `--yes` to take the non-interactive path).

## 3. Configure providers (`.env`)

Create `.env` in the workspace with **at least one** provider key. GitHub is
mocked end-to-end, so **no real GitHub token is needed** (the harness sets a
dummy one internally).

```dotenv
# any one (or more) of:
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
FIREWORKS_API_KEY=fw-...
OPENROUTER_API_KEY=sk-or-...
DEEPSEEK_API_KEY=...
```

Useful optional vars: `EVAL_MODELS` (comma-list override), `LASTLIGHT_EVALS_OUT`
(scorecard dir, default `./eval-results/`), `LASTLIGHT_CORE_DIR` (point at a local
lastlight checkout to eval un-published asset edits), `CI=1` (don't open a
browser). See **`references/models-json.md`** for the model registry format and
how `--compare` is key-gated.

## 4. Run

From inside the workspace. For the **Separate** layout the overlay (`./instance`)
and datasets (`./evals/datasets`) are auto-detected — no `--overlay` needed. For
the **Plain** layout pass `--overlay .`.

```bash
cd my-evals
lastlight-evals run                             # default model, triage tier (auto overlay+datasets)
lastlight-evals run triage                      # one tier
lastlight-evals run triage code-fix             # multiple tiers
lastlight-evals run triage --model haiku        # fuzzy match in models.json
lastlight-evals run triage --model openai/gpt-5.5,anthropic/claude-opus-4-8
lastlight-evals run --compare                   # cross-vendor set (only models whose envKey is present)
lastlight-evals run triage --runs 3             # repeat each case 3× (worst-case verdict, mean metrics)
lastlight-evals run pr-review --limit 3         # only the first 3 cases of the tier (controlled/cheap run)
lastlight-evals run triage --instance <id[,id2]> # only these exact instance_id(s), comma-separated (or set EVAL_INSTANCE)
lastlight-evals run pr-review --f-beta 0.5      # pr-review F-beta β (default 1=F1; 0.5=precision 2×). Or EVAL_F_BETA
lastlight-evals run pr-review --judge-with-diff # feed the PR diff to the judge (higher fidelity; off by default)
lastlight-evals run pr-review --sandbox gondolin # isolate the agent's tools in a QEMU micro-VM (anti-spoil). Or EVAL_SANDBOX
lastlight-evals run triage --no-open            # don't open the report
# Plain layout: add --overlay .   (e.g. lastlight-evals run triage --overlay .)

lastlight-evals serve                           # browse past runs in the dashboard (no models run)
lastlight-evals clean --dry-run                 # list killed/crashed runs that are stuck "running"
lastlight-evals clean                           # finalize them (mark interrupted; --delete to remove)
```

Each run lands in its own dir `./eval-results/<tiers>/<runId>/`: `scorecard.json`
+ `predictions.jsonl` (SWE-bench format). The report is a **JSON-driven dashboard
SPA**, not generated HTML — `run` starts a local server and opens it; browse every
past run later with `lastlight-evals serve`. In the dashboard a code-fix row's
**files** button opens the agent's captured diff and **log** shows the per-phase
agent session.

If a run is killed or crashes mid-flight it stays stuck showing "running" (its
scorecard never got its final write). `lastlight-evals clean` finalizes such runs
— marks them *interrupted* (default; keeps the partial scorecard + transcripts)
or `--delete` removes the run dir.

## 5. Author eval cases (optional)

Three tiers ship: **triage** (cheap, issue-triage), **code-fix** (heavy, build
workflow with held-out tests), and **pr-review** (PR-review precision, graded by
an LLM judge against a gold set → precision / recall / **F1** by default, the
F-beta configurable via `EVAL_F_BETA`). To add cases or
a custom tier, read **`references/instance-schema.md`** — it has the
`SweBenchInstance` schema, the exact files to create for each tier, and worked
examples.

Quick shape (paths are relative to the workspace's `evals/` dir):
- **Triage case:** append a `SweBenchInstance` to `evals/datasets/triage/instances.json`
  with `issue`, `triage_gold`, and `expect_github`.
- **Code-fix case:** add the instance to `evals/datasets/code-fix/instances.json` **and**
  create `evals/datasets/code-fix/repos/<instance_id>/` (fixture repo at base) +
  `evals/datasets/code-fix/tests/<instance_id>/` (held-out tests applied at grade time).
- **PR-review case:** a `SweBenchInstance` with a `pr` fixture (base/head refs +
  commits, checked out at the PR head) and a `review_gold` set (severity +
  description). The `pr-review` tier ships empty — populate the full Martian
  [Code Review Bench](https://codereview.withmartian.com/) 50 with
  `npx tsx scripts/import-martian.ts`. Grading needs a judge model
  (`EVAL_JUDGE_MODEL`, else a strong default per provider key).
- **Custom tier:** a new `evals/datasets/<tier>/` with `tier.json` +
  `instances.json` (+ `repos/` & `tests/` for code-fix-style tiers). Discovery is
  automatic — no code change.

## 6. Author a case from a real GitHub PR or issue

When the user says **"create an eval dataset/case from this PR/issue <url>"**, use
the `add-case` subcommand — it does the mechanical extraction; you refine the
fuzzy parts.

```bash
lastlight-evals add-case --pr <github-pr-url> --dry-run        # propose a code-fix case; don't write
lastlight-evals add-case --pr <github-pr-url>                  # write into ./datasets (or --datasets/--overlay)
lastlight-evals add-case --issue <github-issue-url> --dry-run  # propose a triage case
```

- **From a PR (code-fix):** derives `repo`, `base_commit` (merge-base of base &
  head) + `head_commit`, the PR's **test** diff as the held-out `test_patch`, and
  auto-detects `FAIL_TO_PASS` / `PASS_TO_PASS` by running the tests at base (red)
  vs head (green). Produces a **git-source** case (no `repos/<id>/` vendored): at
  run time the harness clones the repo into the gitignored `./.eval-cache/` and
  checks out `base_commit`.
- **From an issue (triage):** derives the `issue` seed + `problem_statement`, the
  **labels that were applied** (from the issue events API, with *who* applied each)
  → `expect_github.labels_added`, `issue_closed` if it was closed, and prints the
  **reviewer comments** — the raw triage signal. You then assign
  `triage_gold` (category/state) from those labels per the deployment's taxonomy.

The full flow, what you refine for each, the `test_cmd` / `setup_cmd` options for
non-`node --test` runners, and the trust/offline caveats are in
**`references/authoring-from-pr.md`** — read it before authoring.

## Done when

The workspace is scaffolded (Separate: overlay in `instance/`, evals at root;
Plain: self-overlay), `.env` has a working provider key, and a bare
`lastlight-evals run` produces a scorecard under `eval-results/`. Report the
workspace path, the layout used, the provider(s) configured, and the run/compare
command.
