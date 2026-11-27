/**
 * The approve→resume outcome message (`lib/resume-outcome.ts`), shared by every
 * approval surface so the sentence — and the choice of when to stay silent —
 * cannot drift between the board card, the focused view and the inline banner.
 */
import { describe, expect, it } from "vitest";
import { resumeNotice } from "../src/lib/resume-outcome";

describe("resumeNotice", () => {
  it("stays silent when the run resumed or is queued to", () => {
    expect(resumeNotice("resumed")).toBeNull();
    expect(resumeNotice("queued")).toBeNull();
  });

  it("names the real reason a resume did not land, each distinctly", () => {
    const inactive = resumeNotice("inactive");
    const unavailable = resumeNotice("unavailable");
    const error = resumeNotice("error");
    expect(inactive).toMatch(/no longer active/);
    expect(unavailable).toMatch(/GitHub App/);
    expect(error).toMatch(/failed/);
    // Distinct causes get distinct sentences — the conflation the split fixes.
    expect(new Set([inactive, unavailable, error]).size).toBe(3);
  });

  it("stays silent when the server said nothing about a resume", () => {
    // A reject, or an older server that omits the field, carries no outcome.
    expect(resumeNotice(undefined)).toBeNull();
  });
});
