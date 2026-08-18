/**
 * Theme resolution — pure, so both consumers can share one rule (issue #331).
 *
 * There are two of them and they cannot import each other: `hooks/useTheme.tsx`
 * runs inside React, and the pre-paint script in `index.html` runs *before the
 * bundle exists* (it has to, or the page flashes the wrong theme). The script
 * therefore inlines this logic by necessity — but it inlines a rule that is
 * written down and tested here, rather than a second opinion.
 *
 * No React, no DOM: the preference is a value, and resolving it is arithmetic
 * on that value plus one boolean the caller reads from `matchMedia`.
 */

/** What the user asked for — NOT what is currently displayed. */
export type ThemePreference = "system" | "dark" | "light";

/** The daisyUI theme names this app ships. */
export type Theme = "lastlight" | "neaform";

export const STORAGE_KEY = "ll-theme";

/**
 * Follow the OS unless told otherwise.
 *
 * This was already the *effective* default — the boot script fell back to
 * `prefers-color-scheme` whenever nothing was stored — but it existed only as
 * the absence of a preference, so the first click of the toggle destroyed it
 * permanently and no UI could get it back.
 */
export const DEFAULT_PREFERENCE: ThemePreference = "system";

/** The cycle order of the header control: system → dark → light → system. */
const CYCLE: readonly ThemePreference[] = ["system", "dark", "light"];

/**
 * Resolve a preference to the theme to apply.
 *
 * `systemPrefersDark` is the caller's reading of
 * `matchMedia("(prefers-color-scheme: dark)")`, passed in rather than read here
 * so this stays testable and so the React consumer can re-resolve on the media
 * query's `change` event instead of only at mount.
 */
export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): Theme {
  if (pref === "dark") return "lastlight";
  if (pref === "light") return "neaform";
  return systemPrefersDark ? "lastlight" : "neaform";
}

/**
 * Read a stored value back, tolerating everything.
 *
 * **The two legacy names are load-bearing.** Before this existed the key held a
 * resolved THEME (`lastlight` / `neaform`), written the moment anyone touched
 * the toggle. Those are exactly the `dark` / `light` preferences, so honouring
 * them migrates every existing user's choice for free — and reading them as
 * `system` instead would silently discard a preference somebody set on purpose,
 * which is the one thing a theme migration must not do.
 *
 * Anything else — absent, empty, a hand-edited value, a theme this build no
 * longer ships — falls back to `system`, because following the OS is the safe
 * answer to "we do not know what you wanted".
 */
export function parsePreference(raw: string | null | undefined): ThemePreference {
  switch (raw) {
    case "system":
      return "system";
    case "dark":
    case "lastlight":
      return "dark";
    case "light":
    case "neaform":
      return "light";
    default:
      return DEFAULT_PREFERENCE;
  }
}

/** The next preference in the cycle, wrapping at the end. */
export function nextPreference(pref: ThemePreference): ThemePreference {
  const i = CYCLE.indexOf(pref);
  return CYCLE[(i + 1) % CYCLE.length]!;
}
