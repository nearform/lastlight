/**
 * The approve→resume outcome message (`lib/resume-outcome.ts`), shared by every
 * approval surface so the sentence — and the choice of when to stay silent —
 * cannot drift between the board card, the focused view and the inline banner.
 */
import { describe, expect, it } from "vitest";
import { resumeNotice } from "../src/lib/resume-outcome";

describe("resumeNotice", () => {
  it("speaks up only when nothing resumed", () => {
    expect(resumeNotice("inactive")).toMatch(/no longer active/);
  });

  it("stays silent when the run resumed or is queued to", () => {
    expect(resumeNotice("resumed")).toBeNull();
    expect(resumeNotice("queued")).toBeNull();
  });

  it("stays silent when the server said nothing about a resume", () => {
    // A reject, or an older server that omits the field, carries no outcome.
    expect(resumeNotice(undefined)).toBeNull();
  });
});
