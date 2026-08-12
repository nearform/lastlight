/**
 * The theme preference is three-state: `system` | `dark` | `light` (issue #331).
 *
 * `system` is the interesting one. It used to exist only as an ACCIDENT of
 * having no stored value: the boot script fell back to `prefers-color-scheme`,
 * so a first-time visitor tracked the OS, and the first click of the toggle
 * wrote a resolved theme and pinned it forever with no UI to clear it.
 *
 * Imported rather than read as text, unlike its sibling
 * `dashboard-config-mirror` — this module is deliberately pure (no React, no
 * DOM) precisely so the rule can be tested rather than asserted about. The
 * component and the pre-paint boot script in `index.html` both consume it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_PREFERENCE,
  STORAGE_KEY,
  nextPreference,
  parsePreference,
  resolveTheme,
} from "../../dashboard/src/lib/theme.js";

describe("theme preference (issue #331)", () => {
  describe("resolveTheme", () => {
    it("follows the OS when the preference is `system`", () => {
      expect(resolveTheme("system", true)).toBe("lastlight");
      expect(resolveTheme("system", false)).toBe("neaform");
    });

    it("ignores the OS when the preference is explicit", () => {
      expect(resolveTheme("dark", false)).toBe("lastlight");
      expect(resolveTheme("light", true)).toBe("neaform");
    });
  });

  describe("parsePreference", () => {
    it("defaults to `system` when nothing is stored", () => {
      expect(parsePreference(null)).toBe("system");
      expect(DEFAULT_PREFERENCE).toBe("system");
    });

    it("reads a stored preference back", () => {
      expect(parsePreference("system")).toBe("system");
      expect(parsePreference("dark")).toBe("dark");
      expect(parsePreference("light")).toBe("light");
    });

    it("honours the pre-#331 stored values as explicit choices", () => {
      // Migration is free BECAUSE these two are exactly `dark` and `light`.
      // Reading them as `system` would silently discard a preference someone
      // set deliberately — the one thing a theme migration must not do.
      expect(parsePreference("lastlight")).toBe("dark");
      expect(parsePreference("neaform")).toBe("light");
    });

    it("falls back to `system` on anything unrecognised", () => {
      expect(parsePreference("")).toBe("system");
      expect(parsePreference("solarized")).toBe("system");
    });
  });

  describe("nextPreference", () => {
    it("cycles system → dark → light → system", () => {
      expect(nextPreference("system")).toBe("dark");
      expect(nextPreference("dark")).toBe("light");
      expect(nextPreference("light")).toBe("system");
    });

    it("returns to its starting point in exactly three steps", () => {
      let p = DEFAULT_PREFERENCE;
      const seen = [p];
      for (let i = 0; i < 3; i++) {
        p = nextPreference(p);
        seen.push(p);
      }
      expect(seen).toEqual(["system", "dark", "light", "system"]);
    });
  });

  it("keeps the boot script in step with the module", () => {
    // The pre-paint script in index.html cannot import the bundle — it runs
    // before it exists — so the resolution rule is duplicated there by
    // necessity. That makes it the one place this can silently drift, so pin
    // the two facts it has to get right: the storage key, and that it knows
    // `system` is a value rather than a theme name to set verbatim.
    const html = readFileSync(
      join(import.meta.dirname, "../../dashboard/index.html"),
      "utf8",
    );
    expect(html).toContain(STORAGE_KEY);
    expect(html).toContain("system");
    expect(html).toContain("prefers-color-scheme");
  });
});
