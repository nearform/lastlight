/**
 * The status palette is defined ONCE for the whole SPA (issue #329).
 *
 * `good` and `bad` are the same idea on every page — a run that succeeded and
 * a 👍 are both "good" — so they must be the same two hexes. They were not:
 * the Home page and the Feedback page each carried their own `CHART_DARK` /
 * `CHART_LIGHT` literals, and after the outcome work landed they disagreed by
 * ΔE 9.3 (green) and 7.3 (red). That is the worst possible distance: near
 * enough to read as the same idea, far enough to look like a bug.
 *
 * Feedback's copy was also the pre-fix pastel pair, `#86efac` / `#fca5a5`,
 * which measures **ΔE 5.8 for deuteranopes** — below the ΔE 6 floor — on the
 * two quantities in that view most needing to be told apart.
 *
 * Read as TEXT rather than imported, exactly like `dashboard-config-mirror`:
 * the SPA is a separate Vite app with no import edge to core, and "a page
 * hardcoded its own status hex" is a source-level fact.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DASHBOARD = join(import.meta.dirname, "../../dashboard/src");
const read = (rel: string) => readFileSync(join(DASHBOARD, rel), "utf8");

/**
 * The same source with comments stripped.
 *
 * The invariant is about CODE: a page must not *use* its own status hex. Prose
 * is the opposite — `FeedbackPage` names the retired `#86efac` / `#fca5a5`
 * precisely to record why they went, and a test that forbade saying so would
 * push out the explanation and keep the bug's epitaph nowhere.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** The one module allowed to name a status colour. */
const PALETTE = "lib/status-colors.ts";

/** Every page that renders a status colour, and must therefore import them. */
const CONSUMERS = ["components/HomePage.tsx", "components/FeedbackPage.tsx"];

/**
 * The retired literals. Each is a hex some page used to hardcode for a status
 * meaning; none may reappear anywhere in the SPA.
 *
 * `#07a06f` and `#dc2626` are the old light-theme good/bad, `#86efac` and
 * `#fca5a5` the dark-theme pair that failed CVD separation.
 */
const RETIRED = ["#07a06f", "#dc2626", "#86efac", "#fca5a5"];

describe("dashboard status palette (issue #329)", () => {
  it("defines the four status colours in one shared module", () => {
    expect(existsSync(join(DASHBOARD, PALETTE))).toBe(true);

    const src = read(PALETTE);
    for (const key of ["good", "neutral", "info", "bad"]) {
      expect(src).toMatch(new RegExp(`\\b${key}\\s*:`));
    }
  });

  it("keeps the validated good/bad pair, which is what repairs the CVD failure", () => {
    const src = read(PALETTE);
    expect(src).toContain("#0ca30c");
    expect(src).toContain("#cc2b5e");
  });

  it.each(CONSUMERS)("%s imports the palette rather than naming its own", (file) => {
    expect(read(file)).toMatch(/from\s+"\.\.\/lib\/status-colors"/);
  });

  it.each(CONSUMERS)("%s hardcodes no retired status hex", (file) => {
    const src = readCode(file);
    for (const hex of RETIRED) {
      expect(src).not.toContain(hex);
    }
  });

  it("names each status colour in exactly one place across the SPA", () => {
    // The palette module owns them; a page repeating a hex is the drift this
    // test exists to catch, whichever page does it.
    for (const file of CONSUMERS) {
      const src = readCode(file);
      for (const hex of ["#0ca30c", "#cc2b5e", "#4a7fb5", "#6b7280"]) {
        expect(src).not.toContain(hex);
      }
    }
  });
});
