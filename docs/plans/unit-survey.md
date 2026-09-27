# Unit survey — per-unit, single-shot survey (perch-style)

Status: **in flight on `feat/unit-survey`, unmeasured.** Nothing here is a
default until the eval A/B (below) says so.

## Why

The pr-review survey is a five-branch agent fan-out (contract, enforcement,
security, state, spec). It is ~75% of case spend and ~90% of branch-seconds.
Each branch is an agent session that spends minutes re-deriving, with bash,
context that `facts`/`seed` already computed. Its wall clock is the slowest
branch, and on gondolin/smol/kubernetes the branches run serially.

[perch](https://github.com/lakeday-org/perch) shows a faster shape:
deterministic units (methods) + call graph, **one bounded, non-agentic request
per unit** carrying every question at once, units in parallel, verdicts derived
by arithmetic, readings cached by request hash. We copy the shape, not the
dependency, and keep a normal LLM (Jev's correctness axis measured dead at AUC
0.534, and adjudicate needs claim text).

## Pipeline

```
facts ─► seed ─► units (bash) ─► survey-units (in-process) ─► units-ingest (bash) ─► falsify …
                                  └ one completeSimple call per unit
```

Selected by `review.analysis.surveyEngine: agent | units` (default `agent`).
With `agent`, the three new nodes skip; with `units`, the old `survey` fanout
skips. Everything after is unchanged: `hypotheses/<family>.jsonl` is the
interface.

The split is deliberate:

- **Deterministic work lives in `lastlight-code-facts`** (the unit assembler,
  the rendered request text, response validation, hypothesis rows). It runs as
  bash phases inside the sandbox like every other `lastlight-facts` step, is
  testable without a model, and is usable by the evals harness.
- **Core does only model I/O.** Core does not depend on `lastlight-code-facts`
  (`post-review.ts` copies what it needs), and must not start to — the package
  drags tsgo + ast-grep natives into the agent image. The handler reads
  `units.json` from the host checkout, which exists on every host-checkout
  backend (none/docker/gondolin/smol). **On kubernetes there is no host
  checkout: the handler fails loud** (`surveyEngine: units` is unsupported
  there; say so in the error).

## File contract (all under `.lastlight/pr-review/`)

### `units.json` — written by `lastlight-facts units --dir .lastlight/pr-review --repo .`

```jsonc
{
  "version": 1,
  "generatedAt": "…",
  "baseSha": "…", "headSha": "…",
  "promptVersion": "units-v1",       // bump when request rendering changes
  "coverage": "full" | "degraded" | "none",
  "degraded": [{ "extractor": "units", "reason": "…" }],
  "responseSchema": { … },            // JSON Schema of ONE unit response (informational; the request text also states it)
  "units": [
    {
      "id": "u-001",                  // stable within the document, zero-padded, ordered by file then line
      "kind": "symbol" | "module" | "pr",
      "file": "src/a.ts" | null,      // null only for kind "pr"
      "symbol": "Service.run" | null,
      "lines": [10, 48] | null,       // head coordinates, inclusive
      "language": "typescript",
      "families": ["contract", "state"],
      "obligationIds": ["contract-o3", "spec-o1"],
      "request": "…",                 // the COMPLETE user message sent for this unit, verbatim
      "requestSha256": "…",           // sha256 of `request`
      "truncated": false              // true when the shrink cascade dropped/trimmed context; the reason is in degraded[]
    }
  ]
}
```

`units` must also succeed (write a document, `coverage: "none"`, exit 0 under
`--never-fail`) when there is nothing to survey, and fail loud (exit 2, a
document with `degraded[]`) when its inputs are missing.

### `units/responses/<unitId>.json` — written by the core handler

```jsonc
{
  "unitId": "u-001",
  "model": "provider/model-id",
  "systemPromptSha256": "…",
  "requestSha256": "…",               // copied from units.json
  "ok": true,                         // false = no parseable JSON object after the retry, or the call failed
  "cached": false,
  "attempts": 1,                      // 1 or 2
  "raw": "…",                         // the final attempt's full text response
  "error": null | "…",
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0 },
  "durationMs": 0
}
```

The handler's only validation is **"`raw` contains one JSON object whose
`unitId` equals the unit's id"** — enough to decide the single retry. Schema
validation is `units-ingest`'s job.

### The model's response body (defined by code-facts, stated in `request`)

One JSON object: `unitId`, then one entry per obligation the request listed
(every obligation id MUST appear exactly once), then any unprompted defects.
Each entry carries a `family`, a `claim`, a `line` chosen from the request's
line tags, and the `SurveyEvidence` record (`survey-verdict.ts`) — exactly the
fields the survey-pass skill documents. **No `severity`, no `needsProbe`**:
both stay derived by `deriveVerdict`. Code-facts owns the exact schema.

### `units-ingest` — `lastlight-facts units-ingest --dir .lastlight/pr-review`

Reads `units.json` + `units/responses/*.json`, validates each response against
the schema, and writes `hypotheses/<family>.jsonl` in the **existing** row
shape (so `discharge`, `requiresProbe`, the dossier, `jev-classify`, the
`findings` conservation gate and `stampDerivedSeverity` need no change), with
two extra row fields: `source: "units"` and `unitId`. Writes
`units/ingest.json` (per unit: rows written, errors). A unit with no response,
`ok: false`, or an invalid body is **recorded, never silently dropped**: every
obligation it owned gets a row that says the survey could not answer it
(unknown evidence — which `deriveVerdict` already routes to a probe). Then the
per-family `discharge` checks must pass on the ingested set. Exit 0 on every
path under `--never-fail`, like the other deterministic phases.

## Transcript

The handler writes ONE virtual session per phase through `AgenticShim`
(`apps/server/src/engine/event-shim.ts`), copying `writeChatShim`
(`apps/server/src/engine/chat/chat.ts`): per unit an assistant `message_end`
carrying a `survey_unit` tool call (`arguments`: unitId, symbol, file, lines,
model, request) with that call's usage, then a `tool_execution_end` with the raw
response (or the error, `is_error`). Retries and cache hits get their own pair.
Closed by a summary message and `finalize` with summed usage. The phase is
wrapped in `runLedgeredPhase` so an `executions` row carries the `session_id`,
cost and tokens — which is what makes it visible to the dashboard, the CLI
(`lastlight session log`) and stats. Evals split and cost it from the `phase`
stamp and the `result` line, unchanged.

## Independent review off under the pipeline

`review.analysis.independentReview` (default `false`): with the evidence
pipeline on, the separate `review` pass is skipped and `adjudicate` writes
`findings.json` from the hypotheses alone. With the pipeline off, `review`
always runs — it is the whole review.

## Evals (the branch is done when these exist)

1. **$0 coverage audit** — facts/seed/units only on skillspro (8 cases, 25 gold)
   and martian (pinned cache): share of gold lines inside some unit, units/PR.
2. **Replay** — `survey-units` + `units-ingest` over preserved workspaces of a
   prior agent-survey run: hypothesis-level gold recall, how many of the 19
   survey-missed gold are now covered, hypotheses/PR, survey wall clock, $.
3. **Paid A/B**, ≥2 runs/arm: baseline (agent, review on) · A (agent, review
   off) · B (units, review on) · C (units, review off). Quality (F1/recall/
   precision), speed (case p50/max from phase timings), $. One arm on a serial
   backend.

Decision rule (written before running): flip `surveyEngine: units` only if C's
recall is within the baseline's run-to-run range and case wall clock drops
substantially.
