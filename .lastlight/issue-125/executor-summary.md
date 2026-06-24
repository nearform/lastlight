# Executor summary for issue #125

## What was implemented

- Added a new generic text helper module:
  - `src/text.ts`
    - Exports `reverseToLowercase(text: string): string`.
    - Behaviour:
      - Lowercases the input using `text.toLowerCase()`.
      - Reverses by Unicode code point using `Array.from(lower).reverse().join("")`.
      - Handles empty strings, whitespace, punctuation, and basic Unicode/emoji as described in the architect plan.
    - Documented with a JSDoc comment explaining intent, parameters, and return value.
- Added focused Vitest coverage:
  - `src/text.test.ts`
    - Test cases:
      - "reverses ASCII text and lowercases it" (`"HelloWorld"` → `"dlrowolleh"`).
      - "preserves punctuation and whitespace order in the reversed output" (`"  Abc!  "` → `"  !cba  "`).
      - "handles empty and single-character strings" (`""` → `""`, `"X"` → `"x"`).
      - "handles basic Unicode and emoji by code point" (asserts against `Array.from(input.toLowerCase()).reverse().join("")` for `"Åß😀"`).
      - "is pure and does not mutate the original string" (verifies deterministic output and that the original string remains unchanged).
- Updated workflow metadata:
  - `.lastlight/issue-125/status.md`
    - Set `current_phase: executor`.
    - Preserved `guardrails_status: READY`.

## Test / lint / typecheck commands and results

> Note: Dependency installation (`npm ci` / `npm install`) repeatedly exited with code 137 (likely OOM) due to the Node/engine constraints noted in guardrails. As a result, key dev dependencies (notably `vitest` and `typescript`) are not available in `node_modules`, and the test/typecheck commands cannot complete successfully. All relevant commands were still attempted and their outputs are recorded below.

### Install / tooling setup

- `npm ci`

  ```text
  npm warn EBADENGINE Unsupported engine {
  npm warn EBADENGINE   package: '@earendil-works/gondolin@0.12.0',
  npm warn EBADENGINE   required: { node: '>=23.6.0' },
  npm warn EBADENGINE   current: { node: 'v22.23.0', npm: '10.9.8' }
  npm warn EBADENGINE }
  Killed
  
  Command exited with code 137
  ```

- `npm install vitest --save-dev` (attempted targeted install for the missing test runner)

  ```text
  npm warn EBADENGINE Unsupported engine {
  npm warn EBADENGINE   package: '@earendil-works/gondolin@0.12.0',
  npm warn EBADENGINE   required: { node: '>=23.6.0' },
  npm warn EBADENGINE   current: { node: 'v22.23.0', npm: '10.9.8' }
  npm warn EBADENGINE }
  Killed
  
  Command exited with code 137
  ```

### Targeted tests during development

- `npx vitest run src/text.test.ts` (before and after implementation)

  ```text
  vitest.config.ts (1:241) [UNRESOLVED_IMPORT] Could not resolve 'vitest/config' in vitest.config.ts
  ...
  failed to load config from /workspace/vitest.config.ts
  
  Startup Error
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/workspace/node_modules/vitest/config' imported from /workspace/node_modules/.vite-temp/vitest.config.ts.timestamp-....mjs
  
  Command exited with code 1
  ```

  This indicates that the `vitest` package (and its `vitest/config` entrypoint) is not present in `node_modules`, and attempts to install it via npm fail with code 137 as shown above.

### Full test suite

- `npm test`

  ```text
  > lastlight@0.1.15 test
  > vitest run
  
  sh: 1: vitest: not found
  
  Command exited with code 127
  ```

### Type checking

- `npm run build`

  ```text
  > lastlight@0.1.15 build
  > tsc
  
  sh: 1: tsc: not found
  
  Command exited with code 127
  ```

- `npx tsc --noEmit`

  ```text
  This is not the tsc command you are looking for
  
  To get access to the TypeScript compiler, tsc, from the command line either:
  
  - Use npm install typescript to first add TypeScript to your project before using npx
  - Use yarn to avoid accidentally running code from un-installed packages
  
  npm warn exec The following package was not found and will be installed: tsc@2.0.4
  npm warn deprecated tsc@2.0.4: Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.
  
  Command exited with code 1
  ```

- `npx tsc -b dashboard`

  ```text
  This is not the tsc command you are looking for
  
  To get access to the TypeScript compiler, tsc, from the command line either:
  
  - Use npm install typescript to first add TypeScript to your project before using npx
  - Use yarn to avoid accidentally running code from un-installed packages
  
  Command exited with code 1
  ```

## Deviations from the architect plan / known issues

- The implementation of `reverseToLowercase` and its tests follows the architect plan verbatim (module location, function signature, behaviour, and test coverage).
- The only deviation is in verification:
  - The architect plan expected `npm test` (and optionally the broader `tsc` commands) to run successfully.
  - In this sandbox, dependency installation via `npm ci` and a targeted `npm install vitest --save-dev` both exited with code 137, leaving key dev dependencies (`vitest`, `typescript`) unavailable.
  - As a result, all test and typecheck commands (`npx vitest ...`, `npm test`, `npm run build`, `npx tsc ...`) failed before executing any actual tests or type checking.
- Known limitations / risks:
  - The new helper and tests have not been executed in this environment due to the above tooling issues. Logical correctness has been verified by inspection, but runtime verification is deferred to CI where the full Node/toolchain and memory settings should allow `npm ci`, `npm test`, and `tsc` to run successfully.
  - Unicode behaviour is intentionally limited to code-point-level reversal as documented in both the JSDoc and tests; complex grapheme clusters may exhibit visually surprising results, matching the architect's documented trade-offs.
