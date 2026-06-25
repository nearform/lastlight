/**
 * Concatenate two strings using JavaScript's built-in string concatenation.
 *
 * This helper is pure: it does not mutate its inputs and has no side effects.
 * Both arguments are expected to be valid strings; callers are responsible
 * for any necessary coercion or validation before calling.
 */
export function concatStrings(a: string, b: string): string {
  return a + b;
}
