# Executor summary

Changes made

1. Added a new date utility implementing the architect’s plan.
2. Added focused Vitest coverage for the new helper.
3. Ensured tests and TypeScript build pass cleanly.

---

## Files changed

### 1) `src/utils/date.ts` (new)

Implemented `weeksBetween` with UTC-midnight normalization and validation:

```ts
/**
 * Returns the number of whole calendar weeks between two dates.
 *
 * Both inputs are normalized to UTC midnight before computing the
 * difference, so the result is independent of time-of-day or local
 * timezone/DST differences. The result is always a non-negative integer.
 */
export function weeksBetween(a: Date | string, b: Date | string): number {
  const dateA = toValidDate(a, 'a');
  const dateB = toValidDate(b, 'b');

  const normalizedA = normalizeToUtcMidnight(dateA);
  const normalizedB = normalizeToUtcMidnight(dateB);

  const diffMs = Math.abs(normalizedA.getTime() - normalizedB.getTime());
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

  return Math.floor(diffMs / MS_PER_WEEK);
}

function toValidDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date input for ${label}`);
  }

  return date;
}

function normalizeToUtcMidnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}
```

Behavior:

- Accepts `Date` or string (ISO-like) inputs.
- Validates both inputs; throws `Error("Invalid date input for a|b")` if parsing fails.
- Normalizes both dates to UTC midnight to avoid time-of-day/DST issues.
- Returns `Math.floor` of absolute diff in weeks (non-negative integer).
- Symmetric in its arguments.

No central barrel export pattern for utilities was evident in `src/`, so this utility is currently internal; future features can import from `src/utils/date.js` in TS code as needed.

---

### 2) `src/utils/date.test.ts` (new)

Vitest tests for core and edge behaviors:

```ts
import { describe, expect, it } from 'vitest';
import { weeksBetween } from './date.js';

describe('weeksBetween', () => {
  it('returns 0 for the same date', () => {
    const a = new Date('2024-01-01');
    const b = new Date('2024-01-01');

    expect(weeksBetween(a, b)).toBe(0);
  });

  it('returns 0 when dates are less than one week apart', () => {
    const a = new Date('2024-01-01');
    const b = new Date('2024-01-04');

    expect(weeksBetween(a, b)).toBe(0);
  });

  it('returns 1 when dates are exactly one week apart', () => {
    const a = new Date('2024-01-01');
    const b = new Date('2024-01-08');

    expect(weeksBetween(a, b)).toBe(1);
  });

  it('returns the number of full weeks between dates', () => {
    const a = new Date('2024-01-01');
    const b = new Date('2024-01-29'); // 4 weeks apart

    expect(weeksBetween(a, b)).toBe(4);
  });

  it('is symmetric with respect to argument order', () => {
    const a = '2024-01-01';
    const b = '2024-02-01';

    expect(weeksBetween(a, b)).toBe(weeksBetween(b, a));
  });

  it('accepts a mix of Date and string inputs', () => {
    const a = new Date('2024-01-01');
    const b = '2024-01-15';

    expect(weeksBetween(a, b)).toBe(2);
  });

  it('normalizes time-of-day differences via UTC midnight', () => {
    const a = new Date('2024-01-01T23:59:59.000Z');
    const b = new Date('2024-01-08T00:00:01.000Z');

    expect(weeksBetween(a, b)).toBe(1);
  });

  it('throws a useful error on invalid dates', () => {
    expect(() =>
      weeksBetween('not-a-date' as string, '2024-01-01'),
    ).toThrow(/Invalid date input/);
  });
});
```

Notes:

- Import uses `./date.js` to satisfy `moduleResolution: node16`/`nodenext` TS requirement for explicit extensions.
- Tests exercise:
  - Same date → `0`.
  - Less than 7 days apart → `0`.
  - Exactly one week → `1`.
  - Multiple full weeks.
  - Symmetry in argument order.
  - Mixed `Date` and string inputs.
  - Time-of-day normalization via UTC midnight.
  - Explicit error behavior on invalid date input.

---

## Commands run and results

1. `npm test`

- Result: **Pass**
- Summary:
  - Test Files: 28 passed
  - Tests: 475 passed | 1 todo (476)
  - Includes the new `src/utils/date.test.ts` (8 tests passed).

2. `npm run build`

- First run: **Failed** due to TS configuration requiring explicit `.js` extension in relative imports under Node16/NodeNext module resolution:
  - `src/utils/date.test.ts(2,30): error TS2835: Relative import paths need explicit file extensions...`
- Fix: Updated the import in `src/utils/date.test.ts` to `./date.js`.
- Second run: **Pass** (TypeScript `tsc` completed with no errors).
