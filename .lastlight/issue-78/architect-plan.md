## Problem Statement

Issue #78 requests a small, reusable function that accepts a `name` and prints `Hello ${name}!`. The harness already has a CLI entrypoint at `src/cli.ts` (documented in `README.md` lines ~74–115) and a general runtime entrypoint at `src/index.ts` (`CLAUDE.md` “Repo layout” section, around lines 40–80), but there is no dedicated utility for this simple greeting behavior yet. We need to add such a function in a way that is idiomatic for this TypeScript codebase and easily reusable from other modules or future skills.

## Summary of What Needs to Change

- Add a small TypeScript utility that exports a `hello(name: string): void`-style function which prints `Hello ${name}!` (using `console.log` or equivalent).
- Optionally provide a simple integration point (e.g., a CLI subcommand) to demonstrate usage while keeping it generic and reusable.
- Add a minimal test (Vitest) to validate the function’s behavior.
- Ensure the change typechecks (`npm run build`) and tests pass (`npm test`).

## Files to Modify

1. **`src/utils/hello.ts`** (new)
   - Introduce a new utility module that exports the reusable function, e.g.:
     - `export function hello(name: string): void` that prints `Hello ${name}!`.
   - Centralizes the logic so it can be called from anywhere in the harness.

2. **`src/cli.ts`** (existing)
   - Add optional wiring to exercise the new function from the CLI, e.g. a simple command like `hello <name>` or an environment-guarded example.
   - Keep this integration minimal so it doesn’t interfere with existing CLI behaviors documented in `README.md` (around the “Triggering work via the CLI” section, lines ~130–190).

3. **`src/utils/hello.test.ts`** or **`src/cli.test.ts`** (new)
   - Add a Vitest test file alongside the implementation.
   - Verify that the function prints exactly `Hello ${name}!` (including punctuation and spacing) using `vi.spyOn(console, 'log')` or similar.

4. **`README.md`** (optional, minor)
   - If a CLI entrypoint is added (e.g. `npx tsx src/cli.ts hello Alice`), add a short note/example in the CLI section to show the new capability and anchor the function in public usage.

## Implementation Approach

1. **Locate coding conventions and structure**
   - Follow the patterns from existing modules under `src/` (e.g. imports, exports, default TypeScript config noted in `tsconfig.json` and `CLAUDE.md`).
   - Confirm test layout from `vitest.config.ts` (tests are likely next to source or under `src/**.test.ts`).

2. **Create the utility function**
   - Under `src/`, create `utils/hello.ts` (if `utils/` does not yet exist, create it).
   - Implement:
     ```ts
     export function hello(name: string): void {
       console.log(`Hello ${name}!`);
     }
     ```
   - Keep it intentionally simple and side-effect limited to stdout.

3. **(Optional but recommended) Expose via CLI**
   - In `src/cli.ts`, inspect how existing arguments are parsed (likely basic `process.argv` handling or a small argument parser).
   - Add a minimal branch for a `hello` subcommand:
     - Usage: `npx tsx src/cli.ts hello Alice`
     - Behavior: call `hello('Alice')` from `src/utils/hello.ts`.
   - Ensure this does not change default behaviors for existing commands (triage, review, build, etc. as described in `README.md`).

4. **Add tests**
   - Create `src/utils/hello.test.ts` (or adjust path to match existing patterns).
   - Use Vitest to verify:
     - When calling `hello('Alice')`, the process logs exactly `Hello Alice!`.
     - Consider a second test for a different name to ensure interpolation logic is clear.
   - Use `vi.spyOn(console, 'log')` and restore it after each test.

5. **Type correctness and exports**
   - Ensure the new module compiles cleanly under `tsc` (no implicit `any`, correct module resolution).
   - No need to surface `hello` from `src/index.ts` unless you want this to be part of a public API; keep it internal utility unless the maintainer wants broader exposure.

6. **Documentation (optional)**
   - If a CLI entry is added, add a small snippet to `README.md` under the CLI usage section showing:
     - Command invocation.
     - Example output.
   - If the function remains internal only, skip README changes.

## Risks and Edge Cases

- **Behavioral scope**: The issue only specifies printing `Hello ${name}!`. Don’t add extra formatting, logging metadata, or ANSI colors that might break tests or expectations.
- **CLI regression risk**: If wiring into `src/cli.ts`, ensure argument parsing doesn’t break existing subcommands or default behaviors. Keep the new path clearly namespaced (e.g. first argument `hello`).
- **Type expectations**: The function should accept a `string`; avoid implicitly accepting `any` or coercing non-strings without explicit typing.
- **Testing environment**: Spying on `console.log` must be correctly restored after each test to avoid impacting other tests.

## Test Strategy

Run the existing and new tests and typechecks:

- Unit tests (Vitest):
  - `npm test`
- Typecheck / build:
  - `npm run build`
- (If dashboard or full build is relevant to CI, but not required here:)
  - `npm run build:dashboard` or `npm run build:all` as needed.

## Estimated Complexity

- **Simple**: One small utility, one optional CLI hook, and one test file, with minimal risk to the wider system.