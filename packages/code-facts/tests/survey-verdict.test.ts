import { describe, expect, it } from "vitest";

import { type SurveyEvidence, deriveVerdict, hasEvidence, severityOf } from "../src/survey-verdict.js";

/** A row whose mechanism is fully closed: binding control, in time, nothing past it. */
const clean: SurveyEvidence = {
  subject: "SOME_LIMIT",
  control_site: "src/server/handler.ts:41",
  control_text: "if (value > SOME_LIMIT) return reject(value);",
  authority: "binding",
  order_ok: true,
  cannot_distinguish: "nothing",
  bypass: "none found",
  in_changed_hunk: false,
  consequence: null,
  trigger: "unknown",
  crosses_boundary: false,
  capability_gained: null,
};

describe("discharge", () => {
  it("is QUOTE only when the control binds, runs in time, and nothing walks past it", () => {
    expect(deriveVerdict(clean).discharge).toBe("QUOTE");
  });

  it("is ABSENT when no line closes the mechanism", () => {
    expect(deriveVerdict({ ...clean, control_site: "none" }).discharge).toBe("ABSENT");
    expect(deriveVerdict({ ...clean, control_site: "" }).discharge).toBe("ABSENT");
  });

  // A real quoted line on the side the other party controls is the failure this
  // whole record exists to make visible: it looks discharged and enforces
  // nothing.
  it("is PARTIAL when a real control sits where it cannot bind", () => {
    expect(deriveVerdict({ ...clean, authority: "advisory" }).discharge).toBe("PARTIAL");
  });

  it("is PARTIAL when the control runs after the thing it governs, or unknowably", () => {
    expect(deriveVerdict({ ...clean, order_ok: false }).discharge).toBe("PARTIAL");
    expect(deriveVerdict({ ...clean, order_ok: "unknown" }).discharge).toBe("PARTIAL");
  });

  it("is PARTIAL when a path reaches the governed operation without the control", () => {
    expect(deriveVerdict({ ...clean, bypass: "the admin route calls write() directly" }).discharge).toBe("PARTIAL");
  });
});

describe("needsProbe", () => {
  it("is false for a clean discharge over untouched code — nothing is at stake", () => {
    expect(deriveVerdict(clean).needsProbe).toBe(false);
  });

  /**
   * The rule the prose version carried and a leaner rewrite dropped, taking the
   * probe rate to zero: a clean discharge over code the PR touched is a
   * reassurance, and nothing downstream can reopen one.
   */
  it("is true for a clean discharge over code this PR touched", () => {
    expect(deriveVerdict({ ...clean, in_changed_hunk: true }).needsProbe).toBe(true);
  });

  it("is true whenever the control cannot separate two different situations", () => {
    expect(deriveVerdict({ ...clean, cannot_distinguish: "an empty list from a failed fetch" }).needsProbe).toBe(true);
  });

  it("is true when a consequence is named", () => {
    expect(deriveVerdict({ ...clean, consequence: "a second call reads the stale entry" }).needsProbe).toBe(true);
  });

  /**
   * Absence alone must NOT ask for a probe. A subject nothing checks and that
   * harms nothing is a note; probing it spends a sandbox on a question with no
   * stake, which is what an earlier version of this rule did.
   */
  it("is false for a harmless absence, and true for a harmful one", () => {
    const absent = { ...clean, control_site: "none", authority: "unknown", cannot_distinguish: "nothing" };
    expect(deriveVerdict({ ...absent, consequence: null }).needsProbe).toBe(false);
    expect(deriveVerdict({ ...absent, consequence: "unbounded growth until the process dies" }).needsProbe).toBe(true);
  });
});

