# Testing nearform/lastlight

## The guardrails gate command

When writing `.git/lastlight-gate.sh`, use **exactly**:

```bash
pnpm turbo run test --concurrency=1
```

Not a bare `pnpm turbo run test`. Turbo runs every package's suite at once by default, and inside the memory- and CPU-capped sandbox that makes tests run 15x or more slower than on a laptop: `lastlight-code-facts` tests that finish in ~4s hit their 60s vitest timeout and fail even though nothing is broken. One package at a time is slower overall but finishes, and its verdict means something. This repo's `.lastlight/lastlight.yml` raises `gate.timeoutSeconds` to cover the serial run.

The same applies when you run the full suite yourself as an executor: use `--concurrency=1`, or run only the affected package with `pnpm --filter <package> test`.

## Not a test failure

- **Postgres integration suites** are skipped unless `PG_INTEGRATION=1` is set. CI runs them in a separate `pg-integration` job; do not try to start Postgres here.
- **Docker sandbox integration tests** are skipped unless `RUN_SANDBOX_IT=1` is set. There is no Docker daemon inside the sandbox.

## Typecheck and lint

`pnpm turbo run typecheck` includes the import-boundary and floating-promise lints. Biome is configured only in `packages/agentic-pi` (`pnpm --filter agentic-pi exec biome lint`).
