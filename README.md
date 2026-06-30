# lastlight-evals

### Which model should run your agent? Find out — with receipts.

[![Last Light eval scorecard — 9 models compared on pass rate, cost, and latency](docs/scorecard-v2.png)](https://evals.lastlight.dev/)

> **[▶ Explore the live scorecard](https://evals.lastlight.dev/)** — interactive, with per-instance detail. (Above: code-fix tier across 9 models.)

`lastlight-evals` takes [**Last Light**](https://lastlight.dev)'s *real*
production workflows — the actual prompts, skills, and agent loop that ship — and
runs them end to end against a fully mocked GitHub, for whatever models you throw
at it. No toy benchmarks, no LLM-as-judge: every run is graded **deterministically**
(did the agent apply the right labels? did the held-out tests turn green?), then
ranked side by side on **pass rate, cost, and latency**.

The payoff is one scorecard that tells you, for *your* workflows, exactly what
each model delivers — and what it costs you per run. Swap a model, re-run, see the
difference. Drop in your own issues and repos and it evaluates *your* agent.

> 🛰️ Part of [**Last Light**](https://lastlight.dev) — the AI agent that triages,
> reviews, and fixes your GitHub repos.
> **[lastlight.dev](https://lastlight.dev)** · [Core repo](https://github.com/cliftonc/lastlight) · [Eval repo](https://github.com/cliftonc/lastlight-evals)

It's **SWE-bench-compatible**, and nothing here touches real GitHub: the agent's
`github_*` tool calls are served by an in-process fake (seeded + recording) and
`git push` goes to a local bare repo. The only deviations from production are the
two we can't do unattended — approval gates are disabled and outward side-effects
are mocked. Everything else is exactly what ships.

```
instance (SWE-bench shape)
   │
   ├─ start fake GitHub (seeded with the issue, records every mutation)
   ├─ (code-fix) seed workspace: fixture repo @ base_commit + local bare origin
   ├─ load the REAL workflow YAML (issue-triage / build / …) from lastlight core
   ├─ runWorkflow(sandbox:"none", githubApiBaseUrl→fake, approvalConfig:{})
   └─ grade:
        • execution  — apply held-out tests, run them → FAIL_TO_PASS / PASS_TO_PASS
        • behavioral — recorded GitHub calls vs the instance's expectations
```

> Working on the harness itself? See `CLAUDE.md` for the seams and invariants
> (the base-URL mock, static-token mode, the no-clone seeding trick, the
> asset-bootstrap footgun, the metrics drain).

## Get started

Needs **Node 24+** and a provider API key.

### Easiest: let the Last Light agent skill set up *your own* workspace

Want to eval **your own** deployment — your workflows, your agent persona, your
config — not just the shipped samples? If you drive
[Last Light](https://lastlight.dev) from an agent (e.g. Claude Code), install its
skills once and then just *ask* — no flags to remember:

```bash
lastlight skills install            # installs the Last Light agent skills
```

Then, in a **new empty folder**, tell your agent (point it at *your* instance
overlay repo):

> *Let's set up an evals workspace here, using my existing Last Light instance
> config in `cliftonc/lastlight-instance`.*

The `lastlight-evals` skill scaffolds the workspace, clones your overlay into
`instance/`, seeds the sample datasets, and wires it all up — under the hood it
runs `lastlight-evals init . --clone cliftonc/lastlight-instance`, after which a
bare `lastlight-evals run` "just works" (it auto-detects `./instance` as the
overlay and `./evals/datasets`). Now you're evaluating *your* agent against the
models you care about. Prefer to drive it by hand? Keep reading.

> The skill itself lives in a separate repo — it's bundled in the **`lastlight`
> plugin** ([`cliftonc/lastlight`](https://github.com/cliftonc/lastlight), under
> `plugins/lastlight/skills/lastlight-evals/`) and tracks this CLI's `init` /
> `run` surface, so the two are kept in sync.

### Manual: scaffold with `init`

The fastest CLI path is **`init`** — it scaffolds *your own* evals workspace
(your workflows + your datasets, seeded from the built-in samples) and optionally
creates a private GitHub repo for it:

```bash
npm install -g lastlight-evals
export OPENAI_API_KEY=...                # or ANTHROPIC_ / FIREWORKS_ / OPENROUTER_

# 1. Scaffold your workspace (offers to `git init` + `gh repo create`).
lastlight-evals init my-evals
cd my-evals

# 2. Run it — drives the real workflows against your datasets, prints a scorecard.
lastlight-evals run --overlay .
```

That's the loop: edit `evals/datasets/` with your own issues/repos (and
`workflows/` with your own workflows), then re-run. `init` gives you a
self-contained, version-controllable repo that **shadows** the built-in
workflows/skills and datasets by name — see [overlays](#your-own-workflows--datasets-overlays)
and the [configuration docs](https://lastlight.dev/docs/configuration/).

**Just kicking the tires?** Skip `init` and run the shipped samples directly:

```bash
npm install -g lastlight-evals
lastlight-evals run triage               # or: npx lastlight-evals run triage
```

> Installing pulls in `lastlight` (and `agentic-pi`). `lastlight-evals` is a thin
> CLI on the `lastlight` package — it runs core's published `workflows/`,
> `skills/`, and `agent-context/`, so the evals exercise the **exact same assets
> production does**.

### Configuration (`.env`)

The only thing you must provide is a **model provider key**. Set it in the
environment, or drop a `.env` file in the directory you run from (the runner
loads it automatically — KEY=VALUE lines, no quotes needed):

```bash
# .env — at least ONE of these. Set keys only for the providers you want to eval.
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
FIREWORKS_API_KEY=fw-...          # GLM / DeepSeek / GPT-OSS (open models)
OPENROUTER_API_KEY=sk-or-...
```

- The default run uses one model (`default` in `models.json`); `--compare` fans
  out across the `compare` set, **running only the models whose key is present**
  — so set the keys for the providers you care about and the rest are skipped.
- **No GitHub credentials are needed** — GitHub is mocked end to end. The harness
  sets a dummy `GITHUB_TOKEN` internally; don't put a real one in `.env`.
- An `init`-scaffolded repo already gitignores `.env`, so your keys never get
  committed.

## What a run does

Each eval `instance` (an issue fixture, optionally with a code fixture + held-out
tests) is taken through the **real** production workflow end to end:

1. An **in-process fake GitHub** starts, seeded with the issue and recording
   every mutating call the agent makes.
2. For `code-fix`, the **workspace is seeded** with the fixture repo at its base
   commit plus a local bare `origin`, so `git push` works fully offline.
3. The **real workflow YAML** (`issue-triage`, `build`, …) is loaded from
   `lastlight` and run with `sandbox:"none"`, the agent's `github_*` tools
   pointed at the fake, and approval gates disabled (so it never pauses).
4. The result is **graded deterministically** — no LLM judge:
   - **behavioral** — the recorded GitHub calls (labels, comments, PRs) vs the
     instance's `expect_github` / `triage_gold`.
   - **execution** (code-fix) — the held-out tests are applied and run; the case
     is *resolved* only if every `FAIL_TO_PASS` passes and every `PASS_TO_PASS`
     stays green (SWE-bench's criterion).
5. Token usage, cost, and latency are collected per run.

Run multiple models and you get a side-by-side **scorecard** (HTML + JSON)
ranking them on pass rate, cost, and latency.

## Run it

```bash
# no tier args → interactively pick which tiers to run (one or all).
# Non-interactive (CI / piped) falls back to the cheapest default.
lastlight-evals run

# name tiers explicitly to skip the prompt
lastlight-evals run triage
lastlight-evals run code-fix            # the full build cycle (heavy)
lastlight-evals run triage code-fix     # both → combined tabbed report

# cross-vendor comparison (OpenAI + Anthropic + open source) — see models.json.
# Families run in PARALLEL; serial within a family. Force serial with --serial.
lastlight-evals run --compare

# pick ONE model (fuzzy-matched against models.json id/label)
lastlight-evals run triage --model haiku
lastlight-evals run triage --model glm,deepseek   # a comma-list also works

# repeat each case N times; verdicts WORST-case, cost/tokens/latency MEAN
lastlight-evals run triage --runs 3

# run against an overlay repo's OWN workflows + datasets (see below)
lastlight-evals run --overlay ~/work/lastlight-instance

# add your own datasets dir without an overlay
lastlight-evals run --datasets ~/my-evals/datasets

# CONFIG run type — eval a deployment's REAL per-step model config (different
# models per workflow phase, from the overlay's config.yaml) instead of forcing
# one model. This is the setup you actually ship. Try the bundled sample overlay:
lastlight-evals run code-fix --mode config --overlay examples/overlay
lastlight-evals run code-fix --mode config --overlay A --overlay B   # 2 configs side-by-side

# ad-hoc model set / focus one instance / no browser
EVAL_MODELS="openai/gpt-5.5,anthropic/claude-sonnet-4-6" lastlight-evals run
EVAL_INSTANCE=off-by-one lastlight-evals run code-fix
lastlight-evals run triage --no-open
```

The report is a **JSON-driven dashboard**, not generated HTML — the harness only
ever writes `scorecard.json`, updating it (atomically) as the run proceeds. The
runner starts a tiny local server and opens `http://localhost:PORT` deep-linked
at the run, so you watch the scorecard fill in live (the SPA polls the JSON).
When the run finishes the server stays up so the dashboard keeps working — press
`Ctrl-C` to stop it. Each run lands in its **own** timestamped folder, so runs
accumulate instead of overwriting — `./eval-results/<tiers>/<runId>/` (override
the root with `LASTLIGHT_EVALS_OUT`), where `runId` is `<timestamp>-<git-sha>`:

- `scorecard.json` — structured roll-up per model + per-instance results, carrying run `meta`.
- `predictions.jsonl` — SWE-bench predictions shape.

The dashboard's **overview** lists every run newest-first with a per-model trend
sparkline and links into each run's full scorecard; the **run view** is the
model-comparison table plus per-instance rows. To browse past runs anytime
without running models, start the server on its own:

```bash
lastlight-evals serve            # opens the dashboard over ./eval-results
lastlight-evals serve --port 4319
```

Needs a provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
`FIREWORKS_API_KEY` / `OPENROUTER_API_KEY`) in the environment or a cwd `.env`.
The runner exits non-zero **only** if the harness itself errors — a weak model
scoring poorly is the measurement, not a build failure.

### Two run types

A run compares N **arms** along one of two axes — pick with `--mode` (or, in a
TTY with no model flags, you're asked):

- **`models`** (default) — compare models, each **forced across every workflow
  step**. `--model`/`--compare` select the set. Lands in `eval-results/<tier>/`
  (or `<tier>-compare/`).
- **`config`** (`--mode config`) — run a deployment's **real per-step model
  config**: the `models`/`variants` maps from an overlay's `config.yaml`, merged
  over core's `config/default.yaml` exactly as production does, so each phase can
  run on a different model. The arm is the config/overlay; pass `--overlay` more
  than once to compare configs side-by-side, or re-run over time to compare as
  you tweak prompts/skills/workflow/model-config. `--model` overrides a config's
  `default` for quick what-ifs. Lands in `eval-results/<tier>-config/`, on its
  own trend line. The run view shows a **Per-step models** panel with each
  phase's resolved model. See [`examples/overlay`](examples/overlay) for a
  ready-to-run sample.

## Your own workflows + datasets (overlays)

An **overlay** is a directory (often its own repo, like `lastlight-instance`)
that carries its own `workflows/` / `skills/` / `agent-context/` (which shadow
the core built-ins by name) and its own `evals/datasets/`. It's the same
deployment-overlay mechanism the production harness uses — see the [Last Light
configuration docs](https://lastlight.dev/docs/configuration/) for the full
story. One flag wires both:

```bash
lastlight-evals run --overlay ~/work/lastlight-instance     # or LASTLIGHT_OVERLAY_DIR
```

- Overlay **workflows/skills** are layered over core via core's [asset
  overlay](https://lastlight.dev/docs/configuration/) (same mechanism the
  production harness uses).
- Overlay **datasets** are discovered at `<overlay>/evals/datasets/<tier>/`, and
  shadow built-in tiers of the same name.
- An overlay **`evals/models.json`** is picked up automatically (or pass
  `--models-file`).

### `lastlight-evals init [dir]` — scaffold an evals workspace

Two shapes, depending on whether you already have a deployment overlay repo:

**Plain** — a self-contained overlay+evals repo (its own `workflows/` `skills/`
`agent-context/` + `evals/`):

```bash
lastlight-evals init my-evals
cd my-evals && lastlight-evals run --overlay .
```

Scaffolds `workflows/` `skills/` `agent-context/` (empty, to fill in),
`evals/datasets/` + `evals/models.json` (seeded from the shipped samples),
`config.yaml`, and a `.gitignore`/`README`, then offers to `git init` + create a
private GitHub repo via `gh` (reusing core's `lastlight server setup` flow).

**Separate** (`--clone`) — the recommended shape when you already have a
deployment overlay (e.g. `lastlight-instance`) and want to eval **its** config.
The overlay is cloned into `<dir>/instance/` (its own git checkout, git-ignored)
with the evals at the workspace root; a bare run auto-detects both, no flags:

```bash
lastlight-evals init my-evals --clone cliftonc/lastlight-instance
cd my-evals && lastlight-evals run        # auto: overlay ./instance + ./evals/datasets
```

This is exactly what the [`lastlight-evals` agent skill](#easiest-let-the-last-light-agent-skill-set-up-your-own-workspace)
does for you. Update the overlay later with `cd instance && git pull`; your evals
stay out of the deployment repo. Run `lastlight-evals init --help` for all flags
(`--yes`, `--no-git`, …).

## Datasets & tiers

A **tier** is a directory containing `instances.json` (+ an optional `tier.json`
declaring its `defaultWorkflow`). Tiers are discovered from three roots, merged
by name with **overlay > user (`--datasets`) > built-in** precedence:

- **built-in** (shipped here): `triage` → `issue-triage`, `code-fix` → `build`.
- **user**: `--datasets <dir>` / `LASTLIGHT_EVALS_DATASETS`.
- **overlay**: `<overlay>/evals/datasets/*`.

### Add a case

**Triage** — append to a tier's `instances.json`:

```json
{
  "instance_id": "triage__my-case",
  "repo": "lastlight-evals/widget",
  "workflow": "issue-triage",
  "problem_statement": "short title",
  "issue": { "number": 110, "title": "…", "body": "…", "labels": [] },
  "triage_gold": { "category": "bug", "state": "ready-for-agent" },
  "expect_github": { "labels_added": ["bug"] }
}
```

**Code-fix** — three things keyed by `instance_id`, all under the tier dir:

```
<tier>/instances.json     # the SweBenchInstance (FAIL_TO_PASS / PASS_TO_PASS)
<tier>/repos/<id>/        # fixture repo at base_commit (NO held-out tests)
<tier>/tests/<id>/        # held-out test files, copied in at grade time
```

A new tier just needs a directory with an `instances.json` and a `tier.json`
(`{ "name", "defaultWorkflow", "description" }`); per-instance `workflow` wins
when present.

## Models (`models.json`)

- `default` — the single model `run` uses.
- `compare` — the cross-vendor set `--compare` fans out over. Each entry has an
  `id` (the agentic-pi/pi-ai `provider/model` spec), a `label`, and an `envKey`.
  **An entry only runs if its `envKey` is present**, so the compare set
  auto-trims to whatever keys you have.

## Roadmap

- **`lastlight-evals extract <owner>/<repo>#<n>`** — generate eval cases from
  GitHub historical issues/PRs (issue → fixture, merged PR → held-out tests).
- Docker-backed runs; real SWE-bench Lite ingestion; per-fixture test runners.
- LLM-as-judge stays out by design — grading is deterministic.
