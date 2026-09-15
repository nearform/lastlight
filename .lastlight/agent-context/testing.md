# Testing nearform/lastlight

## The guardrails gate command

When writing `.git/lastlight-gate.sh`, use **exactly**:

```bash
VITEST_MAX_WORKERS=2 pnpm turbo run test
```

Turbo runs every package's suite at once. Each vitest (and agentic-pi's `node --test`) otherwise starts one worker per core it can see — and inside the sandbox it sees every HOST core, because the container is memory-capped but not CPU-capped. `VITEST_MAX_WORKERS` bounds that pool in every package, so the whole suite fits the default gate timeout (issue #388).

When you run the suite yourself as an executor, use the same command, or run only the affected package with `VITEST_MAX_WORKERS=2 pnpm --filter <package> test`.

## Not a test failure

- **Postgres integration suites** are skipped unless `PG_INTEGRATION=1` is set. CI runs them in a separate `pg-integration` job; do not try to start Postgres here.
- **Docker sandbox integration tests** are skipped unless `RUN_SANDBOX_IT=1` is set. There is no Docker daemon inside the sandbox.
- **agentic-pi model integration tests** (`*.integration.test.ts`) are not part of `test`; they run only via `pnpm --filter agentic-pi test:integration` and need a real provider key.
- **opengrep tests** in `lastlight-code-facts` (`rules.test.ts`, `opengrep-locale.test.ts`) run only when opengrep is installed; every other code-facts test runs with the scanners disabled on purpose.
- **`oom.test.ts`** skips its CLI case when `packages/code-facts/dist/` has not been built.

## Typecheck and lint

`pnpm turbo run typecheck` includes the import-boundary and floating-promise lints. Biome is configured only in `packages/agentic-pi` (`pnpm --filter agentic-pi exec biome lint`).
