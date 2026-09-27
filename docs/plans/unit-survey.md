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
  checkout, so `loadConfig` refuses `surveyEngine: units` there at startup**
  (`assertSurveyEngineSupported`, off `HOST_READABLE_WORKSPACE` in
  `handlers/host-repo-dir.ts`); the handler keeps a run-time guard that
  degrades (below) rather than fails.

## File contract (all under `.lastlight/pr-review/`)

### `spec-obligations.json` — written by core before `units` runs

Written by the `units` bash node itself, before it invokes `units`:
`specContext` (`pr-decisions.ts`) projects the SAME `SpecObligationSet` the
rendered `{{specObligations}}` block comes from as `specObligationsJson` — one
line of `JSON.stringify`, present exactly when `specObligations` is (a
degraded, empty set included) — and the node writes it through a quoted
heredoc (`cat > … <<'LASTLIGHT_SPEC_EOF'`). The template renderer substitutes
values verbatim and never re-scans them; the one hazard is the bash guard
(`validateShellCommand` rejects any `{{` in a rendered command), so `{{` inside
a string is emitted as `{\u007b` — still JSON, parsing back to the identical
object. No set ⇒ no file (the node `rm`s a stale one first). Pinned end to end
by `tests/workflows/units-spec-obligations.test.ts`, which runs the rendered
node with `sh` against a hostile criterion.

Exactly the JSON of `SpecObligationSet` (`apps/server/src/engine/review-spec.ts`):

```jsonc
{
  "obligations": [
    { "id": "S-1", "criterion": "…", "source": "issue #12" | "the PR body",
      "candidates": ["src/a.ts", "…"],   // changed FILE paths, best match first, never empty
      "changedFileCount": 7, "found": false, "question": "…" }
  ],
  "dropped": 0, "changedFileCount": 7, "degraded": ["…"]
}
```

`units` reads it (`--spec <file>`, default `<dir>/spec-obligations.json`) and
attaches each obligation to ONE unit: the first candidate file that has any
unit, and within it the unit holding the most touched lines (ties → the
earliest); no candidate with a unit ⇒ the `pr` unit. Rendered under
OBLIGATIONS as `S-n · family spec · asked in <source>` + criterion + candidate
files + question. Absent ⇒ a `degraded[]` entry (as before); malformed (bad
JSON, wrong shape, repeated ids) ⇒ a `degraded[]` entry and no spec
obligation, never a crash. The file is read loosely: fields core adds pass.

### `units.json` — written by `lastlight-facts units --dir .lastlight/pr-review --repo .`

```jsonc
{
  "version": 1,
  "generatedAt": "…",
  "baseSha": "…", "headSha": "…",
  "promptVersion": "units-v3",       // bump when request rendering changes
  "sharedPrefix": "…",                // the unit-independent head EVERY request starts with, byte for byte
  "sharedPrefixSha256": "…",          // sha256 of `sharedPrefix`
  "coverage": "full" | "degraded" | "none",
  "degraded": [{ "extractor": "units", "reason": "…" }],
  "responseSchema": { … },            // JSON Schema of ONE unit response (informational; the request text also states it)
  "skipped": [{ "file": "…", "reason": "…" }],
  "specObligations": [{ "id": "S-1", "criterion": "…", "source": "…", "candidates": ["…"], "question": "…" }],
                                      // as printed; absent when no spec file was read. Ingest resolves S-n against THIS
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
      "request": "…",                 // the COMPLETE user message sent for this unit, verbatim: sharedPrefix + the unit-specific part
      "requestSha256": "…",           // sha256 of `request`
      "truncated": false              // true when the shrink cascade dropped/trimmed context; the reason is in degraded[]
    }
  ]
}
```

