# 07 — Runtimes in the evals harness (comparing harnesses)

> **2026-10-05: the gate changed.** Runtime choice is a team decision, so a
> runtime is gated on **conformance**, not on beating agentic-pi. Human grades
> (first) and cost are reported per runtime in the evals dashboard but never
> block ([README](README.md) decision 15). Claude runs "as itself" within the
> parity contracts (decision 12). The arm-axis and fairness mechanics below
> still apply; runtime ids are `pi|claude|codex|opencode`.

**Goal:** answer "is Claude Code (or Codex, or OpenCode) a better harness than
agentic-pi for this workflow, on this model?" with the same rigour we already
apply to models: same cases, same mock, same graders, repeat bands, human
grades first.

This is a **gate**, not a follow-up. A runtime isn't done until it can be put
in an arm (see [`08-rollout.md`](08-rollout.md)).

## Worked example

```bash
# Harness comparison: one model, two runtimes, a ranking-grade band
lastlight-evals run pr-review --model sonnet --runtime agentic-pi,claude-code --repeats 4

# Model × runtime grid
lastlight-evals run triage --model sonnet,gpt-5.5 --runtime agentic-pi,claude-code,codex

# A deployment's real per-phase config, with its runtimes: map
lastlight-evals run pr-review --mode config --overlay ./overlays/claude-review

# Phase replay on another harness
npx tsx scripts/micro-site-review.ts --runtime claude-code --model sonnet …
```

## 1. The arm axis

`Arm` (`apps/evals/src/arm.ts`) varies only model selection today. Runtime
joins it.

- `PreparedModels` gains `runtime?: string` (forced, `models` arms) and
  `runtimes?: Record<string, string>` (per-task map, `config` arms).
  `run-instance.ts:589-601` threads them onto `ExecutorConfig` /
  `runWorkflow`, the same way `model` / `models` / `variants` are threaded
  today.
- `modelsArm(id, family, overlayDir, runtime?)`. The label becomes
  `claude-code · anthropic/claude-sonnet-5` when a runtime is set, and stays
  the bare model id for agentic-pi so existing trend lines don't break.
- `configArm` reads the overlay's merged `runtimes:` map (`config.ts`
  `loadMergedConfig`), and `recordPhaseModel` gains a sibling
  `recordPhaseRuntime`.
- `run.ts`: a new `--runtime a[,b]` value flag (`VALUE_FLAGS`, `run.ts:229`)
  plus `EVAL_RUNTIME`. With `--model`, it builds the model × runtime **cross
  product** of arms.
- `family` stays the provider env key, so rate-limit grouping and
  across-family concurrency are unchanged.
- The CLI surface change **updates the `lastlight-evals` skill in the same
  change** (evals CLAUDE.md rule; the `check-cli-skill.sh` hook will nudge).

## 2. Running on `--sandbox none` (the evals default)

- ACP runtimes run as a **host child** through the bridge, with cwd threaded
  per run and no `process.chdir`, so `--concurrency` stays safe. They also get
  a real kill timer, which agentic-pi's in-process `run()` lacks.
- Adapters come from the bridge's exact-pinned deps via `pnpm install`. Never
  from global installs, and never from whatever `claude` is on the operator's
  PATH.
- **An isolated per-run config home is mandatory.** Without it, the operator's
  `~/.claude` / `~/.codex` skills, hooks and settings contaminate every arm.
  This is the same failure as the 69/69 ambient-skills sessions. The
  conformance suite asserts it with a canary skill planted in a fake HOME.
- `--sandbox gondolin` + an ACP runtime is refused up front.
- `--sandbox docker` arms work too, with the existing caveat that docker does
  not honour `githubApiBaseUrl` (unchanged by this design).

## 3. Mock parity (fake GitHub)

- The bridge's MCP server takes `--api-base-url` → `fake.url`, exactly the seam
  agentic-pi's built-in tools use today.
- Static-token mode (`GITHUB_TOKEN=eval-fake-token`, App vars unset,
  `applyEvalEnv`) flows into the MCP server through `session/new`'s `env`.
- Profile gating comes from the same `PROFILE_TOOLS`, so an arm on any runtime
  sees the same tool set.
