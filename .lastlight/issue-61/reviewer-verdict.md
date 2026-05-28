# Reviewer Verdict — Issue #61

VERDICT: REQUEST_CHANGES

## Summary

The implementation adds the requested overlay/config plumbing and the core tests/builds pass, but route configurability is only partially wired into the event execution path. Custom PR/build route targets lose existing orchestration behavior, and startup validation does not catch route targets that point at disabled or missing workflows.

## Issues

### Critical

None.

### Important

- `src/index.ts:1039` still gates review check-run creation on `skill === "pr-review"`. If `routes.github.pr_opened` / `pr_synchronize` / `pr_reopened` are configured to a replacement review workflow, PR reviews still dispatch through the configured route but `REVIEW_POSTS_CHECK` silently stops posting the required status check. This violates the plan to replace hard-coded route targets while preserving the current review-check behavior.
- `src/index.ts:704` and `src/index.ts:904` keep the PR-fix/build orchestration branches keyed to hard-coded internal route names and then dispatch hard-coded workflow names (`dispatchWorkflow("pr-fix")`, `dispatchWorkflow("build")`). If `routes.github.pr_fix` or `routes.github.issue_build` / `routes.slack.build` are customized, the router returns the custom target, bypassing the existing branch/CI enrichment or build-cycle orchestration. Configured routes should either be validated as internal aliases or the special handlers should dispatch the configured target while preserving the same context construction.
- `src/index.ts:67` calls `validateAssets()`, but `src/workflows/loader.ts:280` only populates workflow caches and checks unsafe disabled workflow/cron names. It does not validate configured route targets against enabled workflows/internal handlers, so an overlay can disable `issue-triage` or route an event to a missing workflow and startup succeeds; the first matching event fails at dispatch time instead of fail-fast as specified.

### Suggestions

- `src/config.ts:299`–`310` silently falls back for several malformed file-config values (`models.default`, `sandbox.maxTurns`, `bootstrap.label`, `review.postsCheck`) rather than failing on invalid file config. Tightening these to explicit schema validation would better match the plan and make config mistakes easier to diagnose.

### Nits

None.

## Test Results

```text
$ npm test && npm run build && npm run build:dashboard

> lastlight@0.1.15 test
> vitest run


 RUN  v4.1.7 /home/agent/workspace/lastlight


 Test Files  27 passed (27)
      Tests  444 passed | 1 todo (445)
   Start at  09:05:06
   Duration  6.56s (transform 727ms, setup 0ms, import 1.54s, tests 2.15s, environment 2ms)

> lastlight@0.1.15 build
> tsc


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
✓ built in 5.77s

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
```

## Re-review after Fix Cycle 1

VERDICT: APPROVED

The fix commit addresses the previously requested route configurability issues. PR review check-run creation now keys off PR route metadata, PR-fix/build special orchestration paths preserve enrichment while dispatching the configured route target, and startup asset validation now rejects missing, disabled, or unsafe route targets except for route-specific internal handlers. I did not find new problems in the fix-cycle diff.

## Re-review Test Results

```text
$ npm test && npm run build && npm run build:dashboard

> lastlight@0.1.15 test
> vitest run

 Test Files  27 passed (27)
      Tests  447 passed | 1 todo (448)

> lastlight@0.1.15 build
> tsc

> lastlight@0.1.15 build:dashboard
> npm run build -w dashboard

✓ built in 6.10s
```
