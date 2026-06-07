## Problem Statement

Issue #82 requests a reusable function that “calculates the number of weeks between two dates,” handles the dates in any order, and “always returns a positive number or 0 - no decimals.” Currently, there is no such helper in the codebase (`src/**/*.ts` has no “difference” utilities and no “week” helpers beyond health-report naming; `src/cli.ts:9-13`, `src/engine/chat.ts:47-51`, `src/workflows/loader.test.ts:191-201,224-361`). We need to introduce a small, well-typed date-difference utility and add tests to codify these requirements.

## Summary of What Needs to Change

- Add a new utility function (e.g., `weeksBetweenDates`) that:
  - Accepts two dates (`Date` instances or ISO date strings, depending on chosen API).
  - Computes the absolute difference in weeks between them.
  - Returns a non-negative integer number of weeks (no decimals).
- Define clear rounding semantics (e.g., floor of absolute day difference divided by 7) and document them.
- Add unit tests to cover ordering, same-day, partial-week, and multi-week scenarios.
- Export the function from a sensible shared utility module so it’s reusable by future features (e.g., reports that reason in weeks).

## Files to Modify

1. **New utility module (exact path to be chosen; suggestion below)**
   - `src/utils/date.ts` (new file)
     - Implement the `weeksBetweenDates` function and any small helpers.
     - Export it for reuse.

2. **Utilities index (if project has one)**
   - If there is an existing utilities barrel (none obvious from tree listing), we can skip this; otherwise, add an export (e.g., `src/index.ts:1-...` currently wires entrypoints, so better keep the date util in its own file, imported directly where needed later).

3. **New test file**
   - `src/utils/date.test.ts` (new file)
     - Use Vitest (test runner established in `CLAUDE.md` and Guardrails) to define behavior tests for `weeksBetweenDates`.

No existing code paths currently depend on such a function, so this is an additive change with no caller updates needed right away.

## Implementation Approach

1. **Decide the API and semantics**
   - Function name: `weeksBetweenDates`.
   - Signature:
     ```ts
     export function weeksBetweenDates(a: Date | string, b: Date | string): number;
     ```
   - Behavior:
     - Convert each argument to a `Date` (if already `Date`, use as-is; if string, use `new Date(value)`).
     - If the resulting Date is invalid (e.g., `Number.isNaN(date.getTime())`), throw a descriptive error (e.g., `new Error("Invalid date input")`).
     - Compute the absolute difference in milliseconds:
       ```ts
       const diffMs = Math.abs(aDate.getTime() - bDate.getTime());
       ```
     - Convert to days and then weeks:
       ```ts
       const days = diffMs / (1000 * 60 * 60 * 24);
       const weeks = Math.floor(days / 7);
       ```
     - Return `weeks` as an integer.
   - This yields:
     - Same date → 0 weeks.
     - 1–6 days apart → 0 weeks.
     - 7–13 days apart → 1 week.
     - 14–20 days apart → 2 weeks, etc.

2. **Create the utility module**
   - Add `src/utils/date.ts` with:
     - A small helper `toDate(input: Date | string): Date` that normalizes and validates.
     - The main exported `weeksBetweenDates` function.
   - Include inline documentation comments explaining:
     - Inputs accepted.
     - That the function is order-agnostic and always returns a non-negative integer count of full weeks.
     - The rounding rule (floor of full weeks, partial weeks ignored).

3. **Add tests**
   - Create `src/utils/date.test.ts` using Vitest conventions used elsewhere in the repo (e.g., `src/admin/auth.test.ts`, `src/cron/fanout.test.ts`, etc.).
   - Import `weeksBetweenDates` from `./date`.
   - Add test cases:
     1. **Same date, Date objects**
        - `weeksBetweenDates(new Date("2024-01-01"), new Date("2024-01-01")) === 0`.
     2. **Same date, string inputs**
        - Demonstrate the string overload also returns `0`.
     3. **One day apart**
        - `weeksBetweenDates("2024-01-01", "2024-01-02") === 0`.
     4. **Six days apart**
        - `weeksBetweenDates("2024-01-01", "2024-01-07") === 0` (ensure order-agnostic by calling both `(a, b)` and `(b, a)`).
     5. **Exactly one week apart**
        - `weeksBetweenDates("2024-01-01", "2024-01-08") === 1`.
     6. **Multiple weeks**
        - `weeksBetweenDates("2024-01-01", "2024-01-29")` → 4 weeks.
     7. **Non-chronological argument order**
        - Call with later date first and ensure same result.
     8. **Invalid date string**
        - Expect an error to be thrown for clearly invalid inputs (e.g., `"not-a-date"`).
   - If the project uses a standard style for `describe`/`it` naming (see existing tests like `src/engine/router.test.ts`), mirror that style.

4. **Optional: future-proofing**
   - Keep the utility self-contained with no external dependencies.
   - Avoid timezone surprises by emphasizing that the function uses native JS `Date` semantics; for now, we do not attempt to normalize to UTC midnight beyond what `Date` already does.
   - Comment that this is “whole weeks based on 24-hour days” rather than calendar-week boundaries (Monday–Sunday).

## Risks and Edge Cases

- **Timezone and DST boundaries**:
  - Native `Date` math is in milliseconds since epoch; 24-hour boundaries around daylight savings can introduce off-by-one-day anomalies for real-world times with non-midnight local times.
  - Mitigation: in tests, use ISO date strings (which default to UTC at midnight when specified with full `YYYY-MM-DD` format) to keep expectations stable. Document that the function is based on absolute time difference, not calendar weeks or local-week heuristics.

- **Invalid input handling**:
  - If `new Date(string)` yields an invalid date, we should fail fast with a clear error rather than returning `NaN` or a misleading integer.
  - Tests will verify that behavior.

- **Partial-week expectations**:
  - The issue says “number of weeks between two dates” and “no decimals,” but doesn’t define rounding. Choosing floor (whole weeks) is sensible and easy to explain; explicitly codify this in comments and tests.
  - If a different rounding mode is later desired (e.g., rounding to nearest week), this will be a clearly intentional change to the contract.

Overall, this is a low-risk, additive change.

## Test Strategy

From the Guardrails report and `CLAUDE.md`:

- Run the Vitest suite:
  - `npm test`
- Run TypeScript build/typecheck:
  - `npm run build`

Both should pass after adding `src/utils/date.ts` and `src/utils/date.test.ts`.

## Estimated Complexity

- **Complexity: simple**

The change is localized to a new utility and its tests with no impact on existing flows.