/**
 * The reserved STATUS palette — the one place in the SPA that names a colour
 * meaning "good", "bad", "informational" or "nothing happened" (issue #329).
 *
 * Status colours are a different job from categorical ones. A categorical hue
 * answers *which series is this?* and may be themed freely; a status hue
 * answers *how bad is this?* and must mean the same thing on every page. A run
 * that succeeded and a 👍 are both `good`, so they are the same green — they
 * were not, and the two pages drifted ΔE 9.3 (green) and 7.3 (red) apart:
 * near enough to read as one idea, far enough to look like a bug.
 *
 * **Mode-invariant on purpose.** The same four steps clear 3:1 on the light
 * card (`#ffffff`) and the dark one (`#161b22`), and re-stepping them per
 * theme would re-open the separation problem below for no gain.
 *
 * ## Measured, not eyeballed
 *
 * OKLab ΔE×100, min of protan/deutan. Every pair clears the ΔE 8 CVD target
 * and the 15 normal-vision floor, in both themes:
 *
 *   good ↔ info    22.1   (normal 26.0)
 *   info ↔ bad     14.6   (normal 26.1)
 *   good ↔ bad      8.7   (normal 37.7)   ← worst, and the one that binds
 *
 * **`bad` is a crimson so `good` can be a green.** These two move together:
 * red/green dichromacy cannot be fixed by choosing a better red OR a better
 * green in isolation. A true green against a pure red (`#0ca30c` / `#d03b3b`)
 * measures ΔE **4.1** for deuteranopes — unusable — and every greener green
 * collides the same way. Cooling the red buys the room. The pastels this
 * replaced (`#86efac` / `#fca5a5`) measured **5.8**, below the ΔE 6 floor
 * outright, on the two quantities in the feedback view most needing to be
 * told apart.
 *
 * **`info` is blue rather than amber** because it is the least consequential
 * band and amber made it the loudest thing on the chart — visual weight has to
 * track importance (Tufte's "smallest effective difference"). Amber also
 * overclaims: reserved vocabularies put yellow/orange at "warning", and a
 * queued run is informational, costs nothing and clears itself. It failed
 * contrast on white (1.83:1) into the bargain.
 *
 * **`neutral` is grey ON PURPOSE** — grey *is* the message ("nothing ran"),
 * and a status hue there would imply something did. It is deliberately below
 * the chroma floor, which is why it is never asked to carry a band by itself:
 * on the executions chart it is the line colour of a hatch, not a fill.
 *
 * Two knowingly-accepted validator complaints, both properties of a status
 * palette rather than defects: `neutral` fails the chroma floor (above), and
 * nothing here may be used as a categorical series colour — a status colour
 * must never impersonate a series.
 *
 * Never colour alone: every consumer pairs these with a legend or a label.
 */
export const STATUS = {
  /** Succeeded · positive feedback. */
  good: "#0ca30c",
  /** Nothing happened — skipped, absent, not applicable. */
  neutral: "#6b7280",
  /** Informational: real, worth seeing, not a problem. */
  info: "#4a7fb5",
  /** Failed · negative feedback. */
  bad: "#cc2b5e",
} as const;

export type StatusKey = keyof typeof STATUS;
