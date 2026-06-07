# Executor summary

Changes implemented:

1. **New utility: `getWeekDifference`**
   - **File added:** `src/engine/date-utils.ts`
   - Contents:
     ```ts
     /**
      * Returns the number of full weeks between two dates.
      *
      * - Order agnostic: the absolute difference between the dates is used.
      * - Always non-negative.
      * - Partial weeks are truncated (i.e. rounded down).
      *
      * This works in terms of UTC timestamps (via `Date.getTime()`), so leap years
      * and daylight saving time transitions are naturally accounted for by the
      * underlying JavaScript Date implementation.
      */
     export function getWeekDifference(a: Date, b: Date): number {
       const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
       const diffMs = Math.abs(a.getTime() - b.getTime());
       return Math.floor(diffMs / MS_PER_WEEK);
     }
     ```
   - Behavior:
     - Accepts two `Date` instances.
     - Uses absolute millisecond difference.
     - Divides by a constant week length (7 days) and floors to get full weeks.
     - Always returns a non-negative integer.

2. **New tests**
   - **File added:** `src/engine/date-utils.test.ts`
   - Uses Vitest; imports the utility from `./date-utils.js`.
   - Includes a UTC helper to avoid local timezone/DST ambiguity:
     ```ts
     import { describe, it, expect } from "vitest";
     import { getWeekDifference } from "./date-utils.js";

     // Helper to create a UTC date to avoid timezone/DST ambiguity
     function utcDate(
       year: number,
       month: number,
       day: number,
       hours = 0,
       minutes = 0,
       seconds = 0,
     ) {
       return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
     }
     ```
   - Test coverage:
     - **Identical dates → 0 weeks**
     - **Less than one week apart → 0 weeks**, in both argument orders.
     - **Exactly one week apart → 1 week**
     - **Multiple weeks (21 days) → 3 weeks**
     - **Order agnostic**: swapping arguments yields same result.
     - **Large span (365 days)**: `Math.floor(365 / 7)` weeks.
     - **Leap year case** `2020-02-01` to `2020-03-01` (29 days) → `Math.floor(29 / 7)` weeks.
     - **DST-related behavior**, using UTC-based dates:
       - Exactly 7 days apart → 1 week.
       - 1 ms less than 7 days → 0 weeks.
       - 1 ms more than 7 days → 1 week.

   This set of tests documents that:
   - “Weeks between” is defined as elapsed full 7×24h weeks.
   - Order does not matter.
   - Partial weeks are truncated.

3. **Exports**
   - No changes were made to `src/index.ts` or other barrels. The helper is currently internal to `src/engine/` and can be imported via:
     ```ts
     import { getWeekDifference } from "./engine/date-utils.js";
     ```
   - If you’d like it on the public API, you can add:
     ```ts
     export { getWeekDifference } from "./engine/date-utils.js";
     ```
     to `src/index.ts`.

Verification:

- **Tests**
  - Command: `npm test`
  - Result: All test files passed, including the new one:
    - `✓ src/engine/date-utils.test.ts (8 tests) 2ms`
    - Overall: `Test Files  28 passed (28); Tests  475 passed | 1 todo (476)`

- **Build / typecheck**
  - Command: `npm run build`
  - Result: TypeScript compilation completed successfully (`tsc` exited cleanly, no errors).

Files changed:

- Added: `src/engine/date-utils.ts`
- Added: `src/engine/date-utils.test.ts`
