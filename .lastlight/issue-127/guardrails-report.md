# Guardrails check for issue #127

Issue: Helper function — https://github.com/cliftonc/lastlight/issues/127

## Summary

- Build type: NORMAL (not a tooling/bootstrap issue)
- Overall status: READY — tests and CI are configured; linting is not present; TypeScript typechecking is configured but the full `npx tsc --noEmit` command was killed in this sandbox (exit code 137, likely an OOM), while CI runs the same command.

## 1. Test Framework

- Status: **PRESENT**
- Tooling: Vitest
- Command: `npm test` (script: `vitest run`)
- Result: **PASS** — 54 test files / 759 tests, all passing.

## 2. Linting

- Status: **MISSING**
- Observations:
  - No `lint` (or similar) script in `package.json`.
  - No obvious ESLint/Biome config files in the repo root.
- Impact: Linting is not available as a guardrail; this is **not** treated as a blocker for this non-bootstrap feature issue.

## 3. Type Checking

- Status: **DEGRADED BUT PRESENT**
- Tooling:
  - `tsconfig.json` present.
  - `npm run build` uses `tsc`.
  - CI (`.github/workflows/ci.yml`) runs `npx tsc --noEmit` and `npx tsc -b dashboard`.
- Local command check:
  - Ran: `npx tsc --noEmit`
  - Result: **FAILED in sandbox** with exit code 137 (`Killed`), consistent with an out-of-memory limit in this environment, not a TypeScript configuration error.
- Interpretation:
  - Typechecking is correctly wired and known to run in CI.
  - In this constrained sandbox, running the full project typecheck is unreliable; the executor should rely on CI for full typechecking and may want to run narrower `tsc` targets locally if needed.

## 4. CI Pipeline

- Status: **PRESENT**
- Files:
  - `.github/workflows/ci.yml`
  - `.github/workflows/publish.yml`
- `ci.yml` includes:
  - `npm ci`
  - `npx tsc --noEmit` (server typecheck)
  - `npx tsc -b dashboard` (dashboard typecheck)
  - `npx vitest run` (test suite)
- This provides a strong test + typecheck guardrail in CI.
