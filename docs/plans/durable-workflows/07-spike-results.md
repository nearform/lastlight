# 07 — Spike results

Branch `spike/durable-workflows`. Throwaway: the shape is right, the code is
not yet production-grade (see "Not done").

## What was built

| Piece | Where | LOC |
|---|---|---|
| Authoring API: `DurableStep` port, `WorkflowContext`, `defineWorkflow`, `reviewLoop`, `iterate`, `readStatusLine`, converter compat helpers | `packages/workflow-engine/src/durable/` | 653 |
| OpenWorkflow adapter (`DurableRuntime`) | `apps/server/src/workflows/durable/runtime.ts` | 124 |
| `build` hand-ported (59 of those lines are the verbatim guardrails gate script) | `apps/server/src/workflows/durable/workflows/build.ts` | 191 |
| Deterministic YAML → TS converter | `apps/server/scripts/yaml-to-ts.mjs` | 314 |
| Converter output for all 15 agent workflows | `apps/server/src/workflows/durable/generated/` | 1,141 |
| Tests: build behaviour + restart/approval + parity | `apps/server/tests/workflows/durable/` | 441 |
| `kill -9` crash script | `apps/server/scripts/spike/durable-crash.mjs` | — |

For scale: `build.yaml` is 233 lines but its behaviour also lives in the
1,606-line phase executor and the 1,136-line schema; the TS version's
behaviour is the file you read plus a 74-line `reviewLoop`.

## Acceptance — all met

| Check | Result |
|---|---|
| Happy path, BLOCKED, bootstrap bypass, reviewer cap (2 cycles then PR), rejection | ✅ `build.test.ts` |
| Park at `post_architect`, **stop the runtime, open a new one on the same DB**, approve → completes; guardrails/architect ran once across both; approval request not re-posted | ✅ |
| Park at a fix-cycle gate inside `reviewLoop`, restart, resume into the right cycle | ✅ |
| Step output available to later steps after a restart (the YAML `phaseOutputs` caveat) | ✅ |
| `parallel({ max: 2 })` never exceeds 2 in flight; each branch memoized | ✅ |
| Decision recorded while no step waits (unbuffered signals) is honoured without parking | ✅ |
| **Real `kill -9` mid-agent-step** in a child process, fresh process resumes | ✅ resumed after **30.6 s** (lease expiry); only the in-flight `executor` re-ran |
| Converter: all 15 agent workflows convert and typecheck; output byte-identical across runs | ✅ |
| Converter parity: YAML engine vs generated TS, same scripted agent, 14 scenarios | ✅ identical call sequences + outcomes |
| Existing suite untouched | ✅ 266 files / 4,724 tests pass; typecheck + import-boundary gate clean |

## What got easier

- Resume semantics are uniform: one rule (unique step names) instead of
  per-construct scratch bookkeeping. The reviewer-loop resume test needed no
  special code at all.
- Data flow is typed values, not files and `scratch`.
- Gates, retries and fallbacks are `if` / `for` / `??`.
- Hidden coupling became visible: the converter's `scratch.*` TODOs exposed
  that `pr-fix`'s `skip_if` depends on a core-side harvest hook.

## What got harder / risks

- **Determinism discipline.** Code between steps re-runs on replay; a
  non-deterministic step *name* would silently re-execute work. Mitigation: a
  lint rule (no template literals with `Date`/`Math.random` in step names) and a
  replay test helper that runs every workflow twice against the same history.
- **OpenWorkflow maturity.** 0.10.x, one maintainer, `console.error` logging,
  unbuffered signals, separate `node:sqlite` file. Mitigation: the 3-method
  port, plus the Drizzle `Backend` (03) which also fixes the two-database
  problem; the replay core is small enough to vendor.
- **30 s crash-recovery latency** (fixed lease). Irrelevant next to 30-minute
  phases.
- **Overlay authors now write TS.** Mitigated by typed composition (04) and a
  `tsc`-based validator.
- Static workflow diagrams go away (06).

## Not done in the spike

Server wiring (dispatch routing, boot/shutdown, approvals endpoints, admission
and PR run lock), the Drizzle backend, dashboard/evals adapters, checklist
reporter, overlay loading, versioned-deploy drain.

## Recommendation: **go**, in the order of `05-migration.md`

First PR: the `durable/` API + Drizzle `Backend` (both dialects) + dispatch
flag, with the eight clean workflows converted behind it and compared in evals.
Decide OpenWorkflow vs vendored replay core at the end of that PR, once the
Drizzle backend shows how much of OpenWorkflow we actually use.
