---
name: lastlight-evals
description: Scaffold, configure and run a Last Light EVALS workspace — the harness that runs Last Light's real workflows against a mocked GitHub and grades them deterministically. Use when the user wants to "set up / scaffold Last Light Evals", "create an evals workspace or instance", "run evals", "compare models", or author new eval cases — including "create an eval dataset/case from this PR/issue <github url>" and "create a PR-review eval dataset from these gold PRs" (triage / code-fix / pr-review instances, via `add-case --pr <url> --review|--code-fix` / `--issue`). GitHub is mocked when running, so no real GitHub token is needed — only a model provider API key (the one exception is `add-case`, which reads real PRs/issues via `gh`).
version: 1.3.0
tags: [lastlight, evals, benchmark, models, swe-bench]
---

# Set up & run Last Light Evals

`lastlight-evals` runs Last Light's **real** production workflows (issue-triage,
build, …) end-to-end against a mocked GitHub, grades the results deterministically
(no LLM-as-judge), and compares models on pass rate, cost, and latency. It's a
thin CLI on top of the `lastlight` core package (via the `lastlight/evals`
barrel), so it exercises the same workflows/skills production does. SWE-bench
compatible. **Node 24+.**

## Start here — what do you want to do?

If the user's evals goal is clear, jump to the section. If it's vague ("help me
with the evals", "what can this do?"), **ask** (`AskUserQuestion`) which of these
they want, then go:

| Goal | Section |
|---|---|
| Set up an evals workspace (first time) | **§2 Scaffold** (+ §1 prereqs, §3 providers) |
| Run evals / compare models | **§4 Run** |
| Look at past runs (no models run) | **§4** — `lastlight-evals serve` |
| Author one case from a GitHub PR or issue | **§6** |
| **Build a PR-review dataset from my own gold PRs** | **§6 → "Build a PR-review dataset"** |
| Add cases by hand / understand the schema | **§5** + `references/instance-schema.md` |
| **Iteratively improve the score toward a target** | the **`lastlight-evals-loop`** skill |

New to the whole plugin (server / overlay / client, not just evals)? That's the
**`lastlight-guide`** skill — this one is evals-only.

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
lastlight-evals run pr-review --no-inject-context # DON'T inject synthetic repo-context into the checkout (clean A/B control)
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
  description). Populate the full Martian
  [Code Review Bench](https://codereview.withmartian.com/) 50 with
  `npx tsx scripts/import-martian.ts`, **or author your *own* gold-PR dataset**
  with `add-case --pr <url> --review` (see §6 and
  **`references/authoring-pr-review.md`**). Grading needs a judge model
  (`EVAL_JUDGE_MODEL`, else a strong default per provider key).
  - **Repo-context injection (pr-review).** The harness can drop a synthetic
    `AGENTS.md`/`CLAUDE.md` into the checked-out repo so the reviewing agent reads
    it — a **generic** block from `<overlay>/repo-context/AGENTS.md` (every repo)
    plus a **per-repo** block from `datasets/pr-review/context/<instance_id>/AGENTS.md`.
    Presence-based (just create the file), on by default; `--no-inject-context`
    (or `EVAL_INJECT_CONTEXT=0`) forces a clean control for an A/B. It appends to
    a real `AGENTS.md`/`CLAUDE.md` if the repo ships one (never shadowing it). This
    is how you prove *"adding this to your repo improves review quality"* — and the
    lever the **`lastlight-evals-loop`** skill drives.
- **Custom tier:** a new `evals/datasets/<tier>/` with `tier.json` +
  `instances.json` (+ `repos/` & `tests/` for code-fix-style tiers). Discovery is
  automatic — no code change.

## 6. Author a case from a real GitHub PR or issue

When the user says **"create an eval dataset/case from this PR/issue <url>"** or
**"create a PR-review eval dataset from these gold PRs"**, use the `add-case`
subcommand — it does the mechanical extraction; you refine the fuzzy parts.

A PR seeds two different evals, so `--pr` requires a kind — `--review` (the PR's
human review is the gold set) or `--code-fix` (hide the fix, the agent must
reproduce it):

```bash
lastlight-evals add-case --pr <github-pr-url> --review --dry-run    # propose a pr-review case; don't write
lastlight-evals add-case --pr <github-pr-url> --review              # write into ./datasets/pr-review (or --overlay)
lastlight-evals add-case --pr <github-pr-url> --code-fix --dry-run  # propose a code-fix case
lastlight-evals add-case --issue <github-issue-url> --dry-run       # propose a triage case
```

- **From a PR (pr-review):** derives the `pr` fixture (base/head refs + commits,
  from the PR's `baseRefOid`/`headRefOid`) and a **candidate `review_gold`** from
  the PR's *human* review — inline comments + substantive review bodies, with
  bot/nit/reply/outdated noise filtered out. Prints an evidence block; **you**
  assign real severities and prune non-actionable comments. Byte-compatible with
  `import-martian.ts`, so authored cases sit alongside imported ones. Leak-safe:
  the review lands only in `review_gold`, never in the seeded PR the agent sees.
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

### Build a PR-review dataset from gold PRs (interactive)

When the user says **"I want to create a PR-review eval dataset"** (from *their*
PRs, to track review quality as they evolve models/prompts):

1. **Get the PRs.** If they didn't paste URLs, **ask** for them — "give me the
   gold PR URL(s) — one or many, whose human review is the standard you want a
   model to reproduce." Also confirm *where* to write: the current workspace's
   `./datasets` (or `--overlay <dir>` for a deployment's own dataset).
2. **One PR at a time.** For each URL run
   `add-case --pr <url> --review --dry-run`, read the evidence block, then
   **curate** the candidate `review_gold` — set real severities and drop
   comments that aren't concrete findings — and write it
   (`add-case --pr <url> --review [--datasets/--overlay …]`). Re-running the same
   PR **replaces by id**, so curation is idempotent.
   - For **many** PRs, spawn a **curation sub-agent per PR** (each handed one URL
     + the target dir, returning the curated instance) so the judgement stays
     isolated and they run in parallel.
3. **Smoke-run** the new tier with the cheapest model to confirm the seed + judge
   plumbing (needs a judge-model key): `lastlight-evals run pr-review --limit 1 --model haiku`.

See **`references/authoring-pr-review.md`** for the full extract→curate→write
flow, the `--severity` / `--include-bots` knobs, and the anti-spoil guarantee.

The full flow, what you refine for each, the `test_cmd` / `setup_cmd` options for
non-`node --test` runners, and the trust/offline caveats are in
**`references/authoring-from-pr.md`** (PR code-fix + issue triage) and
**`references/authoring-pr-review.md`** (PR review) — read the relevant one
before authoring.

## Done when

The workspace is scaffolded (Separate: overlay in `instance/`, evals at root;
Plain: self-overlay), `.env` has a working provider key, and a bare
`lastlight-evals run` produces a scorecard under `eval-results/`. Report the
workspace path, the layout used, the provider(s) configured, and the run/compare
command.
