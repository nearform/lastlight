# Problem Statement

Issue [#125](https://github.com/cliftonc/lastlight/issues/125) requests a reusable helper that, given arbitrary text, returns the text reversed and lowercased. Guardrails for this issue confirm it as a normal feature/enhancement and note existing Vitest + TypeScript guardrails (`.lastlight/issue-125/guardrails-report.md:1-8,10-19,29-42`). The current codebase has domain-specific helpers (for example CLI formatting helpers in `src/cli-format.ts:1-43`) but no generic text utility that implements this behaviour. We need to introduce a small, pure helper function plus tests, following existing patterns for utility modules.

# Summary of what needs to change

- Add a new TypeScript helper function `reverseToLowercase(text: string): string` that lowercases the input and returns the characters in reverse order.
- Place this helper in a new small, focused module under `src/` (e.g. `src/text.ts`) with clear documentation and no external dependencies.
- Add a dedicated Vitest test file validating correct behaviour across typical and edge-case inputs (ASCII, punctuation, whitespace, empty string, and basic Unicode).
- Update `.lastlight/issue-125/status.md` to record that the workflow is now in the architect phase.

# Files to modify (exhaustive)

## 1. `src/text.ts` (new)

**Purpose:** New generic text helper module providing the requested function.

**Planned contents / anchors:**

- Exported function `reverseToLowercase(text: string): string`:
  - Accepts a single `text: string` parameter.
  - Implementation:
    - Convert to lowercase first: `const lower = text.toLowerCase();`.
    - Reverse characters in a Unicode-safe way for basic cases using `Array.from(lower).reverse().join("")` so surrogate pairs (e.g. emoji) are treated as single elements rather than raw UTF-16 code units.
    - Return the reversed, lowercased string.
  - Behavioural notes:
    - Empty string → returns empty string.
    - Whitespace and punctuation are preserved but appear in reversed order.
    - Multi-line strings are supported; line breaks are just characters that get reversed along with everything else.
    - Non-string inputs are not accepted by the type signature; attempting to call this with `null`/`undefined` or other non-strings is a programmer error and will surface as a runtime exception (warn-and-surface) if TypeScript is bypassed.
  - JSDoc comment describing intent, parameters, and return value, matching the style of helpers in `src/cli-format.ts:1-5,30-43` (brief, implementation-agnostic description).

## 2. `src/text.test.ts` (new)

**Purpose:** Vitest coverage for the new helper, mirroring patterns like `src/notify/model.test.ts:1-15,53-89`.

**Planned contents / anchors:**

- Import block:
  - `import { describe, it, expect } from "vitest";`
  - `import { reverseToLowercase } from "./text.js";` (matching the existing ESM import style that uses `.js` extensions in test files, e.g. `src/notify/model.test.ts:1-2`).

- `describe("reverseToLowercase", () => { ... })` suite containing at least the following tests:
  - **"reverses ASCII text and lowercases it"**
    - Input: `"HelloWorld"` → Expect: `"dlrowolleh"`.
  - **"preserves punctuation and whitespace order in the reversed output"**
    - Input: `"  Abc!  "` → Expect: `"  !cba  "` (two spaces remain, punctuation stays attached to the reversed text, all letters lowercase).
  - **"handles empty and single-character strings"**
    - `""` → `""`.
    - `"X"` → `"x"`.
  - **"handles basic Unicode and emoji by code point"**
    - Input such as `"Åß😀"` → Expect: lowercased then reversed, e.g. verify that the resulting string equals `Array.from("Åß😀".toLowerCase()).reverse().join("")` so the test encodes the same intent as the implementation and documents that reversal is by code point, not full grapheme cluster.
  - **"is pure and does not mutate the original string"**
    - Call the function and verify that reusing the original string still yields consistent results; while strings are immutable in JS, this test encodes the expectation of purity for future refactors.

## 3. `.lastlight/issue-125/status.md` (existing)

**Current contents:** Indicates `current_phase: guardrails` (`.lastlight/issue-125/status.md:1-2`).

**Planned changes:**

- Update to reflect the completion of the architect phase for this run:
  - Set `current_phase: architect`.
  - Preserve or, if necessary, augment any additional keys (e.g. keep `guardrails_status: READY`).

## 4. `.lastlight/issue-125/architect-plan.md` (this document, new)

**Purpose:** Persist the architect plan for this issue so downstream phases (executor, reviewer) can follow it verbatim.

**Planned changes:**

- This file will contain the problem statement, file manifest, commands, implementation approach, risks, and tests as specified by the workflow. No further edits should be needed beyond this initial authoring.

# Commands

From `.lastlight/issue-125/guardrails-report.md:10-19,29-42,44-51`:

- **Tests:**
  - `npm test` (alias for `vitest run`).
- **Type checking (as used in CI; full run may OOM locally):**
  - `npm run build` (runs `tsc`; may exit with code 137 in the sandbox due to memory constraints).
  - `npx tsc --noEmit` (server type check; CI).
  - `npx tsc -b dashboard` (dashboard workspace type check; CI).
- **Direct Vitest invocation (CI equivalent):**
  - `npx vitest run`.

The executor should at minimum run `npm test` after implementing the helper. If local `npm run build` fails with OOM as noted in guardrails, rely on CI for the full type-check gate and avoid treating that as a blocker.

# Implementation approach (step-by-step)

1. **Create the helper module**
   - Add a new file `src/text.ts`.
   - Implement and export `reverseToLowercase(text: string): string` as described above:
     - Lowercase the input using `text.toLowerCase()`.
     - Reverse the characters using `Array.from(lower).reverse().join("")`.
   - Add a concise JSDoc comment explaining that the function returns the lowercased, reversed version of the input and that it expects a string.

2. **Add focused unit tests**
   - Create `src/text.test.ts`.
   - Import Vitest primitives and the helper from `./text.js`.
   - Implement the test cases outlined in the file manifest to cover:
     - Simple ASCII inputs.
     - Punctuation and whitespace preservation in the reversed output.
     - Empty and single-character inputs.
     - Basic Unicode and emoji behaviour.
     - Purity (deterministic, no side effects).

3. **Run tests locally**
   - Execute `npm test` to run the entire Vitest suite, including the new tests.
   - If test failures appear, iterate on `src/text.ts` and `src/text.test.ts` until the suite passes.

4. **(Optional) Run targeted type checks**
   - Given the known OOM risk for full `npm run build`, avoid relying on it locally if it fails with exit code 137.
   - If needed, run a narrower check such as `npx tsc --noEmit src/text.ts src/text.test.ts` (or equivalent) to confirm local type correctness; CI will still run the configured full `tsc` checks.

5. **Update Last Light workflow metadata**
   - Edit `.lastlight/issue-125/status.md` to set `current_phase: architect` while preserving `guardrails_status: READY`.
   - Ensure `.lastlight/issue-125/architect-plan.md` is committed alongside the status update so later phases can reference it.

# Risks and edge cases

- **Non-string inputs**
  - Design: The helper is typed as `reverseToLowercase(text: string): string` and is intended to be used from TypeScript-checked call sites.
  - Behaviour for unsupported inputs:
    - If a caller bypasses TypeScript and passes `null`, `undefined`, or another non-string value, the call will throw at runtime when `toLowerCase` is invoked. This is considered **warn-and-surface**: the error is not swallowed and will propagate to the caller / logs, signalling misuse.

- **Empty strings and whitespace-only strings**
  - Fully supported: `""` → `""`; whitespace-only strings are reversed but otherwise unchanged (spaces, tabs, and newlines remain, just in reversed order).
  - No warnings are needed because this behaviour is well-defined and intuitive.

- **Unicode and emoji handling**
  - The implementation uses `Array.from(lower)` to reverse by Unicode code point rather than raw UTF-16 code units, which correctly keeps basic emoji and characters outside the BMP intact as single logical units.
  - Limitations: Complex grapheme clusters (e.g. some combined emoji sequences or characters plus combining marks) will still be reversed by code point, not by grapheme cluster. This can yield visually surprising results but is still a deterministic, total transform, not a skipped case. No warnings are emitted; this is acceptable for a simple helper and is documented in tests by asserting against `Array.from(text.toLowerCase()).reverse().join("")`.

- **Very long inputs**
  - For extremely long strings, `Array.from` and `reverse` allocate an intermediate array of code points. This is acceptable for typical usage in this project; there is no evidence from the issue or existing code that gigabyte-scale strings are expected.
  - If such inputs ever cause memory pressure, the behaviour will surface as a runtime error, not silent truncation or skipping.

# Test strategy

- **Unit tests for the helper**
  - Ensure `src/text.test.ts` exercises the helper across the input categories listed above, with clear test names.
  - Emphasise behaviour the issue explicitly cares about (lowercasing plus reversal) and document Unicode expectations via tests that mirror the implementation.

- **Repository-wide regression check**
  - Run `npm test` to confirm that the new helper and its tests integrate cleanly with the existing Vitest suite.
  - Rely on CI to run the full type-check pipeline (`npx tsc --noEmit`, `npx tsc -b dashboard`) given the local OOM constraints noted in guardrails.

# Estimated complexity

- **Estimated complexity:** simple — a small, self-contained helper plus a straightforward test file and metadata updates, with no impact on existing workflows or external APIs.