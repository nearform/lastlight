# Executor summary for issue #61

## What was done

Implemented the multi-tenant overlay/configuration model:

- Added `config/default.yaml` as the canonical non-secret default config.
- Refactored `src/config.ts` to load default config, optional `$LASTLIGHT_OVERLAY_DIR/config.yaml`, then env overrides; exposed runtime/public config helpers.
- Reworked workflow asset loading for built-in + overlay layers, logical-name replacement, fail-fast validation, prompt/skill fallback, disables, origin tracking, and resolved agent context merging.
- Routed managed repos, router targets, cron contexts, triggers, and admin fanout through config-backed accessors.
- Consolidated agent context use across chat, in-process/gondolin, and Docker executor paths; Docker workspaces now receive harness-written `AGENTS.md`, and the sandbox entrypoint no longer overwrites it.
- Added dashboard `/config` API and a read-only Config tab with Default / Overlay / Merged views.
- Updated packaging and docs for `config/` and `LASTLIGHT_OVERLAY_DIR`.
- Added overlay/config test coverage and updated loader fail-fast expectations.

## Files changed

- `.env.example`
- `README.md`
- `config/default.yaml`
- `dashboard/src/App.tsx`
- `dashboard/src/api.ts`
- `dashboard/src/components/ConfigPage.tsx`
- `deploy/sandbox-entrypoint.sh`
- `package.json`
- `src/admin/routes.ts`
- `src/config.ts`
- `src/config-overlay.test.ts`
- `src/cron/jobs.ts`
- `src/engine/agent-executor.ts`
- `src/engine/chat.ts`
- `src/engine/profiles.ts`
- `src/engine/router.ts`
- `src/index.ts`
- `src/managed-repos.ts`
- `src/workflows/loader-overlay.test.ts`
- `src/workflows/loader.test.ts`
- `src/workflows/loader.ts`
- `src/workflows/triggers.ts`

## Test results

Command: `npm test`

```text
> lastlight@0.1.15 test
> vitest run


 RUN  v4.1.7 /home/agent/workspace/lastlight


 Test Files  27 passed (27)
      Tests  444 passed | 1 todo (445)
   Start at  09:03:28
   Duration  6.30s (transform 679ms, setup 0ms, import 1.43s, tests 2.13s, environment 2ms)
```

## Lint results

Command: `npm run lint`

```text
npm error Missing script: "lint"
npm error
npm error Did you mean this?
npm error   npm link # Symlink a package folder
npm error
npm error To see a list of scripts, run:
npm error   npm run
npm error A complete log of this run can be found in: /home/agent/.npm/_logs/2026-05-28T09_00_12_336Z-debug-0.log
```

Lint is not configured in this repo; guardrails marked it missing/non-blocking.

## Typecheck/build results

Command: `npm run build`

```text
> lastlight@0.1.15 build
> tsc
```

Command: `npm run build:dashboard`

```text
> lastlight@0.1.15 build:dashboard
> npm run build -w dashboard


> @lastlight/dashboard@0.1.0 build
> tsc -b && vite build

vite v5.4.21 building for production...
transforming...

🌼   daisyUI 4.12.24
├─ ✔︎ 1 theme added		https://daisyui.com/docs/themes
╰─ ★ Star daisyUI on GitHub	https://github.com/saadeghi/daisyui

✓ 2902 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                     0.63 kB │ gzip:   0.36 kB
dist/assets/index-rXcGCFkQ.css    110.13 kB │ gzip:  17.80 kB
dist/assets/index-DoSZ8ogN.js   1,002.35 kB │ gzip: 306.36 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit via build.chunkSizeWarningLimit.
✓ built in 6.37s
```

## Deviations / known issues

- CLI explicit command-to-workflow mappings remain legacy/manual dispatch, as allowed by the architect plan.
- Lint is unavailable because no `lint` script exists.

## Fix Cycle 1

Fixed the reviewer-reported route configurability issues:

- Review check-run creation now follows configured PR attention routes (`github.pr_opened`, `github.pr_synchronize`, `github.pr_reopened`) instead of requiring the hard-coded `pr-review` workflow name.
- PR-fix and build orchestration now preserve their existing enrichment/ack behavior for configured route targets and dispatch the configured workflow target while keeping `github-orchestrator` as the default internal alias for `build`.
- Startup asset validation now checks configured route targets against enabled workflows and route-specific internal handlers, failing fast for missing, disabled, or unsafe targets.
- Added route metadata coverage and fail-fast route validation tests.

Guardrails:

- Test: `npm test` — passed (27 files, 447 passed, 1 todo).
- Lint: not configured; no `lint` script is present (per guardrails report, non-blocking).
- Typecheck/build: `npm run build` — passed.
