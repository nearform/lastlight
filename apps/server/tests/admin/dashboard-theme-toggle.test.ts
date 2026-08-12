/**
 * The theme control is rendered in ONE place (issue #331 review).
 *
 * It was two: `StatsHeader` and `Login` each drew their own button with their
 * own icon and tooltip. When the preference went three-state, only the header
 * was updated — so the sign-in page kept a binary Moon/Sun against a cycling
 * action, and two ordinary paths produced a click that changed the preference
 * while changing nothing visible:
 *
 *   - `system` on a dark OS → `dark`: both resolve to `lastlight`.
 *   - `light` on a light OS → `system`: both resolve to `neaform`.
 *
 * A control whose icon is derived from `isDark` cannot express a three-state
 * preference, and there is no version of that fix which stays correct while
 * being written down twice. So the assertion is not "both call sites agree" —
 * it is that there is only one.
 *
 * Source-level, like `dashboard-config-mirror`: the SPA has no import edge to
 * core, and "a component grew its own toggle" is a fact about text.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const COMPONENTS = join(import.meta.dirname, "../../dashboard/src/components");

/** The one component allowed to render the control. */
const TOGGLE = "ThemeToggle.tsx";

describe("dashboard theme toggle (issue #331)", () => {
  it("exists as a single shared component", () => {
    expect(existsSync(join(COMPONENTS, TOGGLE))).toBe(true);
  });

  it("is the only component that calls toggleTheme", () => {
    const offenders = readdirSync(COMPONENTS)
      .filter((f) => f.endsWith(".tsx") && f !== TOGGLE)
      .filter((f) => readFileSync(join(COMPONENTS, f), "utf8").includes("toggleTheme"));

    expect(offenders).toEqual([]);
  });

  it("derives its icon from the PREFERENCE, not from isDark", () => {
    // `isDark` has two values and the preference has three, so an icon chosen
    // from `isDark` is the exact defect this replaces: it cannot distinguish
    // "dark because you asked" from "dark because your OS is".
    const src = readFileSync(join(COMPONENTS, TOGGLE), "utf8");
    expect(src).toContain("preference");
    expect(src).not.toMatch(/isDark\s*\?/);
  });

  it("renders both call sites through it", () => {
    for (const file of ["StatsHeader.tsx", "Login.tsx"]) {
      expect(readFileSync(join(COMPONENTS, file), "utf8")).toContain("<ThemeToggle");
    }
  });
});
