# Guardrails report

Status: BLOCKED (aborting build)

`npm test` is configured but the test runner cannot start because `vitest` is not available in this environment (`sh: vitest: command not found`). The executor will need a node environment where `npm install` correctly installs devDependencies (including `vitest`) before tests can run.

Detected configuration:

- Package manager: **npm** (from `package-lock.json`)
- Test command:  
  - `npm test` → `vitest run`
  - Watch mode: `npm run test:watch` → `vitest`
- Build commands:  
  - `npm run build` → `tsc`  
  - `npm run build:dashboard` → `npm run build -w dashboard`  
  - `npm run build:all` → `tsc && npm run build -w dashboard`
- Dev commands:  
  - `npm run dev` (server + dashboard via `scripts/dev-local.sh` and `npm run dev -w dashboard`)  
  - `npm run dev:server`  
  - `npm run dev:dashboard`
- CLI / utility:  
  - `npm run cli` → `tsx src/cli.ts`  
  - `npm run build:issue` → `tsx src/cli.ts`

Caveat: Once `npm install` (or equivalent) succeeds in the target executor environment, `npm test` is the correct command to run tests; no extra flags should be added.