describe("severity", () => {
  it("is Minor when nothing goes wrong, whatever else the row says", () => {
    expect(deriveVerdict({ ...clean, crosses_boundary: true, capability_gained: "anything" }).severity).toBe("Minor");
  });

  it("is Important for a live consequence that clears no boundary", () => {
    const v = deriveVerdict({ ...clean, consequence: "the caller sees a truncated list", trigger: "input", crosses_boundary: false });
    expect(v.severity).toBe("Important");
  });

  it("is Critical only for a live consequence that crosses a boundary AND grants something new", () => {
    const v = deriveVerdict({
      ...clean,
      consequence: "an unauthenticated caller reaches the write path",
      trigger: "input",
      crosses_boundary: true,
      capability_gained: "writing records it cannot otherwise write",
    });
    expect(v.severity).toBe("Critical");
  });

  /**
   * The conjunct that keeps `Critical` honest. A consequence reachable only
   * once somebody edits the source is not critical however bad it sounds:
   * whoever makes that edit already holds every capability it would grant.
   */
  it("is never Critical when only a future edit could trigger it", () => {
    const v = deriveVerdict({
      ...clean,
      consequence: "if the constant is changed, the duplicated copy goes stale",
      trigger: "code_change",
      crosses_boundary: true,
      capability_gained: "divergent limits between the two copies",
    });
    expect(v.severity).toBe("Important");
  });
});

describe("hasEvidence", () => {
  // A prompt that never asked for evidence has not violated anything, and a row
  // it wrote must not be scored as if it had.
  it("is false for absent or empty evidence", () => {
    expect(hasEvidence(undefined)).toBe(false);
    expect(hasEvidence(null)).toBe(false);
    expect(hasEvidence({})).toBe(false);
    expect(hasEvidence(clean)).toBe(true);
  });
});

describe("placeholder values", () => {
  // Measured drift: a pass wrote "N/A" into a field whose type had no such
  // value, and it read as a meaningful answer.
  it("treats N/A, none and dashes as unstated rather than as content", () => {
    for (const v of ["N/A", "none", "-", "", "null"]) {
      expect(deriveVerdict({ ...clean, consequence: v }).severity).toBe("Minor");
    }
  });
});

describe("a consequence that only bites after an edit", () => {
  const base: SurveyEvidence = {
    control_site: "src/a.ts:10",
    control_text: "const X = 5;",
    authority: "binding",
    order_ok: true,
    cannot_distinguish: "nothing",
    bypass: "none found",
    in_changed_hunk: false,
    crosses_boundary: true,
    capability_gained: "divergent limits between the two copies",
  };

  /**
   * Measured: a pass wrote this phrasing and still labelled the trigger
   * `input`, which derived a `Critical` out of a navigation timeout. The tell
   * is in the text the pass itself wrote, so it is read rather than trusted.
   */
  it("is demoted to code_change however the pass labelled it", () => {
    for (const c of [
      "if NAVIGATION_TIMEOUT is changed to a value the browser cannot serve, the two paths diverge",
      "if the constant is later updated, the hardcoded copy goes stale",
      "if these keys are ever renamed, existing entries are orphaned",
    ]) {
      expect(deriveVerdict({ ...base, consequence: c, trigger: "input" }).severity).toBe("Important");
    }
  });

  // One-way: it must never rescue a live consequence into a lower tier, and
  // must not fire on an ordinary input condition that happens to start with "if".
  it("leaves a live input condition alone", () => {
    const v = deriveVerdict({
      ...base,
      consequence: "if a caller passes null the route writes an empty record and reports success",
      trigger: "input",
    });
    expect(v.severity).toBe("Critical");
  });
});

describe("a row with no evidence is a reported fact", () => {
  /**
   * The failure that hides. Severity and needsProbe are derived FROM evidence,
   * so a row without it falls back to whatever the pass wrote — the ungoverned
   * guess the derivation exists to replace. Measured once as ten of ten rows
   * graded `Critical` on a pull request with nothing wrong, while every other
   * number looked ordinary. It has to be visible as a contract violation, not
   * absorbed as a clean run.
   */
  it("derives nothing and falls back, rather than inventing a verdict", () => {
    expect(hasEvidence({})).toBe(false);
    expect(severityOf({ severity: "Critical", evidence: {} })).toBe("Critical");
    expect(severityOf({ severity: "Critical", evidence: { consequence: null, control_site: "a.ts:1", authority: "binding", order_ok: true, cannot_distinguish: "nothing", bypass: "none found" } })).toBe("Minor");
  });
});
