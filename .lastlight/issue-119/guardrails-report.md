# Guardrails Check — #119 Slack commands

Branch: `lastlight/119-slack-commands`

## Summary

Issue #119 is a normal bug-fix/feature task: the chat agent advertises
Slack slash commands (`/health`, `/build`, `/triage`, …) that do not
exist as real Slack slash commands. The fix is to reword the chat prompt
(`src/engine/chat.ts`) and/or register real slash commands via
`app.command(...)` in the Slack connector. This is **not** a bootstrap
task — existing tooling is the expected foundation to build on.

## 1. Test Framework — PRESENT ✅

- Runner: **vitest** (`vitest@^4.1.4`), configured in `vitest.config.ts`.
- `package.json` script: `"test": "vitest run"`.
- Test files: 48 test files across `src/` (engine, connectors, admin,
  cron, notify, sandbox, state, telemetry, worktree, …).
- `npx vitest run` → **48 files, 723 tests passed** (11.50s).
- Includes tests directly relevant to this work:
  `src/engine/classifier.test.ts`, `src/engine/chat-runner.test.ts`,
  `src/connectors/slack/mrkdwn.test.ts`.

## 2. Linting — NOT CONFIGURED ⚠️ (non-blocking)

- No eslint/biome/ruff config in the repo.
- `package.json` has no `lint` script.
- CI (`.github/workflows/ci.yml`) does not run a linter.
- Non-blocking: linting is not a critical guardrail. Typecheck + tests
  cover the gate. Executor may add a linter if desired but is not
  required to.

## 3. Type Checking — PRESENT ✅

- `tsconfig.json` with `"strict": true`, target ES2022, Node16 module
  resolution.
- CI runs `npx tsc --noEmit` (server) and `npx tsc -b dashboard`.
- `npx tsc --noEmit` → **exit 0**, clean.

## 4. CI Pipeline — PRESENT (informational) ℹ️

- `.github/workflows/ci.yml`: on PR + push to main; runs install,
  typecheck (server + dashboard), and `npx vitest run`.
- `.github/workflows/publish.yml` also present.

## Verdict

All critical guardrails (test framework + type checking) are present
and green. Linting is absent but non-blocking. **READY** to proceed to
the architect phase.
