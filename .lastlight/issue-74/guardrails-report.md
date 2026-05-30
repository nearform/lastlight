# Guardrails report

Status: READY

Test / lint / typecheck commands:

- Tests: `npx vitest run` (from repo root) — passes (27 test files, 468 tests incl. 1 todo).
- Lint: No npm script defined. `npm run lint` fails with `Missing script: "lint"`. No obvious alternative lint command in root package.json.
- Typecheck: No npm script defined. `npm run typecheck` fails with `Missing script: "typecheck"`. Project uses TypeScript (`tsconfig.json` present), but there is no dedicated typecheck script; if needed, use `npx tsc -p tsconfig.json` manually.
