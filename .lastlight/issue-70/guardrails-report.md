# Guardrails report

Status: READY

Test framework
- Runner: Vitest
- Config: `vitest.config.ts`
- Command (root): `npm test` (runs `vitest run`) — **works and passes**  
  - 27 test files, 467 tests passed, 1 todo

Linting
- No linter script configured in root `package.json`.
- `npm run lint` → fails with: `Missing script: "lint"`

Type checking
- Root TypeScript config: `tsconfig.json`
- No dedicated typecheck script in root `package.json`.
- `npm run typecheck` → fails with: `Missing script: "typecheck"`
- For dashboard workspace specifically (if needed in later phases):  
  - Typecheck command (per `CLAUDE.md`): `cd dashboard && npx tsc -b` (not wired as an npm script at root).
