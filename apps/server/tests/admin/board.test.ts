/**
 * `buildBoard` — the board's rules, as a table over literal records.
 *
 * The builder is pure, so this file needs no Hono, no GitHub and no database:
 * the whole point of the seam is that the column assignment, the stage
 * tie-break and the action policy can be stated as inputs and read as outputs.
 * The transport-level properties (scope, auth, the query count) live in
 * `board-route.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  buildBoard,
  type BoardBuilderApproval,
  type BoardBuilderItem,
  type BoardBuilderRun,
  type BoardStage,
} from "#src/admin/board.js";

const REPO = "acme/widget";
const HOLD = "lastlight-ignore";

const BUILD_STAGE: BoardStage = {
  id: "build",
  enter: "ready-for-agent",
  running: "agent-building",
  on_success: "ready-for-human",
  on_failure: "agent-blocked",
};

function item(number: number, labels: string[], over: Partial<BoardBuilderItem> = {}): BoardBuilderItem {
  return {
    repo: REPO,
    number,
    isPr: false,
    title: `Item ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    author: "maintainer",
    createdAt: "2026-09-01T00:00:00.000Z",
    draft: false,
    labels: labels.map((name) => ({ name, color: "ededed" })),
    ...over,
  };
}

function build(
  items: BoardBuilderItem[],
  over: {
    stages?: BoardStage[];
    runs?: Map<string, BoardBuilderRun>;
    approvals?: BoardBuilderApproval[];
    failures?: Map<string, { phase: string; error: string }>;
    inFlight?: Map<string, string>;
    unstaged?: boolean;
  } = {},
) {
  return buildBoard(
    {
      items,
      runs: over.runs ?? new Map(),
      approvals: over.approvals ?? [],
      ...(over.failures ? { failures: over.failures } : {}),
      ...(over.inFlight ? { inFlight: over.inFlight } : {}),
      stages: over.stages ?? [BUILD_STAGE],
      holdLabel: HOLD,
      scope: { repos: [REPO], eligible: [REPO], truncated: false, reason: "test" },
      degraded: [],
      ttlSeconds: 120,
    },
    { unstaged: over.unstaged },
  );
}

describe("buildBoard columns", () => {
  it("derives the columns from the configured stage, in pipeline order", () => {
    const board = build([]);

    expect(board.configured).toBe(true);
    expect(board.columns.map((col) => col.label)).toEqual([
      "ready-for-agent",
      "agent-building",
      "ready-for-human",
      "agent-blocked",
    ]);
    // The id survives a label rename; the title is derived from the label so a
    // renamed stage never renders a stale heading.
    expect(board.columns[0]).toMatchObject({ id: "build.enter", title: "Ready for agent" });
  });

  it("honours an operator's renamed labels rather than the packaged names", () => {
    const board = build([item(1, ["queue"])], {
      stages: [{ id: "ship", enter: "queue", running: "wip", on_success: "done", on_failure: "stuck" }],
    });

    expect(board.columns.map((col) => col.label)).toEqual(["queue", "wip", "done", "stuck"]);
    expect(board.columns[0]!.cards.map((card) => card.key)).toEqual([`${REPO}#1`]);
  });

  it("collapses a label two stages share onto its first column", () => {
    const board = build([], {
      stages: [
        BUILD_STAGE,
        { id: "ship", enter: "ready-for-human", running: "shipping", on_success: "shipped", on_failure: "" },
      ],
    });

    const labels = board.columns.map((col) => col.label);
    expect(labels.filter((l) => l === "ready-for-human")).toHaveLength(1);
    expect(labels).toEqual([
      "ready-for-agent",
      "agent-building",
      "ready-for-human",
      "agent-blocked",
      "shipping",
      "shipped",
    ]);
  });

  it("returns configured:false and NO columns when no stages are configured", () => {
    const board = build([item(1, ["ready-for-agent"])], { stages: [] });

    expect(board.configured).toBe(false);
    expect(board.columns).toEqual([]);
    // Nothing invented: the UI renders an empty state, not "Intake/Triage/…".
    expect(board.unstaged).toBeUndefined();
  });
});

describe("buildBoard card placement", () => {
  it("files a card under the stage label it carries", () => {
    const board = build([item(7, ["agent-building", "bug"])]);

    const column = board.columns.find((col) => col.label === "agent-building")!;
    expect(column.cards.map((card) => card.number)).toEqual([7]);
    expect(column.count).toBe(1);
    expect(column.cards[0]!.stageLabel).toBe("agent-building");
    expect(column.cards[0]!.ambiguousStage).toBe(false);
  });

  it("gives a multi-labelled card to the RIGHT-MOST stage and flags it ambiguous", () => {
    // The partial-advance shape: `stage-advance.ts` added the new label and the
    // remove failed. The card has progressed, so it belongs to the later column.
    const board = build([item(7, ["ready-for-agent", "agent-building"])]);

    expect(board.columns.find((col) => col.label === "ready-for-agent")!.cards).toHaveLength(0);
    const running = board.columns.find((col) => col.label === "agent-building")!;
    expect(running.cards).toHaveLength(1);
    expect(running.cards[0]).toMatchObject({ stageLabel: "agent-building", ambiguousStage: true });
  });

  it("keeps cards with no stage label out of every column", () => {
    const board = build([item(1, ["ready-for-agent"]), item(2, ["bug"])]);

    expect(board.columns.flatMap((col) => col.cards).map((card) => card.number)).toEqual([1]);
    expect(board.unstaged).toBeUndefined();
  });

  it("buckets them into `unstaged` when asked — an unlabelled PR is normal, not an error", () => {
    const board = build([item(2, ["bug"]), item(3, [], { isPr: true, draft: true })], {
      unstaged: true,
    });

    expect(board.unstaged!.count).toBe(2);
    expect(board.unstaged!.cards.map((card) => card.number)).toEqual([2, 3]);
    expect(board.unstaged!.cards[1]).toMatchObject({ isPr: true, draft: true, stageLabel: "" });
  });

  it("marks a held card and disables every action but the link", () => {
    const board = build([item(9, ["ready-for-agent", HOLD])]);

    const card = board.columns[0]!.cards[0]!;
    expect(card.held).toBe(true);
    const dispatch = card.actions.find((a) => a.id === "dispatch")!;
    expect(dispatch.enabled).toBe(false);
    expect(dispatch.disabledReason).toContain(HOLD);
    // Reading is not acting.
    expect(card.actions.find((a) => a.id === "open")!.enabled).toBe(true);
  });
});

describe("buildBoard runs, approvals and actions", () => {
  const run: BoardBuilderRun = {
    id: "run-1",
    workflowName: "build",
    status: "paused",
    currentPhase: "architect",
    startedAt: "2026-09-02T00:00:00.000Z",
  };

  it("joins the latest run and its pending approval onto the card", () => {
    const board = build([item(4, ["agent-building"])], {
      runs: new Map([[`${REPO}#4`, run]]),
      approvals: [
        {
          id: "appr-1",
          workflowRunId: "run-1",
          gate: "post_architect",
          summary: "Plan ready",
          artifact: "architect-plan.md",
          createdAt: "2026-09-02T01:00:00.000Z",
        },
      ],
    });

    const card = board.columns.find((col) => col.label === "agent-building")!.cards[0]!;
    expect(card.run).toMatchObject({ id: "run-1", workflowName: "build", currentPhase: "architect" });
    expect(card.approval).toMatchObject({ gate: "post_architect", artifact: "architect-plan.md" });
    expect(card.actions.map((a) => a.id)).toContain("approve");
    expect(card.actions.map((a) => a.id)).toContain("reject");
    // A live run owns the issue: cancel, never a second dispatch.
    expect(card.actions.map((a) => a.id)).toContain("cancel");
    expect(card.actions.find((a) => a.id === "dispatch")!.enabled).toBe(false);
  });

  it("counts cards awaiting a human, per column", () => {
    const other: BoardBuilderRun = { ...run, id: "run-2", status: "running" };
    const board = build([item(4, ["agent-building"]), item(5, ["agent-building"])], {
      runs: new Map([
        [`${REPO}#4`, run],
        [`${REPO}#5`, other],
      ]),
      approvals: [
        { id: "appr-1", workflowRunId: "run-1", gate: "post_architect", createdAt: "2026-09-02T01:00:00.000Z" },
      ],
    });

    const column = board.columns.find((col) => col.label === "agent-building")!;
    expect(column.count).toBe(2);
    expect(column.awaitingHumanCount).toBe(1);
    // A column nobody is waiting on reports zero, not undefined.
    expect(board.columns[0]!.awaitingHumanCount).toBe(0);
  });

  it("offers BOTH retry and a rebuild on a failed run, and a first build on a fresh issue", () => {
    const failed: BoardBuilderRun = { ...run, status: "failed" };
    const board = build([item(4, ["agent-blocked"]), item(5, ["ready-for-agent"])], {
      runs: new Map([[`${REPO}#4`, failed]]),
    });

    const blocked = board.columns.find((col) => col.label === "agent-blocked")!.cards[0]!;
    // Both, on purpose, because they are different operations: `retry` resumes
    // the SAME run from the phase that failed, in its existing workspace, while
    // `dispatch` starts a fresh one from the entry column.
    //
    // A previous run does NOT disable dispatch. The gate treats a human ask as
    // an explicit retry (`already-built` hard-skips a BOT re-label only), so
    // disabling it here made the board stricter than the server it speaks for —
    // and on the entry column, where `unblock` cannot apply, it left a failed
    // card with no way forward at all.
    expect(blocked.actions.map((a) => a.id)).toContain("retry");
    expect(blocked.actions.find((a) => a.id === "dispatch")).toMatchObject({
      enabled: true,
      disabledReason: null,
      label: "Rebuild",
    });

    const fresh = board.columns[0]!.cards[0]!;
    expect(fresh.actions.find((a) => a.id === "dispatch")).toMatchObject({
      enabled: true,
      disabledReason: null,
      label: "Start build",
    });
  });

  it("never offers dispatch on a pull request — the pipeline builds issues", () => {
    const board = build([item(6, ["ready-for-human"], { isPr: true })]);

    const card = board.columns.find((col) => col.label === "ready-for-human")!.cards[0]!;
    expect(card.actions.map((a) => a.id)).not.toContain("dispatch");
  });
});

describe("buildBoard card fields", () => {
  it("carries the body excerpt onto the card, and omits it entirely when there is none", () => {
    const board = build([
      item(1, ["ready-for-agent"], { body: "Update the README to mention the new flag." }),
      item(2, ["ready-for-agent"]),
    ]);

    const cards = board.columns.flatMap((col) => col.cards);
    expect(cards.find((c) => c.number === 1)?.body).toBe(
      "Update the README to mention the new flag.",
    );
    // ABSENT, not `""`. The card renders the description block on truthiness, so
    // an empty string would reserve a line for a description nobody wrote.
    expect(cards.find((c) => c.number === 2)).not.toHaveProperty("body");
  });
});

// ── The failure reason on a FAILED card ─────────────────────────────────────

describe("buildBoard — the failure reason", () => {
  const FAILED: BoardBuilderRun = {
    id: "run-9",
    workflowName: "build",
    status: "failed",
    currentPhase: "guardrails_gate",
    startedAt: "2026-09-01T00:00:00.000Z",
  };

  function withFailure(reason: string, phase = "build:guardrails_gate", status = "failed") {
    return build([item(4, ["agent-blocked"])], {
      runs: new Map([[`${REPO}#4`, { ...FAILED, status }]]),
      failures: new Map([["run-9", { phase, error: reason }]]),
    });
  }

  function cardOf(board: ReturnType<typeof build>) {
    const columns = "columns" in board ? board.columns : [];
    return columns.flatMap((c) => c.cards)[0];
  }

  it("names the phase that blocked and the sentence it blocked with", () => {
    // The motivating case: without this, `agent-blocked` by guardrails and
    // `agent-blocked` by a crash are the same band with no way to tell them
    // apart.
    const card = cardOf(withFailure("Guardrails check: BLOCKED — full test suite gate"));
    expect(card?.run?.failure).toEqual({
      phase: "guardrails_gate",
      reason: "Guardrails check: BLOCKED — full test suite gate",
    });
  });

  it("strips only its OWN workflow's prefix from the phase", () => {
    expect(cardOf(withFailure("boom", "build:architect"))?.run?.failure?.phase).toBe("architect");
    // A row that is not namespaced, or namespaced to something else, is left be.
    expect(cardOf(withFailure("boom", "architect"))?.run?.failure?.phase).toBe("architect");
    expect(cardOf(withFailure("boom", "review:architect"))?.run?.failure?.phase).toBe("review:architect");
  });

  it("flattens and clips a stack trace — the payload is the budget", () => {
    const trace = `Error: kaboom\n${"    at someFrame (/a/b/c.ts:1:1)\n".repeat(40)}`;
    const reason = cardOf(withFailure(trace))?.run?.failure?.reason ?? "";
    expect(reason.length).toBeLessThanOrEqual(160);
    expect(reason).not.toContain("\n");
    expect(reason.endsWith("…")).toBe(true);
  });

  it("says nothing when the run did not fail, even if the ledger has a row", () => {
    // A retried run that ended up succeeding still has a failed phase row. The
    // band is not showing a failure, so the card must not either.
    expect(cardOf(withFailure("boom", "build:architect", "succeeded"))?.run?.failure).toBeUndefined();
  });

  it("leaves a FAILED run with no ledger reason alone rather than inventing one", () => {
    const board = build([item(4, ["agent-blocked"])], {
      runs: new Map([[`${REPO}#4`, FAILED]]),
      failures: new Map(),
    });
    expect(cardOf(board)?.run?.status).toBe("failed");
    expect(cardOf(board)?.run?.failure).toBeUndefined();
  });
});

// ── Unblocking a parked card ────────────────────────────────────────────────

/**
 * A card that has STOPPED is invisible to everything that would otherwise move
 * it: the backstop sweep queries the `enter` label, so a card parked on
 * `on_failure` is deliberately not a candidate. `unblock` is the way back, and
 * it is NOT `retry` — that resumes the same run from the phase that failed,
 * while this starts a fresh build from the entry column.
 */
