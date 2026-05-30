## Problem Statement

The issue requests a “small, self-contained pure utility to format any date to `YYYY, MM, DD`.” There is currently no obvious shared date-formatting helper in the codebase (grep scan of `src/` for “format” shows unrelated usages, not a general date util). The goal is to add a simple, side-effect-free utility function that takes a date-like input and returns a string formatted as `YYYY, MM, DD`, with consistent zero-padding and predictable behavior for invalid input.

## Summary of What Needs to Change

- Introduce a new date-formatting utility, e.g. `formatDateYMD`, that:
  - Accepts standard date-like inputs (e.g. `Date`, ISO date string, timestamp).
  - Returns a string in the exact format `YYYY, MM, DD` (with zero-padded month/day).
  - Is pure (no I/O or global state).
- Add unit tests covering typical and edge inputs.
- Export the utility from an appropriate shared location so it can be used by future features.

## Files to Modify

Exact paths and line numbers will depend on where we place shared utilities; below is the proposed structure.

1. `src/util/date.ts` (new)
   - Define the pure helper function, e.g.:
     - `export function formatDateYmd(dateLike: Date | string | number): string`
   - Handle:
     - `Date` instances directly.
     - ISO-like strings and numeric timestamps via `new Date(...)`.
     - Invalid inputs by a clearly defined behavior (see implementation approach).
   - Implement zero-padding for month/day and ensure 4-digit year.

2. `src/util/date.test.ts` (new)
   - Vitest test suite for the new utility.
   - Cover:
     - `Date` instance input.
     - ISO string input (`"2024-01-05"`).
     - Timestamp input (`1704412800000`).
     - Edge cases: invalid date string, `NaN` timestamp, and time zone consistency (e.g. UTC vs local).

3. (Optional, if the project has a central util barrel)
   - `src/util/index.ts` (create or extend)
     - Re-export `formatDateYmd` for easier imports elsewhere:
       - `export * from "./date";`

If a `src/util/` or similar directory already exists but with a different name (e.g. `src/shared/`), the executor should adapt the paths accordingly while keeping the same content.

## Implementation Approach

1. **Choose utility location**
   - Inspect `src/` for existing utility folders (e.g. `src/util`, `src/shared`, `src/common`).
   - If a general-purpose util folder exists, add `date.ts` there.
   - If none exist, create `src/util/date.ts` as a minimal, dedicated utility module.

2. **Define the function signature**
   - Implement a single exported function:
     - `formatDateYmd(dateLike: Date | string | number): string`
   - Mark it as pure (no side effects, no external dependencies) and document its behavior in a JSDoc comment.

3. **Normalize the input to a Date instance**
   - If `dateLike` is already a `Date`, use it directly.
   - If it is a `string` or `number`, construct `new Date(dateLike)`.
   - After constructing, check `Number.isNaN(date.getTime())`; if `true`, decide on a consistent failure behavior:
     - Recommended: throw a `TypeError` with a clear message (e.g. `"Invalid date"`) so callers see errors early.
   - This keeps the utility simple and predictable.

4. **Format to `YYYY, MM, DD`**
   - Extract UTC or local components; to avoid local-time surprises, prefer UTC:
     - `const year = date.getUTCFullYear();`
     - `const month = date.getUTCMonth() + 1;`
     - `const day = date.getUTCDate();`
   - Implement zero-padding helper inline (or a small local `pad2` function):
     - `const mm = month.toString().padStart(2, "0");`
     - `const dd = day.toString().padStart(2, "0");`
   - Return the final string:
     - ```${year}, ${mm}, ${dd}```.

5. **Add unit tests**
   - Create `src/util/date.test.ts` (or equivalent path) with Vitest:
     - Test that:
       - `formatDateYmd(new Date(Date.UTC(2024, 0, 5))) === "2024, 01, 05"`.
       - `formatDateYmd("2024-01-05")` returns the same value (confirm UTC-based behavior).
       - `formatDateYmd(1704412800000)` (a timestamp corresponding to a known UTC date) matches.
     - Edge cases:
       - Invalid string (`"not-a-date"`) throws a `TypeError`.
       - `NaN` timestamp throws.
       - Optional: confirm that passing a `Date` with a non-UTC time still yields consistent `YYYY, MM, DD` output based on UTC.
   - Keep tests self-contained; no dependence on other parts of the app.

6. **Export from a barrel (if applicable)**
   - If there is a `src/util/index.ts` or similar:
     - Add `export * from "./date";`
   - If not, and no central barrel is used elsewhere, skip this and import directly from `src/util/date`.

7. **Run tests and typecheck**
   - Use existing repo commands:
     - `npm test` (runs Vitest).
     - `npm run build` (TypeScript `tsc` typecheck).

## Risks and Edge Cases

- **Time zone ambiguity**
  - Using local time (`getFullYear`, `getMonth`, `getDate`) can yield different results across environments near midnight.
  - Using UTC methods (`getUTCFullYear`, etc.) avoids environment-specific shifts and is preferable for a pure formatting helper.
- **Invalid input behavior**
  - Silently returning something like `"NaN, NaN, NaN"` is confusing.
  - Explicitly throwing on invalid dates is clearer but means callers must handle exceptions; this is acceptable for a shared utility, but should be noted in the docstring.
- **Input flexibility**
  - Supporting `Date | string | number` is useful but means more chances to receive bad input (e.g. locale-specific strings).
  - Keeping the implementation minimal and documented helps; if future needs arise (e.g. strict ISO-only), the function can be extended.

## Test Strategy

Run the existing commands (from `package.json`):

- Unit tests:  
  - `npm test`
- Typecheck (build):  
  - `npm run build`

No additional lint command is defined; `npm run build` via `tsc` will catch type-level issues.

## Estimated Complexity

- **Simple**: small, self-contained utility plus a compact test file, no integration into existing flows required.