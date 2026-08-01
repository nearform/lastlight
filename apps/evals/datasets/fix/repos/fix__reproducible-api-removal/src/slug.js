import { kebab } from "#tiny-case";

/** Turn a title into a URL slug. */
export function slug(title) {
  return kebab(title);
}
