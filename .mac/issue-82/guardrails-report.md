# Guardrails report

Status: READY

## Guardrails Report: cliftonc/lastlight

### Test Framework
- Status: PRESENT
- Runner: Vitest
- Command: `npm test`
- Evidence:
  - `package.json` root: `"test": "vitest run"`
  - Multiple test files under `src/**` (e.g. `src/admin/auth.test.ts`, `src/engine/router.test.ts`, `src/state/db.test.ts`, etc.)
  - `npm test -- --help` successfully invokes `vitest run` and prints help (runner starts cleanly)
- Notes: Use `npm test` for the main test run. `npm run test:watch` is available for interactive development.

### Linting
- Status: MISSING
- Tool: None detected
- Evidence:
  - No `lint` script in root `package.json`
  - No obvious linter configs found in the shallow scan: no `.eslintrc*`, `biome.json` at repo root within scanned depth
- Command: N/A
- Notes: Repository currently lacks a configured linter script and config in the scanned paths.

### Type Checking
- Status: PRESENT
- Tool: TypeScript (`tsc`)
- Command: `npm run build`
- Evidence:
  - `tsconfig.json` present at repo root
  - Root `package.json`: `"build": "tsc"` (no emit options specified, but `tsc` serves as typecheck here)
- Notes: There is no separate `typecheck` script; `npm run build` performs compilation/type checking.

### CI Pipeline
- Status: UNKNOWN (not fully scanned)
- Notes: The scan request only looked for `.github/workflows/*` names but the tree output was truncated at depth 4 and didn’t list them explicitly. CI likely exists but wasn’t confirmed in this pass.

### Verdict: READY

- The test framework and type checking are in place and runnable via:
  - Tests: `npm test`
  - Type check / build: `npm run build`
- Linting is not configured as a script, which is a quality gap but not a hard blocker for running the build cycle.
