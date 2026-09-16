/**
 * `stageDrop.ts` — what dragging a card onto a column means.
 *
 * The decisions pinned here are the ones a wrong answer makes expensive or
 * confusing on a live board: a drop that should cost nothing (the column the
 * card is already in) silently writing a GitHub label; a HELD card producing a
 * move the server will refuse; the unstaged column sending anything other than
 * `to: ""`; and the banner sentence, which is now read off the SERVER's
 * `dispatched` / `dispatchReason` rather than guessed at from a stale card.
 *
 * The api thunk is stubbed: nothing here touches the network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BoardCard } from "../src/api";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    moveIssueStage: vi.fn(async () => ({
      moved: true,
      advanced: true,
      removed: true,
      dispatched: false,
    })),
  },
}));

class StubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get refused(): boolean {
    return this.status === 409;
  }
}

vi.mock("../src/api", () => ({ api: apiMock, ApiError: StubApiError }));

const {
  decodeDragPayload,
  draggedCardOf,
  encodeDragPayload,
  isDraggable,
  performStageMove,
  resolveStageDrop,
} = await import("../src/components/board/stageDrop");

// ── Fixtures ────────────────────────────────────────────────────────────────

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    key: "acme/widget#7",
    repo: "acme/widget",
    number: 7,
    title: "Something is broken",
    author: "maintainer",
    createdAt: "2026-09-01T00:00:00.000Z",
    url: "https://github.com/acme/widget/issues/7",
    labels: [],
    stageLabel: "ready-for-agent",
    ambiguousStage: false,
    held: false,
    actions: [],
    ...over,
  };
}

const RUN = {
  id: "run-1",
  workflowName: "build",
  status: "succeeded",
  startedAt: "2026-09-01T00:00:00.000Z",
};

const ENTRY = { label: "ready-for-agent" };
const LATER = { label: "in-review" };
const UNSTAGED = { label: "" };

beforeEach(() => {
  vi.clearAllMocks();
});

// ── draggedCardOf / isDraggable ─────────────────────────────────────────────

describe("draggedCardOf", () => {
  it("reads the drag identity off a well-formed card", () => {
    expect(draggedCardOf(card({ run: RUN }))).toEqual({
      key: "acme/widget#7",
      repo: "acme/widget",
      number: 7,
      stageLabel: "ready-for-agent",
      held: false,
    });
  });

  it("collapses missing, null and wrong-shaped members rather than throwing", () => {
    const broken = {
      ...card(),
      run: "definitely-not-an-object",
      repo: 42,
      number: "7",
      stageLabel: null,
      held: "yes",
    } as unknown as BoardCard;
    expect(draggedCardOf(broken)).toEqual({
      key: "acme/widget#7",
      repo: "",
      number: 0,
      stageLabel: "",
      held: false,
    });
  });
});

describe("isDraggable", () => {
  it("refuses a held card the gesture entirely", () => {
    expect(isDraggable(card({ held: true }))).toBe(false);
    expect(isDraggable(card())).toBe(true);
  });
});

// ── The payload round trip ──────────────────────────────────────────────────

describe("encode / decodeDragPayload", () => {
  it("round-trips the card's key and current stage label", () => {
    const dragged = draggedCardOf(card({ run: RUN }));
    expect(decodeDragPayload(encodeDragPayload(dragged))).toEqual(dragged);
  });

  it("is total — anything that is not one of our payloads is null", () => {
    for (const raw of ["", "not json", "[1,2]", "null", '"a string"', undefined, 42, null]) {
      expect(decodeDragPayload(raw)).toBeNull();
    }
  });

  it("rejects a payload with no repo or number — there would be nowhere to send it", () => {
    expect(decodeDragPayload(JSON.stringify({ key: "a#1" }))).toBeNull();
    expect(decodeDragPayload(JSON.stringify({ key: "a#1", repo: "acme/widget", number: 0 }))).toBeNull();
  });
});

// ── resolveStageDrop ────────────────────────────────────────────────────────

describe("resolveStageDrop", () => {
  it("makes a drop on the column the card is already in a noop", () => {
    const dragged = draggedCardOf(card({ stageLabel: "in-review" }));
    expect(resolveStageDrop(dragged, LATER)).toEqual({ kind: "noop", reason: "same-column" });
  });

  it("makes an unstaged card dropped back on unstaged a noop too — both labels are ''", () => {
    const dragged = draggedCardOf(card({ stageLabel: "" }));
    expect(resolveStageDrop(dragged, UNSTAGED)).toEqual({ kind: "noop", reason: "same-column" });
  });

  it("sends `to: \"\"` for the unstaged column — remove `from`, add nothing", () => {
    const dragged = draggedCardOf(card({ stageLabel: "in-review" }));
    expect(resolveStageDrop(dragged, UNSTAGED)).toEqual({
      kind: "move",
      to: "",
      from: "in-review",
    });
  });

  it("carries the card's CURRENT stage label as `from`", () => {
    const dragged = draggedCardOf(card({ stageLabel: "ready-for-agent" }));
    expect(resolveStageDrop(dragged, LATER)).toEqual({
      kind: "move",
      to: "in-review",
      from: "ready-for-agent",
    });
  });

  it("moves an unstaged card onto a stage", () => {
    const dragged = draggedCardOf(card({ stageLabel: "" }));
    expect(resolveStageDrop(dragged, ENTRY)).toMatchObject({ kind: "move", to: "ready-for-agent", from: "" });
  });

  it("never produces a move for a HELD card, on any target", () => {
    const held = draggedCardOf(card({ held: true, stageLabel: "in-review", run: RUN }));
    for (const target of [ENTRY, LATER, UNSTAGED]) {
      expect(resolveStageDrop(held, target)).toEqual({ kind: "noop", reason: "held" });
    }
  });

  it("is total over a missing or empty drag", () => {
    expect(resolveStageDrop(null, ENTRY)).toEqual({ kind: "noop", reason: "no-card" });
    expect(
      resolveStageDrop({ key: "", repo: "", number: 0, stageLabel: "", held: false }, ENTRY),
    ).toEqual({ kind: "noop", reason: "no-card" });
  });
});

// ── performStageMove ────────────────────────────────────────────────────────

describe("performStageMove", () => {
  it("posts `to` and `from` for the card's repo and number", async () => {
    const dragged = draggedCardOf(card({ stageLabel: "ready-for-agent" }));
    await expect(
      performStageMove(dragged, { kind: "move", to: "in-review", from: "ready-for-agent" }),
    ).resolves.toEqual({});
    expect(apiMock.moveIssueStage).toHaveBeenCalledWith("acme/widget", 7, "in-review", "ready-for-agent");
  });

  it("says a build started, and where the card actually landed", async () => {
    // The entry column is gated BEFORE a label is written, so a dispatched
    // build has already advanced the issue past the column it was dropped on.
    // Saying so is what stops the move looking like it sprang back.
    apiMock.moveIssueStage.mockResolvedValueOnce({
      moved: true,
      advanced: true,
      removed: true,
      dispatched: true,
      stage: "build",
      landedLabel: "agent-building",
    } as never);
    const dragged = draggedCardOf(card({ stageLabel: "agent-blocked" }));
    await expect(
      performStageMove(dragged, { kind: "move", to: "ready-for-agent", from: "agent-blocked" }),
    ).resolves.toEqual({
      note: "Build started — the card moved to `agent-building`.",
      landedLabel: "agent-building",
    });
  });

  it("surfaces a gate refusal — a 200 that started nothing", async () => {
    // "The budget said no" and "nothing happened" must not look the same. The
    // move succeeded; only the build was refused, so this is not a rejection.
    apiMock.moveIssueStage.mockResolvedValueOnce({
      moved: true,
      advanced: true,
      removed: true,
      dispatched: false,
      dispatchReason: "run-in-flight: a build run for acme/widget#7 is already queued, running or paused",
    } as never);
    const out = await performStageMove(draggedCardOf(card()), {
      kind: "move",
      to: "agent-building",
      from: "ready-for-agent",
    });
    expect(out.note).toMatch(/no build started — run-in-flight/);
  });

  it("stays quiet on the ordinary answers", async () => {
    // Dropping on a terminal column is not a failed build, it is a move. The
    // board already shows it by moving the card.
    apiMock.moveIssueStage.mockResolvedValueOnce({
      moved: true,
      advanced: true,
      removed: true,
      dispatched: false,
      dispatchReason: "terminal-column: `ready-for-human` is the `on_success` label of `build`",
    } as never);
    await expect(
      performStageMove(draggedCardOf(card()), {
        kind: "move",
        to: "ready-for-human",
        from: "ready-for-agent",
      }),
    ).resolves.toEqual({});
  });

  it("lets a refusal through untouched — the 409 is the gate explaining itself", async () => {
    apiMock.moveIssueStage.mockRejectedValueOnce(
      new StubApiError(409, "This issue is held by `lastlight-ignore`.") as never,
    );
    await expect(
      performStageMove(draggedCardOf(card()), { kind: "move", to: "x", from: "y" }),
    ).rejects.toThrow("This issue is held by `lastlight-ignore`.");
  });
});