describe("buildBoard — the unblock action", () => {
  const FAILED: BoardBuilderRun = {
    id: "run-9",
    workflowName: "build",
    status: "failed",
    currentPhase: "phase_0",
    startedAt: "2026-09-01T00:00:00.000Z",
  };

  function cardsOf(board: ReturnType<typeof build>) {
    const columns = "columns" in board ? board.columns : [];
    return columns.flatMap((c) => c.cards);
  }
  function unblockOn(board: ReturnType<typeof build>) {
    return cardsOf(board)[0]?.actions.find((a) => a.id === "unblock");
  }

  it("is offered on a parked card, naming the stage's OWN entry column", () => {
    const board = build([item(4, ["agent-blocked"])], {
      runs: new Map([[`${REPO}#4`, FAILED]]),
    });
    expect(unblockOn(board)).toMatchObject({
      id: "unblock",
      kind: "stage",
      enabled: true,
      // The server names the target: stage labels are operator-configured, so
      // the client must never guess which column is the entrance.
      to: "ready-for-agent",
    });
  });

  it("is offered for a FAILED run even on a non-terminal column", () => {
    const board = build([item(4, ["agent-building"])], {
      runs: new Map([[`${REPO}#4`, FAILED]]),
    });
    expect(unblockOn(board)?.to).toBe("ready-for-agent");
  });

  it("is NOT offered on the entry column — there is nowhere back to", () => {
    const board = build([item(4, ["ready-for-agent"])], {
      runs: new Map([[`${REPO}#4`, FAILED]]),
    });
    expect(unblockOn(board)).toBeUndefined();
  });

  it("is NOT offered on a card that simply succeeded", () => {
    const board = build([item(4, ["ready-for-human"])], {
      runs: new Map([[`${REPO}#4`, { ...FAILED, status: "succeeded" }]]),
    });
    expect(unblockOn(board)).toBeUndefined();
  });

  it("is disabled while a run still owns the issue", () => {
    const board = build([item(4, ["agent-blocked"])], {
      runs: new Map([[`${REPO}#4`, { ...FAILED, status: "running" }]]),
    });
    expect(unblockOn(board)).toMatchObject({
      enabled: false,
      disabledReason: "A run already owns this issue.",
    });
  });

  it("is disabled by a hold, in the hold's own words", () => {
    const board = build([item(4, ["agent-blocked", HOLD])], {
      runs: new Map([[`${REPO}#4`, FAILED]]),
    });
    expect(unblockOn(board)?.enabled).toBe(false);
    expect(unblockOn(board)?.disabledReason).toContain(HOLD);
  });

  it("is never offered on a pull request — the pipeline builds issues", () => {
    const board = build([item(4, ["agent-blocked"], { isPr: true })], {
      runs: new Map([[`${REPO}#4`, FAILED]]),
    });
    expect(unblockOn(board)).toBeUndefined();
  });
});