- `src/mechanism.test.ts` gains an **AI-free case per runtime**: a scripted
  fake ACP agent (in the spirit of Fabro's `fake_acp_agent.py`) calls a
  `github_*` tool over MCP, and the test asserts that fake-github recorded the
  mutation. That keeps the mock plumbing guarded in the default `npm test` with
  zero spend.

## 4. Metric parity

- `metrics.ts:297-326` reads `total_cost_usd` and token totals from the shim's
  `result` envelope. **The shim must write that envelope for every runtime.**
  It does, because the shim consumes `AgentEvent` (see
  [`03`](03-runtime-seam.md)).
- New envelope field `cost_source: runtime | estimated`. The existing
  `models.json` per-million imputation stays as the last fallback, and the
  scorecard shows which source each arm's cost came from.
- **Turns:** ACP turns are synthesized (`turnsSynthesized`), so scorecards
  label turn counts as not comparable across runtimes.
- **Tool calls:** counted on canonical names, so `scripts/phase-turns.ts` and
  bash-call counts compare cleanly.
- **Per-phase attribution** (the `phase` stamp on envelopes,
  `bucketSessionsByPhase`) is unchanged.
- The **`drainSessions()` before `collectMetrics()`** gotcha still applies:
  the bridge's final envelope is written the same way.

## 5. Provenance

Scorecard `meta` (`RunProvenance`, `src/report.ts:106`) adds:

- `runtime` (or a per-phase `runtimes` map);
- `adapter` package + version;
- agent version (from `session.started.runtimeVersion`);
- bridge version.

A harness comparison is only reproducible if the adapter version is pinned and
recorded. A run that silently used the wrong runtime must be contradictable
from its artifact. That is the "baseline reported as the pipeline arm" lesson.

## 6. Phase-replay scripts

`src/phase-replay-node.ts:247` imports agentic-pi's `run()` directly. Replace
it with a runtime-agnostic entry exported from the **`lastlight/evals` barrel**
(`apps/server/src/evals-api.ts`). It must never be a deep path:

```ts
runAgentOnce(runtime: string, spec: AgentRunSpec,
             onEvent: (e: AgentEvent) => void): Promise<AgentRunSummary>
```

`micro-falsify`, `micro-site-review` and `micro-select` then gain `--runtime`,
which makes the cheap single-phase replays the first place to compare harnesses
(cents per case instead of a full pipeline).

## 7. Fairness contract

Every arm in a harness comparison gets identical:

- workflow YAML, prompts and skills;
- AGENTS.md context;
- tool set (via MCP);
- command policy;
- model and thinking level;
- fake GitHub state.

**Neutralized on purpose** (otherwise they confound the comparison):

- ambient user config and skills;
- runtime-native web tools (unless the phase enables web search);
- repo-committed `.claude/` hooks and settings.

**Deliberately left native** (they *are* the harness under test):

- the runtime's system prompt and built-in tools (read / edit / grep);
- context compaction;
- planning behaviour.

Known capability gaps (e.g. Codex blocks without a reason) are attached to the
arm as **scorecard caveats**, computed from the runtime's capability flags, so
nobody reads a policy-induced loss as a harness loss.

## 8. Dashboard (must ship in the serve UI, same change)

- A runtime column and badge in `CompareTable` / `RunView`, and on the run
  index cards (`Overview`).
- `MetaStrip` shows runtime, adapter version and `cost_source`.
- The trend line is keyed on the arm label, so `claude-code · sonnet` gets its
  own line.
- `SessionModal` / transcripts render unchanged, because it's the same envelope
  format.
- The phase-replay page shows the runtime per report.

## 9. Measurement discipline

- **`--repeats ≥ 4`** for any ranking (two repeats can't order two arms; see the
  2026-08-25 twelve-arm ladder).
- Score on **human grades first** (`#/grade`, `gradedMetrics`), then judge gold
  (skillspro). Martian is held out.
- **The spend gate holds.** The free mechanism tests and conformance suite go
  green before any paid arm. Cheap phase-replay comparisons come before
  full-pipeline bands.
- Always `--keep-workspace` on comparison bands, so disagreements can be
  traced to evidence.
