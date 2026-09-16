/**
 * `isGated` and `timeAgo` — the two pure readers `BoardCard.tsx` exports.
 *
 * `timeAgo` is tested at its boundaries because every one of them is an
 * off-by-one waiting to happen, and against junk input because the card reads
 * every optional field defensively: a malformed timestamp must render as an
 * absent line, never as "NaNd" and never as a thrown render.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { BoardCard as BoardCardData } from "../src/api";
import { isGated, linkedPrsOf, prStateLabel, timeAgo } from "../src/components/board/BoardCard";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const ago = (secs: number) => new Date(NOW.getTime() - secs * 1000).toISOString();

function card(over: Partial<BoardCardData> = {}): BoardCardData {
  return {
    key: "acme/widget#7",
    repo: "acme/widget",
    number: 7,
    title: "t",
    author: "maintainer",
    createdAt: "2026-09-01T00:00:00.000Z",
    url: "https://github.com/acme/widget/issues/7",
    labels: [],
    stageLabel: "Build",
    ambiguousStage: false,
    held: false,
    actions: [],
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function frozen<T>(fn: () => T): T {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return fn();
}

describe("isGated", () => {
  it("is true when the card carries an approval object", () => {
    expect(isGated(card({ approval: { id: "ap-1", gate: "plan", createdAt: ago(60) } }))).toBe(true);
  });

  it("is false for a missing or null approval", () => {
    expect(isGated(card())).toBe(false);
    expect(isGated(card({ approval: null }))).toBe(false);
  });

  it("is false for anything that is not an object — a string or an array", () => {
    expect(isGated({ ...card(), approval: "ap-1" } as unknown as BoardCardData)).toBe(false);
    expect(isGated({ ...card(), approval: [] } as unknown as BoardCardData)).toBe(false);
  });

  it("does not care what is IN the approval — an empty object still gates", () => {
    // Gating is "the server sent an approval", not "the approval looks right":
    // a shape we half-understand is still a card a human is blocking on.
    expect(isGated({ ...card(), approval: {} } as unknown as BoardCardData)).toBe(true);
  });
});

describe("timeAgo", () => {
  it("counts seconds below a minute", () =>
    frozen(() => {
      expect(timeAgo(ago(0))).toBe("0s");
      expect(timeAgo(ago(1))).toBe("1s");
      expect(timeAgo(ago(59))).toBe("59s");
    }));

  it("switches to minutes at 60 s and holds to the hour", () =>
    frozen(() => {
      expect(timeAgo(ago(60))).toBe("1m");
      expect(timeAgo(ago(119))).toBe("1m");
      expect(timeAgo(ago(3599))).toBe("59m");
    }));

  it("switches to hours at an hour and holds to the day", () =>
    frozen(() => {
      expect(timeAgo(ago(3600))).toBe("1h");
      expect(timeAgo(ago(86_399))).toBe("23h");
    }));

  it("switches to days at 24 h and never gets coarser", () =>
    frozen(() => {
      expect(timeAgo(ago(86_400))).toBe("1d");
      expect(timeAgo(ago(86_400 * 400))).toBe("400d");
    }));

  it("reads a FUTURE timestamp as `now` rather than a negative age", () =>
    frozen(() => {
      // Clock skew between the server and the browser is normal; "-3s" is not.
      expect(timeAgo(new Date(NOW.getTime() + 5000).toISOString())).toBe("now");
    }));

  it("returns null for a missing date, so the caller renders no line at all", () => {
    expect(timeAgo(undefined)).toBeNull();
    expect(timeAgo(null)).toBeNull();
    expect(timeAgo("")).toBeNull();
  });

  it("returns null for an unparseable or non-string date", () => {
    expect(timeAgo("not-a-date")).toBeNull();
    expect(timeAgo("2026-13-45T99:99:99Z")).toBeNull();
    expect(timeAgo(1_757_000_000_000)).toBeNull();
    expect(timeAgo({ createdAt: "2026-09-01" })).toBeNull();
  });
});

describe("linkedPrsOf / prStateLabel", () => {
  const pr = (over: Record<string, unknown> = {}) => ({
    number: 31,
    url: "https://github.com/acme/widget/pull/31",
    title: "Build #7",
    state: "OPEN",
    draft: false,
    ...over,
  });

  it("reads the linked PRs, dropping entries with no number or link", () => {
    const got = linkedPrsOf(
      card({
        linkedPrs: [pr(), pr({ number: "32" }), pr({ url: "" }), null] as unknown as BoardCardData["linkedPrs"],
      }),
    );
    expect(got.map((p) => p.number)).toEqual([31]);
  });

  it("is empty for an older server that sends no field, or junk", () => {
    expect(linkedPrsOf(card())).toEqual([]);
    expect(linkedPrsOf(card({ linkedPrs: "nope" as unknown as null }))).toEqual([]);
  });

  it("names the state a person cares about", () => {
    expect(prStateLabel(pr())).toBe("open");
    expect(prStateLabel(pr({ draft: true }))).toBe("draft");
    expect(prStateLabel(pr({ state: "MERGED" }))).toBe("merged");
    expect(prStateLabel(pr({ state: "CLOSED", draft: true }))).toBe("closed");
  });
});