// ── Which phase a card shows ────────────────────────────────────────────────

/**
 * `current_phase` is written when a phase COMPLETES, so it lags by one for
 * every phase after the first — a run working on `executor` reads `architect`,
 * and a run that died before finishing anything reads the `phase_0` seed. The
 * ledger knows better, and `phase` is that answer.
 */
describe("buildBoard — the displayed phase", () => {
  const RUNNING: BoardBuilderRun = {
    id: "run-1",
    workflowName: "build",
    status: "running",
    currentPhase: "architect",
    startedAt: "2026-09-01T00:00:00.000Z",
  };

  function runOf(board: ReturnType<typeof build>) {
    const columns = "columns" in board ? board.columns : [];
    return columns.flatMap((c) => c.cards)[0]?.run;
  }

  it("shows what a LIVE run is actually running, not the last phase it finished", () => {
    const board = build([item(4, ["agent-building"])], {
      runs: new Map([[`${REPO}#4`, RUNNING]]),
      inFlight: new Map([["run-1", "build:executor"]]),
    });
    expect(runOf(board)?.phase).toBe("executor");
    // The raw column is left untouched — it is what the row says.
    expect(runOf(board)?.currentPhase).toBe("architect");
  });

  it("shows the phase a FAILED run died in, not its stale seed", () => {
    const board = build([item(4, ["agent-blocked"])], {
      runs: new Map([[`${REPO}#4`, { ...RUNNING, status: "failed", currentPhase: "phase_0" }]]),
      failures: new Map([["run-1", { phase: "build:pr", error: "skipped: trigger rule not satisfied" }]]),
    });
    expect(runOf(board)?.phase).toBe("pr");
  });

  it("says nothing when the ledger agrees with the row", () => {
    const board = build([item(4, ["agent-building"])], {
      runs: new Map([[`${REPO}#4`, RUNNING]]),
      inFlight: new Map([["run-1", "build:architect"]]),
    });
    expect(runOf(board)?.phase).toBeUndefined();
  });

  it("falls back to the row when the ledger knows nothing", () => {
    const board = build([item(4, ["agent-building"])], {
      runs: new Map([[`${REPO}#4`, RUNNING]]),
    });
    expect(runOf(board)?.phase).toBeUndefined();
    expect(runOf(board)?.currentPhase).toBe("architect");
  });
});

