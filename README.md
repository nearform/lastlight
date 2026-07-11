# lastlight-evals

### Which model should run your agent? Find out — with receipts.

[![Last Light eval scorecard — 9 models compared on pass rate, cost, and latency](docs/scorecard-v2.png)](https://evals.lastlight.dev/)

> **[▶ Explore the live scorecard](https://evals.lastlight.dev/)** — interactive, with per-instance detail. (Above: code-fix tier across 9 models.)

`lastlight-evals` takes [**Last Light**](https://lastlight.dev)'s *real*
production workflows — the actual prompts, skills, and agent loop that ship — and
runs them end to end against a fully mocked GitHub, for whatever models you throw
at it. No toy benchmarks: grading is **deterministic** by default (did the agent
apply the right labels? did the held-out tests turn green?) — with one scoped
LLM-judge for the `pr-review` tier's precision/recall/F-beta (F1 by default) — then ranked side by
side on **pass/score rate, cost, and latency**.

The payoff is one scorecard that tells you, for *your* workflows, exactly what
each model delivers — and what it costs you per run. Swap a model, re-run, see the
difference. Drop in your own issues and repos and it evaluates *your* agent.

> 🛰️ Part of [**Last Light**](https://lastlight.dev) — the AI agent that triages,
> reviews, and fixes your GitHub repos.
> **[lastlight.dev](https://lastlight.dev)** · [Core repo](https://github.com/nearform/lastlight) · [Eval repo](https://github.com/nearform/lastlight-evals)

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
> plugin** ([`nearform/lastlight`](https://github.com/nearform/lastlight), under
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
   `lastlight` and run with `sandbox:"none"` by default (in-process), the agent's
   `github_*` tools pointed at the fake, and approval gates disabled (so it never
   pauses). Pass `--sandbox gondolin` to isolate the agent's bash/file tools in a
   QEMU micro-VM (see [Isolation](#isolation---sandbox) below).
4. The result is **graded deterministically** (with one scoped judge for
   pr-review):
   - **behavioral** — the recorded GitHub calls (labels, comments, PRs) vs the
     instance's `expect_github` / `triage_gold`.
   - **execution** (code-fix) — the held-out tests are applied and run; the case
     is *resolved* only if every `FAIL_TO_PASS` passes and every `PASS_TO_PASS`
     stays green (SWE-bench's criterion).
   - **review** (pr-review) — the posted review is matched to a human-verified
     gold set by an **LLM judge** → precision / recall / **F-beta** (F1 by default,
     Martian's leaderboard metric; `EVAL_F_BETA` reweights). The one,
     deliberately-scoped exception; triage/code-fix stay judge-free.
5. Token usage, cost, and latency are collected per run.

Run multiple models and you get a side-by-side **scorecard** (HTML + JSON)
ranking them on pass rate, cost, and latency.

### Isolation (`--sandbox`)

By default the agent runs **in-process** (`sandbox:"none"`) — fast and CI-friendly,
but with **no filesystem restriction**: the agent process can read any absolute
path, including this repo's held-out gold data (`datasets/<tier>/tests/`,
`instances.json`, `.eval-cache/`). A capable model that explores the disk could
find and spoil the answer key.

`--sandbox gondolin` (or `EVAL_SANDBOX=gondolin`) closes that gap: the agent's
bash/file tools execute inside a **QEMU micro-VM** that only sees its own
workspace, so host gold paths are invisible. The agent runtime and `github_*`
tools stay in-process, so the fake-GitHub mock still works unchanged — this is
why gondolin, and not `docker`, is the supported isolation backend (`docker`/`smol`
run the *whole* agent in the container/VM, where the in-process fake GitHub isn't
reachable).

Gondolin needs QEMU with hardware acceleration and runs **natively** (macOS via
Apple's Hypervisor.framework, Linux via KVM) — install it with `brew install qemu`
(macOS) or your distro's `qemu-system` package. It does **not** work inside a
container on macOS (no `/dev/kvm`, and the failure is a silent hang), so the
harness runs a fail-fast preflight and aborts with guidance rather than wedging.
Expect a one-time ~13s VM cold start plus per-tool-call overhead, so keep
`--sandbox gondolin` for trustworthy/anti-spoil runs and leave the default `none`
for quick iteration.

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

# isolate the agent's tools in a QEMU micro-VM so it can't read host gold data
# (anti-spoil; needs QEMU natively — see "Isolation" above). Default is none.
lastlight-evals run pr-review --sandbox gondolin

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

- **built-in** (shipped here): `triage` → `issue-triage`, `code-fix` → `build`,
  `pr-review` → `pr-review` (ships empty — populate with
  `scripts/import-martian.ts`; see [PR-review tier](#pr-review-tier-code-review-bench)
  below and `datasets/pr-review/README.md`).
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

Or scaffold one from a **real, resolved issue** — its content, the labels that were
applied (with who applied them), and reviewer comments become the gold case:

```bash
lastlight-evals add-case --issue https://github.com/owner/repo/issues/42 --dry-run
```

It seeds the issue *without* its triage labels (so the agent triages fresh), sets
`expect_github.labels_added` to the applied labels (+ `issue_closed` if it was
closed), and prints the labels/comments as evidence; you then assign
`triage_gold` (category/state) per your deployment's taxonomy.

**Code-fix (vendored fixture)** — three things keyed by `instance_id`, all under
the tier dir:

```
<tier>/instances.json     # the SweBenchInstance (FAIL_TO_PASS / PASS_TO_PASS)
<tier>/repos/<id>/        # fixture repo at base_commit (NO held-out tests)
<tier>/tests/<id>/        # held-out test files, copied in at grade time
```

**Code-fix from a real PR (git-source)** — point the CLI at a merged PR instead
of hand-building a fixture:

```bash
lastlight-evals add-case --pr https://github.com/owner/repo/pull/123 --dry-run
```

It reads the PR with `gh`, computes `base_commit` (the merge-base of the base
branch and the PR head) + `head_commit`, captures the PR's **test** diff as the
held-out `test_patch`, and — unless `--no-validate` — runs the tests at base
(red) vs head (green) to fill `FAIL_TO_PASS` / `PASS_TO_PASS`. Drop `--dry-run`
to write it (to `--datasets <dir>` / `--overlay <dir>`, else `./datasets`). No
`repos/<id>/` is vendored: at run time the harness clones the repo into the
gitignored `./.eval-cache/` and checks out `base_commit`. Non-`node --test`
runners work via `--test-cmd "<cmd>"` (+ `--setup-cmd "<cmd>"`), graded on the
test command's exit code (suite mode) when it emits no TAP names. The repo's
tests run real code — only use trusted repos.

A new tier just needs a directory with an `instances.json` and a `tier.json`
(`{ "name", "defaultWorkflow", "description" }`); per-instance `workflow` wins
when present.

## PR-review tier (Code Review Bench)

The **`pr-review`** tier measures review *quality* against
[Martian's Code Review Bench](https://github.com/withmartian/code-review-benchmark):
the review the real `pr-review` workflow posts is scored against a human-verified
**gold set** of the issues a reviewer should have caught. It's the **one** tier
graded by an LLM judge — matching free-text findings to semantic gold comments
can't be done deterministically — so triage and code-fix stay judge-free.

**Cases** come from Martian's *offline* set — 50 real merged PRs across Sentry,
Grafana, Cal.com, Discourse, and Keycloak, each carrying inlined `golden_comments`.
They ship **empty** (`datasets/pr-review/instances.json` is `[]`) because they're
large real-repo PRs — *generated*, not vendored:

```bash
npx tsx scripts/import-martian.ts            # resolve all 50 via gh (pins base/head SHAs)
npx tsx scripts/import-martian.ts --limit 3  # a quick subset first
```

**Seeding** clones the real repo into the gitignored `./.eval-cache/` and checks
out the PR **head** (mirroring production's pre-clone contract), so the skill's
`git diff origin/<base>...HEAD` works fully offline — no fixture is vendored.

**Grading** (`gradeReview`, `src/grade.ts`) is a two-step LLM judge:

1. **Extract** the review's distinct, concrete findings (drop praise/summaries).
2. **Match** each finding to a gold comment ("same underlying issue?").

From the matches: **precision** = matched ÷ posted, **recall** = matched ÷ gold,
combined as **F-beta**. The headline is **F1** (β=1 — precision and recall weighted
equally, Martian's leaderboard metric). Pass **`--f-beta 0.5`** (or `EVAL_F_BETA=0.5`)
to weight precision 2× (F0.5), mirroring Martian's adjustable F-beta; the dashboard
relabels itself `F{β}` to match.

> **Gold-set caveat.** Martian's own methodology documents the gold set as
> *incomplete* — it caps at human performance, so a real issue the annotators
> missed is scored as a false positive. That understates precision, which is why
> the default is F1, not the precision-weighted F0.5. Treat the score as a
> **relative** signal and inspect each match with the dashboard's **judge** button.

**The judge model is independent** of the models under test — a strong default per
your provider key (`EVAL_JUDGE_MODEL` overrides). A judge failure marks the case
*errored* (ungraded), never a silent zero. Alongside the judge score, a cheap
deterministic `review_submitted` proxy checks a review was actually posted.

**Diff-blind by default.** The judge sees only the posted review (body + inline
comments) matched against the gold set — *not* the PR diff — mirroring Martian's
offline judge. This can penalize terse, location-anchored comments (`off-by-one
here` on a line the judge can't see). Pass **`--judge-with-diff`** to feed the PR
diff into the judge for higher-fidelity matching (the judge is instructed never to
invent findings from the diff); this trades away leaderboard parity, and the
dashboard marks such grades **`diff-aware`**.

**Run it** (heavy — clones real repos + calls the judge):

```bash
lastlight-evals run pr-review --model <model>            # full tier
lastlight-evals run pr-review --model <model> --limit 3  # first 3 cases (controlled)
lastlight-evals run pr-review --model <model> --f-beta 0.5        # weight precision 2×
lastlight-evals run pr-review --model <model> --judge-with-diff   # give the judge the diff
```

In the dashboard, each row's **judge** button opens the judge's working — the
findings it extracted, the gold set, the finding↔gold pairing (matched / false
positive / missed), and its raw replies — so the F1 score is inspectable, not a
black box.

## Improving an eval — the loop (`lastlight-evals-loop`)

Running an eval gives you a score; the **improvement loop** raises it *without
gaming it*. It's driven by the sibling **`lastlight-evals-loop`** skill (say
*"raise the pr-review F1"*) and two read-only helpers in `scripts/`. The method —
**mine the failures → propose a few minimal candidate fixes → keep the one that
survives a blind held-out gate** — follows
[*Self-Harness: Harnesses That Improve Themselves*](https://arxiv.org/abs/2606.09498),
adapted to keep the anti-gaming discipline below.

One round:

1. **Diagnose (mine).** `scripts/mine-failures.ts` reads the **TRAIN** split of a
   scorecard and clusters the judge's `falseNegatives` (recall loss, weighted by
   severity) and `falsePositives` (precision loss) into a **ranked signature
   bundle** — the systematic patterns, ordered by F1 headroom, instead of reading
   traces by hand.

   ```bash
   npx tsx scripts/mine-failures.ts <train-scorecard>.json --train <train-ids> --keywords
   ```

2. **Propose.** Draft a few (K=2–4) **minimal, diverse** candidate edits for the
   top pattern — lowest lever first: a generic overlay prompt/skill/persona edit,
   or a synthetic `AGENTS.md` injected into the checkout. Never a core change.
3. **Select on TRAIN, confirm on HELD-OUT once.** Rank candidates on the train
   split, then give the single winner **one** blind held-out confirmation (gating
   every candidate on held-out would inflate it). `scripts/diff-runs.ts` computes
   the keep/revert verdict:

   ```bash
   npx tsx scripts/diff-runs.ts <baseline>.json <winner>.json \
       --train <train-ids> --heldout <heldout-ids>
   # VERDICT: KEEP — train ↑ and held-out held  (or REVERT — OVERFIT: held-out regressed)
   # --symmetric swaps in the paper's non-regressive gate (neither split may regress).
   ```

4. **Keep one, journal, repeat** until a target F1 or a plateau.

**What keeps it honest:** a fixed **train / blind held-out** split (the empirical
gate), **one change kept per round** (attribution), an adversarial **generality +
leak auditor** that rejects any edit naming a specific repo/file or encoding the
gold answer, and **generic-first** levers — core is never touched. The loop
produces two durable outputs: workflow improvements (better prompts/skills for
every repo) and per-repo recommendations (context a maintainer can commit), each
backed by a measured held-out lift.

## Models (`models.json`)

- `default` — the single model `run` uses.
- `compare` — the cross-vendor set `--compare` fans out over. Each entry has an
  `id` (the agentic-pi/pi-ai `provider/model` spec), a `label`, and an `envKey`.
  **An entry only runs if its `envKey` is present**, so the compare set
  auto-trims to whatever keys you have.

## Roadmap

- **`lastlight-evals extract <owner>/<repo>#<n>`** — generate eval cases from
  GitHub historical issues/PRs (issue → fixture, merged PR → held-out tests).
- Docker-backed sandboxed runs (needs the fake GitHub reachable from inside the
  container — `--sandbox gondolin` already gives native isolation today); real
  SWE-bench Lite ingestion; per-fixture test runners.
- LLM-as-judge stays out by design — grading is deterministic.
