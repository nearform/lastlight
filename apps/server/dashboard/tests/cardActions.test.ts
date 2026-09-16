/**
 * `cardActions.ts` — the map from a server action descriptor onto the admin
 * API call it means.
 *
 * This is the file where a mis-map is a wrong button on a live system: the
 * intents here start builds, cancel running work and answer approval gates.
 * So the tests below pin the ROUTING (which id/kind lands on which endpoint),
 * the two documented PR-retry fallbacks, and the safety property that an
 * action this build doesn't recognise degrades to an explicit `unsupported`
 * rather than falling through to something destructive.
 *
 * The api thunks are stubbed: nothing here touches the network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BoardCard, BoardCardAction } from "../src/api";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    respondToApproval: vi.fn(async () => ({ status: "ok" })),
    cancelWorkflowRun: vi.fn(async () => ({ cancelled: "run-1" })),
    retryWorkflowRun: vi.fn(async () => ({ retrying: "run-1" })),
    retryPr: vi.fn(async () => ({ dispatched: true })),
    dispatchIssue: vi.fn(async () => ({ dispatched: true })),
    moveIssueStage: vi.fn(async () => ({
      moved: true,
      advanced: true,
      removed: true,
      dispatched: true,
      stage: "build",
      landedLabel: "agent-building",
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
  subjectOf,
  intentForAction,
  needsReason,
  needsConfirm,
  isNavigation,
  performIntent,
  failureMessage,
} = await import("../src/components/board/cardActions");
const { ApiError } = await import("../src/api");

// ── Fixtures ────────────────────────────────────────────────────────────────

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    key: "acme/widget#7",
    repo: "acme/widget",
    number: 7,
    isPr: false,
    title: "Something is broken",
    author: "maintainer",
    createdAt: "2026-09-01T00:00:00.000Z",
    url: "https://github.com/acme/widget/issues/7",
    draft: false,
    labels: [],
    stageLabel: "Build",
    ambiguousStage: false,
    held: false,
    actions: [],
    ...over,
  };
}

const RUN = {
  id: "run-1",
  workflowName: "fix-issue",
  status: "running",
  currentPhase: "implement",
  startedAt: "2026-09-01T00:00:00.000Z",
};
const APPROVAL = { id: "ap-1", gate: "plan", createdAt: "2026-09-01T00:00:00.000Z" };

function action(over: Partial<BoardCardAction> = {}): BoardCardAction {
  return { id: "open", label: "Open on GitHub", kind: "link", enabled: true, ...over };
}

const issueCard = card();
const prCard = card({ isPr: true, number: 12, url: "https://github.com/acme/widget/pull/12" });

beforeEach(() => {
  vi.clearAllMocks();
});

// ── subjectOf ───────────────────────────────────────────────────────────────

describe("subjectOf", () => {
  it("reads the identity fields off a well-formed card", () => {
    expect(subjectOf(card({ run: RUN, approval: APPROVAL }))).toEqual({
      repo: "acme/widget",
      number: 7,
      isPr: false,
      url: "https://github.com/acme/widget/issues/7",
      runId: "run-1",
      approvalId: "ap-1",
      // The column the card sits in — the `from` of an unblock's stage move.
      stageLabel: "Build",
    });
  });

  it("collapses missing, null and wrong-shaped members to nulls rather than throwing", () => {
    const broken = {
      ...card(),
      run: null,
      approval: "definitely-not-an-object",
      repo: 42,
      number: "7",
      isPr: "yes",
      url: undefined,
      stageLabel: 99,
    } as unknown as BoardCard;
    expect(subjectOf(broken)).toEqual({
      repo: "",
      number: 0,
      isPr: false,
      url: "",
      runId: null,
      approvalId: null,
      stageLabel: "",
    });
  });

  it("treats an empty-string run/approval id as absent", () => {
    const subject = subjectOf(card({ run: { ...RUN, id: "" }, approval: { ...APPROVAL, id: "" } }));
    expect(subject.runId).toBeNull();
    expect(subject.approvalId).toBeNull();
  });
});

// ── intentForAction: id first ───────────────────────────────────────────────

describe("intentForAction — matching on the id", () => {
  it("routes `open` to navigation, with the card's url", () => {
    expect(intentForAction(action({ id: "open", kind: "run" }), subjectOf(issueCard))).toEqual({
      kind: "open",
      url: issueCard.url,
    });
  });

  it("refuses to navigate a card with no url", () => {
    const intent = intentForAction(action({ id: "open" }), subjectOf(card({ url: "" })));
    expect(intent).toEqual({ kind: "unsupported", reason: "This card has no GitHub link." });
  });

  it("routes approve and reject to the card's approval", () => {
    const subject = subjectOf(card({ approval: APPROVAL }));
    expect(intentForAction(action({ id: "approve", kind: "approval" }), subject)).toEqual({
      kind: "approve",
      approvalId: "ap-1",
    });
    expect(intentForAction(action({ id: "reject", kind: "approval" }), subject)).toEqual({
      kind: "reject",
      approvalId: "ap-1",
    });
  });

  it("refuses an approval action on a card with no pending approval", () => {
    expect(intentForAction(action({ id: "approve", kind: "approval" }), subjectOf(issueCard))).toEqual({
      kind: "unsupported",
      reason: "This card has no pending approval to answer.",
    });
  });

  it("routes cancel to the run, and refuses when there is none", () => {
    expect(
      intentForAction(action({ id: "cancel", kind: "run" }), subjectOf(card({ run: RUN }))),
    ).toEqual({ kind: "cancelRun", runId: "run-1" });
    expect(intentForAction(action({ id: "cancel", kind: "run" }), subjectOf(issueCard))).toEqual({
      kind: "unsupported",
      reason: "No run on this card to cancel.",
    });
  });

  it("routes retry to the run when the card has one", () => {
    expect(
      intentForAction(action({ id: "retry", kind: "run" }), subjectOf(card({ run: RUN }))),
    ).toEqual({ kind: "retryRun", runId: "run-1" });
  });

  it("routes dispatch on an issue to the issue dispatcher", () => {
    expect(intentForAction(action({ id: "dispatch", kind: "dispatch" }), subjectOf(issueCard))).toEqual({
      kind: "dispatchIssue",
      repo: "acme/widget",
      number: 7,
    });
  });
});

// ── intentForAction: kind fallback ──────────────────────────────────────────

describe("intentForAction — falling back to the kind", () => {
  it("treats an unknown id with kind `link` as navigation", () => {
    expect(
      intentForAction(action({ id: "view-on-github", kind: "link" }), subjectOf(issueCard)),
    ).toEqual({ kind: "open", url: issueCard.url });
  });

  it("treats an unknown id with kind `run` as a retry", () => {
    expect(
      intentForAction(action({ id: "rerun-phase", kind: "run" }), subjectOf(card({ run: RUN }))),
    ).toEqual({ kind: "retryRun", runId: "run-1" });
  });

  it("treats an unknown id with kind `dispatch` as a dispatch", () => {
    expect(
      intentForAction(action({ id: "start-build", kind: "dispatch" }), subjectOf(issueCard)),
    ).toEqual({ kind: "dispatchIssue", repo: "acme/widget", number: 7 });
  });

  it("does NOT guess at an unknown id under kind `approval` — approvals are answered by id only", () => {
    // Deliberate: `approve-with-note` reaches the approval branch by kind but
    // is not approve OR reject, and guessing which one it meant is the one
    // guess this file must never make.
    const intent = intentForAction(
      action({ id: "approve-with-note", kind: "approval" }),
      subjectOf(card({ approval: APPROVAL })),
    );
    expect(intent).toEqual({
      kind: "unsupported",
      reason: 'Unknown approval action "approve-with-note".',
    });
  });

  it("checks kind `link` BEFORE every id but `open` — a link-kinded action never mutates", () => {
    // Pinning the order as written: the `link` test is first, so even a
    // `cancel` id arriving with kind `link` degrades to navigation. Safe
    // direction (never destructive), but it is an ordering to know about.
    expect(
      intentForAction(action({ id: "cancel", kind: "link" }), subjectOf(card({ run: RUN }))),
    ).toEqual({ kind: "open", url: issueCard.url });
  });
});

// ── intentForAction: the safety property ────────────────────────────────────

describe("intentForAction — an unknown action degrades explicitly", () => {
  it("names the action it did not understand", () => {
    expect(intentForAction(action({ id: "frobnicate", kind: "magic" }), subjectOf(issueCard))).toEqual({
      kind: "unsupported",
      reason: 'This dashboard does not know the action "frobnicate".',
    });
  });

  it("falls back to the kind in the message when there is no id", () => {
    expect(
      intentForAction({ label: "?", kind: "magic", enabled: true } as BoardCardAction, subjectOf(issueCard)),
    ).toEqual({ kind: "unsupported", reason: 'This dashboard does not know the action "magic".' });
  });

  it("never falls through to a mutating intent, for any unrecognised descriptor", () => {
    const strangers: BoardCardAction[] = [
      action({ id: "frobnicate", kind: "magic" }),
      action({ id: "", kind: "" }),
      { id: 7, label: 1, kind: {}, enabled: true } as unknown as BoardCardAction,
      undefined as unknown as BoardCardAction,
      null as unknown as BoardCardAction,
    ];
    // A card carrying EVERYTHING, so a wrong fall-through would have the ids it
    // needs to actually fire.
    const loaded = subjectOf(card({ isPr: true, run: RUN, approval: APPROVAL }));
    for (const stranger of strangers) {
      const intent = intentForAction(stranger, loaded);
      expect(intent.kind).toBe("unsupported");
      expect(intent.kind === "unsupported" && intent.reason).toBeTruthy();
    }
  });
});

// ── The two documented PR-retry fallbacks ───────────────────────────────────

describe("intentForAction — PR retry fallbacks", () => {
  it("retry on a PR card with NO run id becomes a PR retry", () => {
    expect(intentForAction(action({ id: "retry", kind: "run" }), subjectOf(prCard))).toEqual({
      kind: "retryPr",
      repo: "acme/widget",
      number: 12,
    });
  });

  it("a kind-`run` action on a PR card with no run id takes the same road", () => {
    expect(intentForAction(action({ id: "go-again", kind: "run" }), subjectOf(prCard))).toEqual({
      kind: "retryPr",
      repo: "acme/widget",
      number: 12,
    });
  });

  it("dispatch on a PR card is a PR retry, not an issue dispatch", () => {
    expect(intentForAction(action({ id: "dispatch", kind: "dispatch" }), subjectOf(prCard))).toEqual({
      kind: "retryPr",
      repo: "acme/widget",
      number: 12,
    });
  });

  it("retry on an ISSUE card with no run has nowhere to go", () => {
    expect(intentForAction(action({ id: "retry", kind: "run" }), subjectOf(issueCard))).toEqual({
      kind: "unsupported",
      reason: "No run on this card to retry.",
    });
  });

  it("a PR card with a run still retries the RUN, not the PR", () => {
    expect(
      intentForAction(action({ id: "retry", kind: "run" }), subjectOf(card({ isPr: true, run: RUN }))),
    ).toEqual({ kind: "retryRun", runId: "run-1" });
  });
});

// ── The prompt predicates ───────────────────────────────────────────────────

describe("needsReason / needsConfirm / isNavigation", () => {
  const intents = {
    open: { kind: "open", url: "u" },
    approve: { kind: "approve", approvalId: "ap-1" },
    reject: { kind: "reject", approvalId: "ap-1" },
    cancelRun: { kind: "cancelRun", runId: "run-1" },
    retryRun: { kind: "retryRun", runId: "run-1" },
    retryPr: { kind: "retryPr", repo: "acme/widget", number: 12 },
    dispatchIssue: { kind: "dispatchIssue", repo: "acme/widget", number: 7 },
    unsupported: { kind: "unsupported", reason: "nope" },
  } as const;

  it("asks for a reason on exactly the approval pair", () => {
    const asked = Object.entries(intents).filter(([, i]) => needsReason(i)).map(([k]) => k);
    expect(asked.sort()).toEqual(["approve", "reject"]);
  });

  it("asks for a second press on exactly cancel — it stops running work", () => {
    const asked = Object.entries(intents).filter(([, i]) => needsConfirm(i)).map(([k]) => k);
    expect(asked).toEqual(["cancelRun"]);
  });

  it("treats exactly `open` as navigation", () => {
    const nav = Object.entries(intents).filter(([, i]) => isNavigation(i)).map(([k]) => k);
    expect(nav).toEqual(["open"]);
  });
});

// ── performIntent ───────────────────────────────────────────────────────────

describe("performIntent", () => {
  it("opens a new tab for navigation, and calls nothing", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    await expect(performIntent({ kind: "open", url: "https://example.test/1" })).resolves.toEqual({});
    expect(open).toHaveBeenCalledWith("https://example.test/1", "_blank", "noopener,noreferrer");
    expect(apiMock.respondToApproval).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("answers an approval with the decision and the trimmed reason", async () => {
    await performIntent({ kind: "approve", approvalId: "ap-1" }, { reason: "  looks right  " });
    expect(apiMock.respondToApproval).toHaveBeenCalledWith("ap-1", "approved", "looks right");

    await performIntent({ kind: "reject", approvalId: "ap-2" }, { reason: "wrong file" });
    expect(apiMock.respondToApproval).toHaveBeenCalledWith("ap-2", "rejected", "wrong file");
  });

  it("sends no reason at all when it is absent or only whitespace", async () => {
    await performIntent({ kind: "approve", approvalId: "ap-1" });
    expect(apiMock.respondToApproval).toHaveBeenLastCalledWith("ap-1", "approved", undefined);
    await performIntent({ kind: "approve", approvalId: "ap-1" }, { reason: "   " });
    expect(apiMock.respondToApproval).toHaveBeenLastCalledWith("ap-1", "approved", undefined);
  });

  it("cancels and retries a run by id", async () => {
    await performIntent({ kind: "cancelRun", runId: "run-1" });
    expect(apiMock.cancelWorkflowRun).toHaveBeenCalledWith("run-1");
    await performIntent({ kind: "retryRun", runId: "run-2" });
    expect(apiMock.retryWorkflowRun).toHaveBeenCalledWith("run-2");
  });

  it("retries a PR by repo + number", async () => {
    await expect(
      performIntent({ kind: "retryPr", repo: "acme/widget", number: 12 }, { reason: "flaky" }),
    ).resolves.toEqual({});
    expect(apiMock.retryPr).toHaveBeenCalledWith("acme/widget", 12, "flaky");
  });

  it("reports a PARKED PR retry as a note — a 200 where nothing starts yet", async () => {
    apiMock.retryPr.mockResolvedValueOnce({ dispatched: false, reason: "a run is in flight" } as never);
    await expect(
      performIntent({ kind: "retryPr", repo: "acme/widget", number: 12 }),
    ).resolves.toEqual({
      note: "Parked: the next event on this PR will honour the retry — a run is in flight.",
    });
  });

  it("parks without a reason when the server gave none", async () => {
    apiMock.retryPr.mockResolvedValueOnce({ dispatched: false } as never);
    const { note } = await performIntent({ kind: "retryPr", repo: "acme/widget", number: 12 });
    expect(note).toBe("Parked: the next event on this PR will honour the retry.");
  });

  it("dispatches an issue, passing a reason only when there is one", async () => {
    await performIntent({ kind: "dispatchIssue", repo: "acme/widget", number: 7 });
    expect(apiMock.dispatchIssue).toHaveBeenCalledWith("acme/widget", 7, {});
    await performIntent({ kind: "dispatchIssue", repo: "acme/widget", number: 7 }, { reason: "please" });
    expect(apiMock.dispatchIssue).toHaveBeenLastCalledWith("acme/widget", 7, { reason: "please" });
  });

  it("throws the reason for an unsupported intent, and calls nothing", async () => {
    await expect(performIntent({ kind: "unsupported", reason: "no idea" })).rejects.toThrow("no idea");
    expect(apiMock.dispatchIssue).not.toHaveBeenCalled();
    expect(apiMock.cancelWorkflowRun).not.toHaveBeenCalled();
  });
});

// ── failureMessage ──────────────────────────────────────────────────────────

describe("failureMessage", () => {
  it("shows a 409 refusal verbatim — the gate explaining itself", () => {
    const refusal = new ApiError(409, "This issue is held by `lastlight-ignore`.");
    expect(failureMessage(refusal)).toBe("This issue is held by `lastlight-ignore`.");
  });

  it("shows any other error's message", () => {
    expect(failureMessage(new ApiError(503, "No dispatcher is wired."))).toBe("No dispatcher is wired.");
    expect(failureMessage(new Error("network down"))).toBe("network down");
  });

  it("stringifies a non-Error throw rather than rendering nothing", () => {
    expect(failureMessage("boom")).toBe("boom");
    expect(failureMessage(null)).toBe("null");
    expect(failureMessage({ code: 1 })).toBe("[object Object]");
  });
});

// ── Unblocking a parked card ────────────────────────────────────────────────

/**
 * `unblock` is the one action that is NOT its own endpoint: it posts the same
 * stage move the drag gesture does, so both inherit one gate and one set of
 * refusals. The routing property worth pinning is that the target column comes
 * from the SERVER — stage labels are operator-configured, and a client that
 * guessed "the first column" would be re-deriving policy it cannot see.
 */
