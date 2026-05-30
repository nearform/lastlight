# Guardrails report

Status: READY

Test/lint/typecheck commands discovered:

- Package manager: **npm** (from `package-lock.json`)
- Root `package.json` scripts:
  - **Test:** `npm test`  
    - Underlying script: `"test": "vitest run"`
    - Verified: `npm test` runs Vitest successfully and executes the full test suite.
  - **Watch tests:** `npm run test:watch`  
    - Underlying script: `"test:watch": "vitest"`
  - **Build (types/tsc):** `npm run build`  
    - Underlying script: `"build": "tsc"`
  - **Build dashboard only:** `npm run build:dashboard`
  - **Build all (server + dashboard):** `npm run build:all`
  - **Dev (server + dashboard):** `npm run dev`
  - **Dev server only:** `npm run dev:server`
  - **Dev dashboard only:** `npm run dev:dashboard`
- Dashboard workspace (`dashboard/package.json`):
  - **Dev:** `npm run dev -w dashboard`
  - **Build:** `npm run build -w dashboard`
  - **Preview:** `npm run preview -w dashboard`

Caveats / notes:

- Vitest was initially missing; `npm install` in the repo root successfully installed dependencies and allowed `npm test` to run.
- The test suite currently passes end-to-end and exercises a large portion of the codebase.
- No dedicated `lint` or `typecheck` scripts are defined; type-checking is done via `npm run build` (tsc).
