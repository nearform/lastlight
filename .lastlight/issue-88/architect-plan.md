# Architect Plan for #88 — Update agentic-pi to 0.2.4

## Problem Statement

The repo currently pins the key sandbox/runtime dependency below the requested release: root `package.json` depends on `agentic-pi` `^0.2.3` at `package.json:56`, while the dashboard workspace still declares `^0.2.0` at `dashboard/package.json:14`. The lockfile resolves the installed runtime to `agentic-pi` `0.2.3` at `package-lock.json:6282`, and mirrors the old workspace ranges at `package-lock.json:20` and `package-lock.json:48`, so a clean install will not necessarily exercise `0.2.4`. This matters because lastlight invokes `agentic-pi` both in-process through `run()` (`src/engine/agent-executor.ts:328-330`) and inside the Docker sandbox through the CLI (`src/sandbox/docker.ts:349`); the sandbox image also installs the exact version from the lockfile (`sandbox.Dockerfile:74-82`).

## Summary of what needs to change

Upgrade all `agentic-pi` workspace dependency ranges to `^0.2.4`, regenerate `package-lock.json`, and verify both TypeScript surfaces still compile against the 0.2.4 API. `agentic-pi@0.2.4` adds the default file-search extension via `@ff-labs/pi-fff`; because lastlight currently does not pass `fileSearch`/`--no-file-search`, the new default should be active automatically on both the in-process/gondolin path and the Docker CLI path. Add or update a focused test only if the lock/API update reveals a behavioral mismatch or if preserving the default file-search behavior needs an explicit regression assertion.

## Files to modify

- `package.json:56` — change `"agentic-pi": "^0.2.3"` to `"^0.2.4"`.
- `dashboard/package.json:14` — change the dashboard workspace range from `"^0.2.0"` to `"^0.2.4"` so workspace metadata is consistent, even though the dashboard does not currently import `agentic-pi` directly.
- `package-lock.json:20`, `package-lock.json:48`, `package-lock.json:6282-6298` — regenerate with `npm install`/`npm install agentic-pi@0.2.4 -w . -w dashboard` (or equivalent) so the root package, dashboard workspace, resolved `node_modules/agentic-pi`, integrity, and the new `@ff-labs/pi-fff` transitive dependency are captured.
- `src/engine/agent-executor.ts:328-345` — inspect after the dependency bump; no planned code change unless the 0.2.4 TypeScript `RunOptions` surface requires it. Leaving `fileSearch` unset intentionally uses the new default enabled behavior.
- `src/sandbox/docker.ts:317-352` — inspect after the dependency bump; no planned code change unless CLI parsing changed. Do not add `--no-file-search`; absence of that flag is what enables the 0.2.4 default file search in Docker runs.
- `src/sandbox/docker.test.ts:92-101` — optionally extend the existing CLI-construction test to assert the generated command does not contain `--no-file-search`, documenting that lastlight intentionally accepts agentic-pi's default file search.
- `sandbox.Dockerfile:74-82` — no direct edit expected; verify the regenerated lockfile is sufficient because the Docker image derives the global `agentic-pi` version and integrity from `package-lock.json`.

## Implementation approach

1. Run a clean dependency update for both workspaces, targeting `agentic-pi@0.2.4` and allowing npm to update `package-lock.json`.
2. Confirm `package.json`, `dashboard/package.json`, and the root lockfile all resolve `agentic-pi` to `0.2.4` and include the new `@ff-labs/pi-fff` transitive dependency from the 0.2.4 package.
3. Build/typecheck the server. If TypeScript reports a mismatch around `RunResult`, `RunOptions`, `EmitterRecord`, or `ThinkingLevel`, make the smallest compatibility adjustment in `src/engine/agent-executor.ts`, `src/engine/event-shim.ts`, or `src/engine/chat.ts`.
4. Run the relevant existing tests. If the Docker CLI assembly test fails or leaves the new behavior unclear, extend `src/sandbox/docker.test.ts` with an assertion that the command keeps file search enabled by not passing `--no-file-search`.
5. Optionally run a very small local smoke command against `agentic-pi --help` or `agentic-pi run --help` from `node_modules/.bin` to confirm the installed binary advertises the file-search flags, without requiring model credentials.
6. Commit only the dependency metadata and any minimal compatibility/test changes; do not edit deployment Dockerfiles unless verification shows the lockfile-derived install path no longer works.

## Risks and edge cases

- `agentic-pi@0.2.4` introduces `@ff-labs/pi-fff`, likely including native/Rust-backed artifacts; installs may add platform-specific optional packages or expose environment-specific failures.
- The new file-search extension defaults to override mode, so agents may call `find`/`grep` with behavior supplied by FFF rather than pi-coding-agent's built-ins. Existing prompts and dashboard shimming should still work because tool names remain ordinary tool events, but this should be watched in smoke output.
- The Docker backend installs `agentic-pi` globally from the lockfile, so forgetting to regenerate `package-lock.json` would leave Docker runs on 0.2.3 even if `package.json` changes.
- Guardrails reported a Node engine warning from `@earendil-works/gondolin@0.12.0` on Node 22.22.3; this was non-blocking before, but dependency reinstall output should be checked for new engine warnings or native package install failures.
- No lint script is configured, so `npm run lint` is non-blocking/missing by design for this repo.

## Test strategy

Primary guardrails from `.lastlight/issue-88/guardrails-report.md`:

- `npm test` — full Vitest suite; baseline was 27 files / 467 passing / 1 todo.
- `npm run build` — TypeScript server build; baseline passed.
- `cd dashboard && npx tsc -b` or `npm run build:dashboard` — dashboard typecheck/build if the dashboard workspace lock or dependency metadata changes.

Focused checks for this upgrade:

- `npm ls agentic-pi @ff-labs/pi-fff` to verify resolution to `agentic-pi@0.2.4` and presence of the new file-search dependency.
- `npx agentic-pi run --help` (or `./node_modules/.bin/agentic-pi run --help`) to confirm the installed CLI exposes the expected file-search defaults/flags without requiring provider credentials.
- If a test is added around CLI construction, run `npx vitest run src/sandbox/docker.test.ts` before the full suite.

## Estimated complexity

simple
