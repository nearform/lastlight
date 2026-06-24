/**
 * Returns a new string containing the characters of the input text
 * lowercased and in reverse order.
 *
 * The input is first converted to lowercase, then reversed by Unicode
 * code point using `Array.from`, so basic emoji and non-BMP characters
 * are treated as single units. Complex grapheme clusters may still be
 * reversed by code point rather than by visual cluster.
 *
 * @param text - The input text to transform.
 * @returns The lowercased, reversed representation of the input text.
 */
export function reverseToLowercase(text: string): string {
  const lower = text.toLowerCase();
  return Array.from(lower).reverse().join("");
}
