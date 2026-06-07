# Guardrails report

Status: READY

## Guardrails Report: cliftonc/lastlight

### Test Framework
- Status: PRESENT
- Runner: Vitest
- Command: `npm test`
- Test files: 27 (`src/**/*.test.ts` etc.)
- Notes: `npm test` runs `vitest run` and completes successfully with all tests passing.

### Linting
- Status: MISSING
- Tool: none detected
- Command: none
- Evidence:
  - No `"lint"` script in root `package.json`.
  - No `.eslintrc*`, `eslint.config.*`, or `biome.json{,c}` at repo root (within scanned depth).
- Notes: Code style/quality checks are not enforced by a configured linter.

### Type Checking
- Status: PRESENT
- Tool: TypeScript (`tsc`)
- Command: `npm run build`
- Evidence:
  - Root `tsconfig.json` present.
  - `"build": "tsc"` script in root `package.json`.
- Notes: There is no separate `"typecheck"` script, but `npm run build` performs a full TypeScript compile/typecheck.

### CI Pipeline
- Status: PRESENT
- Evidence:
  - `.github/workflows/` directory detected (detailed contents not inspected here).
- Notes: CI exists; specific coverage of test/lint/typecheck not fully enumerated, but tests and build are expected to be wired in.

### Summary of Commands for the Executor
- Test: `npm test`
- Typecheck: `npm run build`
- Lint: not configured (no command available)

### Verdict
- READY — Tests and type checking are in place and runnable. Linting is not configured and should be added in a follow-up, but this does not block the build workflow.