describe("intentForAction — unblock", () => {
  const parked = card({ stageLabel: "agent-blocked" });

  it("routes to a stage move, from the card's column to the server's target", () => {
    expect(
      intentForAction(
        { id: "unblock", label: "Unblock & rebuild", kind: "stage", enabled: true, to: "ready-for-agent" } as BoardCardAction,
        subjectOf(parked),
      ),
    ).toEqual({
      kind: "unblockIssue",
      repo: "acme/widget",
      number: 7,
      to: "ready-for-agent",
      from: "agent-blocked",
    });
  });

  it("refuses rather than guessing when the server named no target", () => {
    const intent = intentForAction(
      { id: "unblock", label: "Unblock & rebuild", kind: "stage", enabled: true } as BoardCardAction,
      subjectOf(parked),
    );
    expect(intent.kind).toBe("unsupported");
  });

  it("posts the move and reports that a build started", async () => {
    const intent = intentForAction(
      { id: "unblock", label: "Unblock & rebuild", kind: "stage", enabled: true, to: "ready-for-agent" } as BoardCardAction,
      subjectOf(parked),
    );
    const out = await performIntent(intent);

    expect(apiMock.moveIssueStage).toHaveBeenCalledWith("acme/widget", 7, "ready-for-agent", "agent-blocked");
    // The card lands in the running column, because the entry drop is gated
    // BEFORE any label is written — saying so is what stops it looking stuck.
    expect(out.note).toContain("agent-building");
  });

  it("surfaces a gate refusal instead of reporting success", async () => {
    apiMock.moveIssueStage.mockResolvedValueOnce({
      moved: true,
      advanced: true,
      removed: true,
      dispatched: false,
      dispatchReason: "budget-exhausted: acme/widget has spent $10.00 of its $10.00 daily model budget",
    } as never);
    const intent = intentForAction(
      { id: "unblock", label: "Unblock & rebuild", kind: "stage", enabled: true, to: "ready-for-agent" } as BoardCardAction,
      subjectOf(parked),
    );

    const out = await performIntent(intent);
    expect(out.note).toMatch(/no build started — budget-exhausted/);
  });
});
