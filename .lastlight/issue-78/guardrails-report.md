# Guardrails report

Status: READY

Test/lint/typecheck commands discovered and verified:

- Package manager: npm (from `package-lock.json`)
- Test:
  - Script: `"test": "vitest run"`
  - Command to use: `npm test`
  - Status: Ran successfully; Vitest executed the suite (tests passed, runner clearly working).
- Additional useful scripts:
  - Build (typecheck/compile): `"build": "tsc"`
    - Command: `npm run build`
  - Dashboard build: `"build:dashboard": "npm run build -w dashboard"`
    - Command: `npm run build:dashboard`
  - Full build (server + dashboard): `"build:all": "tsc && npm run build -w dashboard"`
    - Command: `npm run build:all`
  - Dev server: `"dev": "concurrently ..."`
    - Command: `npm run dev`
  - Server-only dev: `"dev:server": "npm run dev:server"`
  - Dashboard-only dev: `"dev:dashboard": "npm run dev:dashboard"`
  - CLI tooling: `"cli": "tsx src/cli.ts"`, `"build:issue": "tsx src/cli.ts"`
  - Test watch: `"test:watch": "vitest"`
    - Command: `npm run test:watch`

Caveats:

- Vitest is the test runner; future phases should always invoke it through `npm test` or `npm run test:watch`, not by calling Vitest directly or adding extra flags.
