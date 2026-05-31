## Problem Statement

Issue #79 asks to “build” PR #79 into this repo’s work branch. PR #79 introduces a small `hello` utility, its tests, a `hello` CLI subcommand, and a minor `package-lock.json` tweak. The changes touch the CLI entrypoint (`src/cli.ts`), add a new utility and test (`src/utils/hello.ts`, `src/utils/hello.test.ts`), and adjust the `pi-ai` bin path in `package-lock.json`. We need to ensure these changes are correctly reflected in the current worktree, remain consistent with project conventions (`CLAUDE.md`, `README.md`), and pass existing tests and type checks.

## Summary of What Needs to Change

- Ensure the PR #79 diff is correctly applied to the repo:
  - Add `src/utils/hello.ts` and `src/utils/hello.test.ts`.
  - Extend `src/cli.ts` with a `hello` subcommand and help text.
  - Adjust the `pi-ai` bin path in `package-lock.json` (`dist/cli.js` without leading `./`).
- Verify that the new CLI command is safe, doesn’t regress existing behavior, and matches documented usage style.
- Confirm tests (`npm test`) and typechecking/build (`npm run build`) succeed with the new files.

## Files to Modify

1. **`src/cli.ts`**
   - Add a help line for the `hello` subcommand just after the existing usage lines (`src/cli.ts:38-42` in the diff).
   - Insert a new early branch in `main()` that:
     - Checks `args[0] === "hello"`.
     - Dynamically imports `hello` from `./utils/hello.js`.
     - Validates presence of `args[1]` and prints `Usage: tsx src/cli.ts hello <name>` to `stderr` with exit code `1` if missing.
     - Calls `hello(name)` and exits with code `0`.
   - Ensure this branch sits before the “Check server is running” block so `hello` doesn’t need the server.

2. **`src/utils/hello.ts`** (new)
   - Implement a small, typed utility:
     - `export function hello(name: string): void { console.log(\`Hello ${name}!\`); }`
   - Keep side effects limited to stdout, no extra logging or formatting.

3. **`src/utils/hello.test.ts`** (new)
   - Add Vitest tests colocated with the utility:
     - Import `hello` from `./hello.js`.
     - Use `vi.spyOn(console, "log")` and `vi.restoreAllMocks()` in `afterEach`.
     - Two tests verifying `Hello Alice!` and `Hello Bob!` are logged exactly.

4. **`package-lock.json`**
   - Locate the `@earendil-works/pi-ai` package block and update the `bin.pi-ai` entry from `"./dist/cli.js"` to `"dist/cli.js"` (`package-lock.json` around the hunk at `index 3904098..08a9381`).
   - This aligns the lockfile with the upstream package bin configuration.

## Implementation Approach

1. **Review existing CLI patterns**
   - Open `src/cli.ts` to confirm current structure and argument parsing, especially:
     - The help/usage block printed when `args.length === 0` (the block shown in the diff).
     - The existing early `setup` subcommand handling (not shown in the diff but referenced in `.lastlight/issue-78/executor-summary.md`).
     - The server health check block (`fetch(${SERVER_URL}/health`) and subsequent subcommand routing).

2. **Extend CLI help text**
   - In the `if (args.length === 0)` usage message, add:
     - `tsx src/cli.ts hello <name>          Print a simple greeting (Hello <name>!)`
   - Ensure spacing aligns with other entries for readability.

3. **Add `hello` subcommand branch**
   - In `main()`:
     - After the `setup` branch (if present) and before the server health check, add:
       ```ts
       // Simple hello subcommand — prints a greeting and exits (no server needed)
       if (args[0] === "hello") {
         const { hello } = await import("./utils/hello.js");
         const name = args[1];
         if (!name) {
           console.error("Usage: tsx src/cli.ts hello <name>");
           process.exit(1);
         }
         hello(name);
         process.exit(0);
       }
       ```
   - Confirm that this does not alter behavior for other subcommands (triage, review, health, build, etc.) and that `hello` is fully handled before any server-dependent logic.

