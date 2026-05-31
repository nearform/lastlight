## Problem Statement

Issue [#78](https://github.com/cliftonc/lastlight/issues/78) requests a small, reusable function that accepts a name and prints `Hello ${name}!`. There is no existing helper dedicated to this behavior in the codebase; it’s a self‑contained feature request with no specified target module or usage site. To keep it generally useful across the harness, it should live in a small utility module under `src/` and be easy to import from any future caller.

## Summary of What Needs to Change

- Introduce a new reusable function that:
  - Accepts a `name` (string).
  - Prints `Hello ${name}!` to stdout.
  - Is exported from a stable location under `src/` for reuse.
- Optionally add a minimal unit test to validate behavior and stabilize the API.

## Files to Modify

1. `src/utils/hello.ts` (new file)
   - Add the implementation of the function, e.g. `printHello(name: string): void`.
   - Keep it framework‑agnostic and side‑effect limited to `console.log`.

2. `src/index.ts` (or another central entry file, depending on desired exposure)
   - Re‑export the new function so it’s easy to import from the package root (if consistent with project conventions).
   - This makes it straightforward to use in any new feature or script: `import { printHello } from './utils/hello'` or from the package root.

3. `tests/hello.test.ts` (new file; name can match existing test layout)
   - Add a Vitest test to verify that calling the function produces exactly `Hello ${name}!` on stdout.
   - Use `vi.spyOn(console, 'log')` (or equivalent) to assert the log output.

If the repository has a more specific utilities folder (e.g. `src/engine/` or `src/admin/` with existing small helpers), the final placement can be refined, but the above is the default.

## Implementation Approach

1. **Create the utility module**
   - Add `src/utils/hello.ts`.
   - Implement and export a function, for example:
     - Signature: `export function printHello(name: string): void`.
     - Body: call `console.log(\`Hello ${name}!\`)`.
   - Add a brief JSDoc comment describing the behavior and intended usage.

2. **Optional: Type safety and input handling**
   - Ensure the `name` parameter is typed as `string`.
   - Keep behavior simple per the issue: treat the value as-is and interpolate; no trimming or validation unless requested.
   - If the executor wants to be defensive, they can coerce non‑string inputs to string (`String(name)`), but this is not required by the issue.

3. **Expose the function from an appropriate entry point**
   - Decide whether to re‑export from `src/index.ts` (if this file already serves as the main public API surface).
   - If that’s consistent with current exports, add:
     - `export { printHello } from './utils/hello';`
   - If `src/index.ts` is not a public API surface but just the harness entry point, skip re‑exporting and leave the function as an internal helper; the executor can wire it up later wherever it’s needed.

4. **Add unit tests**
   - Create `tests/hello.test.ts` (or align with existing test directory structure, e.g. `src/__tests__/hello.test.ts` if that’s what the repo uses).
   - In the test:
     - Import the function from `src/utils/hello`.
     - Spy on `console.log` using Vitest: `const spy = vi.spyOn(console, 'log').mockImplementation(() => {});`
     - Call `printHello('World')`.
     - Assert `spy` was called exactly once with `'Hello World!'`.
     - Restore the spy after the test.
   - Optionally add a second test with another name (e.g. `Alice`) to further ensure formatting is correct.

5. **(Optional) Demonstration hook**
   - If desired for clarity, add a small, commented‑out example in `src/index.ts` showing how to call `printHello('World')`, but avoid introducing side effects at startup of the harness.

## Risks and Edge Cases

- **Side effects in production paths**: The function itself is side‑effectful (it logs), but it should only be invoked from code paths where printing is acceptable (e.g. CLI helpers or examples), not from hot paths that must be silent.
- **API surface**: Re‑exporting from `src/index.ts` makes this part of the public API; changing its signature later would be a breaking change. If the team wants to keep it strictly internal, skip the re‑export.
- **Input assumptions**: The issue doesn’t specify behavior for non‑string inputs or empty strings. Keeping the function simple (`name: string`) and not validating is consistent with the request but should be noted in JSDoc.

## Test Strategy

Use the existing test runner:

- Run all tests:
  - `npm test`
- If a narrower run is configured (e.g. Vitest file pattern), the executor may use:
  - `npx vitest run hello.test.ts` (or the appropriate path/pattern), but this is optional; `npm test` is the canonical command.

Also ensure TypeScript compilation continues to pass:

- `npm run build`

## Estimated Complexity

- **Simple**: A single small utility function, one optional re‑export, and a minimal test.