// ── Two stage labels: which column wins ─────────────────────────────────────

/**
 * The case that actually happens (issue #60): a build failed, was re-run, and
 * succeeded — so the issue carries `agent-blocked` from the first run beside
 * `ready-for-human` from the second. `on_failure` sits right-most, so column
 * order alone files a finished build under "blocked" and renders a green
 * SUCCEEDED band inside a red column. The RUN is the fact; it decides.
 */
describe("buildBoard — breaking a two-label tie", () => {
  const BOTH = ["ready-for-human", "agent-blocked"];

  function run(status: string): BoardBuilderRun {
    return {
      id: "run-1",
      workflowName: "build",
      status,
      currentPhase: "complete",
      startedAt: "2026-09-01T00:00:00.000Z",
    };
  }

  function columnOf(board: ReturnType<typeof build>, key: string) {
    const columns = "columns" in board ? board.columns : [];
    return columns.find((c) => c.cards.some((card) => card.key === key));
  }

  it("files a card whose run SUCCEEDED under the success column", () => {
    const board = build([item(4, BOTH)], { runs: new Map([[`${REPO}#4`, run("succeeded")]]) });
    expect(columnOf(board, `${REPO}#4`)?.id).toBe("build.on_success");
  });

  it("files a card whose run FAILED under the failure column", () => {
    const board = build([item(4, BOTH)], { runs: new Map([[`${REPO}#4`, run("failed")]]) });
    expect(columnOf(board, `${REPO}#4`)?.id).toBe("build.on_failure");
  });

  it("treats a cancelled run as a failure for placement", () => {
    const board = build([item(4, BOTH)], { runs: new Map([[`${REPO}#4`, run("cancelled")]]) });
    expect(columnOf(board, `${REPO}#4`)?.id).toBe("build.on_failure");
  });

  it("falls back to right-most while the run is still in flight", () => {
    // Nothing has been decided yet, so the old rule stands: the card has
    // progressed, and later stages are further right.
    const board = build([item(4, BOTH)], { runs: new Map([[`${REPO}#4`, run("running")]]) });
    expect(columnOf(board, `${REPO}#4`)?.id).toBe("build.on_failure");
  });

  it("falls back to right-most with no run at all", () => {
    expect(columnOf(build([item(4, BOTH)]), `${REPO}#4`)?.id).toBe("build.on_failure");
  });

  it("still flags the pair either way — the UI must show it was a choice", () => {
    const board = build([item(4, BOTH)], { runs: new Map([[`${REPO}#4`, run("succeeded")]]) });
    const columns = "columns" in board ? board.columns : [];
    expect(columns.flatMap((c) => c.cards)[0]?.ambiguousStage).toBe(true);
  });

  it("leaves an UNambiguous card alone, whatever the run says", () => {
    // A single label is not a tie, so the run has no say: the label is the
    // only statement about where the card is.
    const board = build([item(4, ["agent-building"])], {
      runs: new Map([[`${REPO}#4`, run("succeeded")]]),
    });
    expect(columnOf(board, `${REPO}#4`)?.id).toBe("build.running");
  });
});