4. **Create `src/utils/hello.ts`**
   - Add the file with:
     ```ts
     export function hello(name: string): void {
       console.log(`Hello ${name}!`);
     }
     ```
   - Ensure the path `src/utils/` exists; if not, create the directory, but per the diff it should be created as part of this change.

5. **Create `src/utils/hello.test.ts`**
   - Add:
     ```ts
     import { describe, expect, it, vi, afterEach } from "vitest";
     import { hello } from "./hello.js";

     afterEach(() => {
       vi.restoreAllMocks();
     });

     describe("hello", () => {
       it("prints a greeting for Alice", () => {
         const spy = vi.spyOn(console, "log");
         hello("Alice");
         expect(spy).toHaveBeenCalledWith("Hello Alice!");
       });

       it("prints a greeting for Bob", () => {
         const spy = vi.spyOn(console, "log");
         hello("Bob");
         expect(spy).toHaveBeenCalledWith("Hello Bob!");
       });
     });
     ```
   - Match import style (`"./hello.js"`) and testing patterns used elsewhere in the repo (check other `*.test.ts` under `src/` for consistency).

6. **Update `package-lock.json`**
   - Locate the `@earendil-works/pi-ai` section where:
     ```json
     "bin": {
       "pi-ai": "./dist/cli.js"
     }
     ```
     appears, and change it to:
     ```json
     "bin": {
       "pi-ai": "dist/cli.js"
     }
     ```
   - Avoid touching unrelated entries in the lockfile.

7. **Sanity-check TypeScript config and module resolution**
   - Confirm via `tsconfig.json` that importing `./utils/hello.js` from TypeScript is consistent with module resolution settings (the existing codebase already uses `.js` imports in TS, so follow that convention).
   - Ensure no additional exports or re-exports are needed from other entrypoints (e.g., `src/index.ts`) since this is a CLI-only utility.

8. **Optional documentation consideration**
   - Decide whether to update `README.md`:
     - If desired, add a brief example in the CLI section showing `npx tsx src/cli.ts hello Alice` and sample output. The original PR plan treated this as optional; you can omit it to keep the README focused.

## Risks and Edge Cases

- **CLI behavior regression:** Inserting the `hello` branch in the wrong place could unintentionally bypass or interfere with existing subcommand handling. Mitigate by:
  - Placing `hello` after any `setup` special-case and before the server health check.
  - Not changing any existing branches or defaults.
- **Import path issues:** If module resolution changes, `import("./utils/hello.js")` might fail at runtime. This mirrors existing patterns, but any deviation in tsconfig or build output could surface here.
- **Lockfile drift:** Manual edits to `package-lock.json` must be minimal and precise; incorrect edits can cause future `npm install` noise or conflicts.
- **Test interference:** `console.log` spies must be restored after tests; using `afterEach` with `vi.restoreAllMocks()` as in the diff avoids leaking mocks into other test files.

## Test Strategy

After implementing or confirming the changes:

1. **Unit tests (Vitest):**
   - Run: `npm test`
   - Expect:
     - All existing tests pass.
     - New `src/utils/hello.test.ts` runs and passes (two tests).

2. **Typecheck / build:**
   - Run: `npm run build`
   - Expect:
     - `tsc` completes without errors, confirming type correctness.

3. **Optional manual CLI smoke test (local dev):**
   - With dependencies installed:
     - `npx tsx src/cli.ts hello Alice`
     - Confirm output is exactly: `Hello Alice!`
     - Run without name: `npx tsx src/cli.ts hello`
       - Confirm it prints the usage message to stderr and exits with a non-zero code.

## Estimated Complexity

- **Simple** — The change set is small, self-contained, and already well-specified by the PR diff; main work is correctly applying or verifying those edits and rerunning tests/build.