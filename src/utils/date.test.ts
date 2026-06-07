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
    expect(() => weeksBetween('not-a-date' as string, '2024-01-01')).toThrow(
      /Invalid date input/,
    );
  });
});