// ── The dispatch action, after a run has already happened ───────────────────

/**
 * The board must never be STRICTER than the gate it speaks for.
 *
 * `resolveBuildTrigger`'s `already-built` branch hard-skips a BOT re-label
 * only; this surface crosses with `senderIsBot: false`, so a human ask is an
 * explicit retry and the endpoint honours it. Disabling on "a run exists"
 * therefore refused something the server would have allowed — and on the ENTRY
 * column it was a dead end, because `unblock` is absent there (nowhere back to
 * move the card) and `retry` only resumes the same failed run in its stale
 * workspace.
 */
describe("buildBoard — dispatch after a previous run", () => {
  function run(status: string): BoardBuilderRun {
    return {
      id: "run-1",
      workflowName: "build",
      status,
      currentPhase: "guardrails",
      startedAt: "2026-09-01T00:00:00.000Z",
    };
  }

  function dispatchOn(board: ReturnType<typeof build>) {
    const columns = "columns" in board ? board.columns : [];
    return columns.flatMap((c) => c.cards)[0]?.actions.find((a) => a.id === "dispatch");
  }

  it("stays ENABLED after a failed run, and says Rebuild", () => {
    const board = build([item(4, ["agent-blocked"])], {
      runs: new Map([[`${REPO}#4`, run("failed")]]),
    });
    expect(dispatchOn(board)).toMatchObject({ enabled: true, label: "Rebuild" });
  });

  it("leaves a failed card on the ENTRY column a way forward", () => {
    // The trap, as a test. Here `unblock` is deliberately absent — the card is
    // already where "start again" would put it — so dispatch is the only exit.
    const board = build([item(4, ["ready-for-agent"])], {
      runs: new Map([[`${REPO}#4`, run("failed")]]),
    });
    const card = ("columns" in board ? board.columns : []).flatMap((c) => c.cards)[0];
    expect(card?.actions.find((a) => a.id === "unblock")).toBeUndefined();
    expect(dispatchOn(board)?.enabled).toBe(true);
  });

  it("says Start build when nothing has run yet", () => {
    const board = build([item(4, ["ready-for-agent"])]);
    expect(dispatchOn(board)).toMatchObject({ enabled: true, label: "Start build" });
  });

  it("is still disabled while a run owns the issue", () => {
    const board = build([item(4, ["agent-building"])], {
      runs: new Map([[`${REPO}#4`, run("running")]]),
    });
    expect(dispatchOn(board)).toMatchObject({
      enabled: false,
      disabledReason: "A run already owns this issue.",
    });
  });

  it("is still disabled on an unstaged card, and by a hold", () => {
    const unstaged = build([item(4, [])], { unstaged: true });
    const card = "unstaged" in unstaged ? unstaged.unstaged?.cards[0] : undefined;
    expect(card?.actions.find((a) => a.id === "dispatch")?.enabled).toBe(false);

    const heldBoard = build([item(4, ["ready-for-agent", HOLD])], {
      runs: new Map([[`${REPO}#4`, run("failed")]]),
    });
    expect(dispatchOn(heldBoard)?.enabled).toBe(false);
    expect(dispatchOn(heldBoard)?.disabledReason).toContain(HOLD);
  });
});
