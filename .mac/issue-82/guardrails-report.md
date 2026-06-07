# Guardrails report

Status: READY

## Guardrails Report: cliftonc/lastlight

### Test Framework
- Status: PRESENT
- Runner: Vitest
- Command: `npm test`
- Evidence:
  - `package-lock.json` → npm
  - `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`
  - `vitest.config.ts` present
  - `npm test` run succeeded and executed tests:
    - 27 test files
    - 467 tests passed, 1 todo
- Notes: Runner starts cleanly; some tests exercise network/logging behavior but all pass in this environment.

### Linting
- Status: MISSING
- Tool: none detected
- Command: n/a
- Evidence:
  - `package.json` has no `"lint"` script.
  - No obvious linter config files at repo root (no `.eslintrc*`, `biome.json` in the top-level listing).
- Notes: Code-style / static lint checks are not wired into npm scripts.

### Type Checking
- Status: PRESENT
- Tool: TypeScript (`tsc`)
- Command: `npm run build`
- Evidence:
  - Root `tsconfig.json` present.
  - `package.json` scripts: `"build": "tsc"`, plus dashboard-specific build scripts.
- Notes: There is no dedicated `"typecheck"` script, but `npm run build` performs TS type checking for the main package.

### CI Pipeline
- Status: PRESENT
- Evidence:
  - `.github/workflows/publish.yml` exists (contents not fully inspected here), indicating at least one GitHub Actions workflow.
- Notes: CI details (whether it runs tests/build) are defined in `publish.yml`; implementors should align local commands with that workflow if needed.

### Verdict: READY

- Use `npm test` for tests.
- Use `npm run build` as the TypeScript typecheck/build command.
- No standard lint command is configured; if linting is required, it will need to be added separately.