What a unit is: one `symbol` unit per changed function/method; **at most one
`module` unit per file**, carrying every changed region no symbol unit holds, in
head order, with a `⋮` elision row between regions (split into several module
units only when the file's regions overrun the budget); small changed functions
(≤ 15 lines, no attached obligation) folded into that module unit as whole
regions — their callers and callees still shown; and one `pr` unit for
obligations no unit holds.

**Cache-friendly order.** Every `request` is `sharedPrefix` — the task, the
line-tag legend, the always-asked families' questions, NOT FINDINGS, the
evidence record, the response shape and the generic rules, ending with the
line `=== THIS UNIT ===` — followed by the unit-specific part (UNIT, SOURCE,
IMPORTS, CALLERS, CALLEES, OBLIGATIONS, a conditional family such as `tests`,
and this unit's id / answer list). The prefix carries no unit id, count or
per-unit family subset, so it is byte-identical across every unit of every run
(~5.9k chars) and a provider's prompt-prefix cache pays for it once. The
handler may mark `sharedPrefix` as a cache breakpoint; sending `request`
verbatim is still correct.

`units` must also succeed (write a document, `coverage: "none"`, exit 0 under
`--never-fail`) when there is nothing to survey, and fail loud (exit 2, a
document with `degraded[]`) when its inputs are missing.

**The shell fallback is a valid document.** When the process dies without
writing, the YAML prints
`{"version":1,"generatedAt":…,"baseSha":null,"headSha":"<sha>","promptVersion":null,"coverage":"none","degraded":[{"extractor":"units","reason":"…"}],"responseSchema":null,"units":[]}`.
`UnitsDocumentSchema` accepts exactly that — nulls for
`baseSha`/`promptVersion`/`responseSchema`/`sharedPrefix`/`sharedPrefixSha256`,
no `skipped` — **only** with `coverage: "none"` and an empty `units`; any
document with units carries every field. `fallbackUnitsDocument(reason,
headSha)` builds it and a test pins it against the literal. Ingest reads any
empty document whose reason does not start with `"nothing to survey"` as
`unitsState: "not-surveyed"` — nobody looked, the reason propagated into
every conserved row, exit 3 — never as unreadable and never as clean.

### `units/responses/<unitId>.json` — written by the core handler

```jsonc
{
  "unitId": "u-001",
  "model": "provider/model-id",
  "systemPromptSha256": "…",
  "requestSha256": "…",               // copied from units.json
  "ok": true,                         // false = no usable reply after the retry, the call failed, the reply hit the
                                      //   output cap, the phase deadline / a run cancel, or the file could not be written
  "cached": false,
  "attempts": 1,                      // 1 or 2; 0 = stopped (deadline / cancel) before the first call
  "raw": "…",                         // the final attempt's full text response
  "error": null | "…",
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0 },
  "durationMs": 0
}
```

The handler's validation is **the canonical reply rule, owned by code-facts**
(`src/unit-response.ts`) and mirrored in the handler case for case —
`tests/unit-reply.test.ts`'s table is copied verbatim into the handler's test:

- `findUnitObject(raw, unitId): Record<string, unknown> | null` — candidates
  are every balanced top-level `{…}` span of `raw` that parses as a JSON
  object, then those inside each ``` fence body (string-aware, braces only; an
  unclosed `{` or a balanced non-JSON span is skipped and scanning CONTINUES);
  the first whose `unitId` is exactly `unitId` wins; otherwise one level of
  nesting (a property value, or an object element of an array property value,
  with that `unitId`); otherwise `null`.
- `isUsableUnitReply(obj, unitId): boolean` — `unitId` matches AND `answers`
  and `defects` are arrays.

`ok: true` and a cache write only when both hold (after the one retry). Ingest
applies the same two before reading any entry, so a reading the handler cached
is never `invalid` at ingest. Entry/schema validation is `units-ingest`'s job.

The handler (`apps/server/src/workflows/handlers/survey-units.ts`) keeps its
own copy of the two rules — core cannot import code-facts — and its test
carries the `CASES` / `USABLE` tables verbatim. Around the rule:

- **The call.** System = the phase prompt + `"\n\n"` + `sharedPrefix` when
  every request starts with it (and keeps something after it); user = the
  request minus the prefix. Otherwise the request goes verbatim.
  `systemPromptSha256` is the hash of the system text actually sent. pi-ai
  puts Anthropic's `cache_control` on the system block (and on the last user
  block), so this is what makes the prefix a cross-unit cache hit. The phase's
  `variant:` (`{{variants.review-survey}}`, then the resolver) is the thinking
  level. No explicit `maxTokens` (pi-ai sends the model's cap); a reply that
  stops with `stopReason: "length"` and no usable object is recorded `ok:
  false` and NOT retried.
- **The cache** (`<stateDir>/unit-survey-cache/<owner>/<repo>/`) is keyed on
  the resolved endpoint (provider, api, model id, base URL — after
  `providers:` overrides), the thinking level, and the hashes of the system
  and user text sent. A hit is re-checked against the rule. Before clearing
  `units/responses/`, the handler reads the previous run's `units/ingest.json`
  and, for each unit it marked `invalid` / `partial`, takes that unit's
  `requestSha256` from the response record beside it and evicts the entry the
  same request would hit (best-effort, logged).
- **The deadline.** `timeout_seconds: { from: surveyUnitsTimeoutSeconds }`
  (`review.analysis.surveyUnitsTimeoutSeconds`, default 600) arms one
  `AbortController` whose signal goes into every call; a run cancel (the run
  row polled every 5 s) aborts it too. A unit not finished is recorded `ok:
  false`, error `phase deadline` / `run cancelled`.
- **Degrade, don't fail.** Every path inside the phase — no or unreadable
  `units.json`, an empty `coverage: "none"` document (the node's shell
  fallback), no model, every call failing, the deadline — SUCCEEDS with a loud
  `SURVEY DEGRADED …` summary and a warn log; `units-ingest` records the gap.
  A red phase would post nothing and re-arm the 30-minute review sweep. Each
  unit settles on its own (a throw, or a response file that cannot be
  written, is that unit's failure), so the pool drains before the transcript
  closes.

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
(unknown evidence — which `deriveVerdict` already routes to a probe). **Those
rows — and only those — carry `needsProbe: true`**: `requiresProbe` (the
`falsify` gate) reads the raw field or a Critical severity and never derives,
and unknown evidence derives to Minor, so without the stamp nothing required
them to be probed; `requiresProbe` is left alone so the agent-survey baseline
does not move mid-experiment. A spec answer becomes a
`hypotheses/spec.jsonl` row in the agent spec survey's shape (`obligation:
"S-n"`, `bothEnds.introducedAt` = the criterion's source, `path`). Then the
per-family `discharge` checks must pass on the ingested set (`spec` stays
`--ungraded`). Exit 0 on every path under `--never-fail`, like the other
deterministic phases.

## Transcript

The handler writes ONE virtual session per phase through `AgenticShim`
(`apps/server/src/engine/event-shim.ts`), copying `writeChatShim`
(`apps/server/src/engine/chat/chat.ts`): per unit an assistant `message_end`
carrying a `survey_unit` tool call (`arguments`: unitId, symbol, file, lines,
model, request) with that call's usage, then a `tool_execution_end` with the raw
response (or the error, `is_error`). Retries and cache hits get their own pair,
and so does a unit the deadline or a cancel stopped before its first call
(`<unitId>-stopped`, `is_error`, the reason as the result). The opening prompt
is the phase prompt plus a unit manifest that shows `sharedPrefix` ONCE (each
call's `request` argument carries a one-line marker in its place, whether or not
the prefix went out as system text). Closed by a summary message — `SURVEY
DEGRADED …` / `SURVEY STOPPED EARLY …` when it was — and `finalize` with summed
usage; nothing is written after the `result` line. The phase is
wrapped in `runLedgeredPhase` so an `executions` row carries the `session_id`,
cost and tokens — which is what makes it visible to the dashboard, the CLI
(`lastlight session log`) and stats. Evals split and cost it from the `phase`
stamp and the `result` line, unchanged.

## Independent review off under the pipeline

`review.analysis.independentReview` (default `false`): with the evidence
pipeline on, the separate `review` pass is skipped and `adjudicate` writes
`findings.json` from the hypotheses alone. With the pipeline off, `review`
always runs — it is the whole review.

That makes `adjudicate` the only writer of `findings.json`, so `reconcile`'s
`findings --repair` **creates** the file when it is missing over a non-empty
hypothesis set: every hypothesis at `internal`, `event: "COMMENT"`, a summary
saying adjudication did not complete so nothing was weighed or posted inline,
and an `incomplete: {phase, reason}` marker. Without it a failed adjudicator
meant post-review failing "could not read findings", a red run with nothing
posted, and the 30-minute sweep re-running the pipeline on the same SHA
forever. Safe in every shape: when `review` ran, a missing file means review
failed and post-review (`none_failed` on `review`) does not run. An
unreadable file is never overwritten; no hypotheses ⇒ nothing is invented.

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
