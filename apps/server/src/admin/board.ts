/**
 * The pipeline board — the PURE projection of labels, runs and approvals onto
 * columns.
 *
 * Everything in this module is a function of its arguments. No Hono, no
 * GitHub, no database: the caller (`admin/routes.ts`) resolves the three
 * inputs — cached live items, one `latestForTriggers` map, one
 * `listPending()` — and hands them over. That is what makes the board's rules
 * table-testable, and it is the same split `pr-decisions.ts` makes against
 * `pr-state.ts`.
 *
 * ## Columns come from CONFIG, never from constants
 *
 * The stage vocabulary is operator-owned (`autonomy.stages`,
 * `engine/stage-labels.ts`), so the columns are read from it in the order the
 * operator declared them. A deployment that has configured no stages gets
 * `configured: false` and NO columns — the UI then says so, rather than the
 * server inventing "Intake / Triage / In Progress / Review". Those names come
 * from a mockup; they are examples, not a schema, and a board that shows
 * columns nothing writes to is a board that lies.
 *
 * Each stage contributes its four labels in pipeline order — `enter`,
 * `running`, `on_success`, `on_failure` — which is what turns one configured
 * stage into a legible four-column board rather than a single column. Labels
 * repeated across stages collapse onto their first column: a card carrying the
 * label belongs in one place, and the earlier position is the one the pipeline
 * reaches first.
 *
 * ## The RUN decides a tie; column order is the fallback
 *
 * A card carrying two stage labels is not an error state to refuse; it is the
 * ordinary result of `stage-advance.ts`'s ADD-then-REMOVE ordering failing
 * halfway (its module header explains why that direction is the safe one), or
 * of a re-run leaving an older verdict behind. Either way the card is flagged
 * `ambiguousStage: true` so the UI shows the pair rather than silently picking.
 *
 * WHICH column it lands in is decided by the latest run, when there is one:
 * a `succeeded` run means the `on_success` column and a `failed` one means
 * `on_failure`, because the run is the FACT and the labels are its projection.
 * Column order alone gets this wrong in the case that actually happens — an
 * issue that failed, was re-run, and succeeded carries both terminal labels,
 * and `on_failure` sits right-most, so the board would file a finished build
 * under "blocked" and show a green SUCCEEDED band inside a red column.
 *
 * With no run, or a run still in flight, the right-most matching column wins:
 * the card has PROGRESSED, and later stages are further right.
 *
 * ## Why the SERVER computes `actions`
 *
 * Because the server is the side that knows the hold label, the run lock and
 * the route map. Deriving them in the SPA would mean a second implementation of
 * policy in a place that cannot see any of the three — the #256 class of defect
 * exactly. In this slice the actions are advisory (the client renders them
 * inert), but they are computed honestly so that wiring them up later is a
 * client change, not a second policy.
 */

/** A label chip, as GitHub reports it. `color` is a bare hex string, no `#`. */
export interface BoardLabel {
  name: string;
  color: string;
  description?: string;
}

/**
 * A pull request that closes a board issue. Structurally satisfied by the
 * GitHub client's `BoardLinkedPr`.
 */
export interface BoardLinkedPr {
  number: number;
  url: string;
  title: string;
  /** `OPEN` | `CLOSED` | `MERGED`. */
  state: string;
  draft: boolean;
}

/**
 * The live item the board is projecting — one open ISSUE. Pull requests are
 * never cards: the pipeline builds issues, and a PR appears only as a link on
 * the issue it closes ({@link BoardLinkedPr}).
 */
export interface BoardBuilderItem {
  /** Qualified `owner/repo`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  labels: BoardLabel[];
  /** Pull requests that close this issue. Absent or empty when there are none. */
  linkedPrs?: BoardLinkedPr[];
  /** Flattened, server-truncated body text. Empty when GitHub gave us none. */
  body?: string;
}

/**
 * The run facts a card renders. Structurally satisfied by `WorkflowRun`, and
 * declared here rather than imported so the builder's tests need no store.
 */
export interface BoardBuilderRun {
  id: string;
  workflowName: string;
  status: string;
  currentPhase?: string;
  startedAt: string;
  /**
   * Why this run failed, short enough for a card. Present only on a FAILED run
   * whose ledger carried a reason — see `failureReasonsForRuns`. A FAILED band
   * with no reason cannot distinguish "blocked by guardrails" from "crashed",
   * which on the bootstrap path is the whole question.
   */
  failure?: { phase: string; reason: string };
  /**
   * The phase to SHOW for this run, when it differs from `currentPhase`.
   *
   * `currentPhase` is written on phase COMPLETION, so it lags by one for every
   * phase after the first — a run working on `executor` reads `architect`. This
   * is the honest answer: the ledger's in-flight phase for a live run, the
   * phase that failed for a failed one. Absent when the two agree or when
   * nothing better is known, and the card falls back to `currentPhase`.
   */
  phase?: string;
}

/** The approval facts a card renders. Structurally satisfied by `WorkflowApproval`. */
export interface BoardBuilderApproval {
  id: string;
  workflowRunId: string;
  gate: string;
  summary?: string;
  artifact?: string;
  createdAt: string;
}

/**
 * One configured stage, flattened. Structurally satisfied by
 * `AutonomyStageConfig` plus the record key it was declared under.
 */
export interface BoardStage {
  /** The key in `autonomy.stages` — `build` for the one shipped stage. */
  id: string;
  enter: string;
  running: string;
  on_success: string;
  on_failure: string;
}

/** An action the board offers on a card. */
export interface BoardAction {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  disabledReason?: string | null;
  /**
   * The stage label this action moves the card TO — set only on the
   * move-shaped actions (`unblock`).
   *
   * The SERVER names it for the same reason it computes `enabled`: stage labels
   * are operator-configured, so a client deriving "the entry column" from
   * column order would be re-deriving policy it cannot see. It also means the
   * button and the drag gesture post the identical request.
   */
  to?: string;
}

export interface BoardCard {
  /** `owner/repo#123` — also the `workflow_runs.triggerId` for this subject. */
  key: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  createdAt: string;
  url: string;
  labels: BoardLabel[];
  /**
   * Pull requests that close this issue — the build's PR once it exists, or one
   * a human opened. Absent when there are none (or on the throttled fallback,
   * which cannot read closing references).
   */
  linkedPrs?: BoardLinkedPr[];
  /**
   * A short excerpt of the item's body, already flattened and clipped by the
   * GitHub client. Absent or empty means GitHub gave us none — an item with no
   * description, or the throttled REST path, which does not fetch one.
   */
  body?: string;
  /** The stage label this card was filed under; empty for an unstaged card. */
  stageLabel: string;
  /** The card carries more than one configured stage label. */
  ambiguousStage: boolean;
  /** The hold label is on this card — Last Light is off this subject entirely. */
  held: boolean;
  /**
   * WHY it is held, in prose naming the operator's configured hold label.
   *
   * Present only when {@link held}. The server supplies it because the server
   * is the side that knows the label's name — it is operator-configurable, so
   * the client cannot render "remove `lastlight-ignore`" from a bare boolean
   * without hardcoding a string that may be wrong.
   */
  heldReason?: string;
  run?: BoardBuilderRun | null;
  approval?: BoardBuilderApproval | null;
  actions: BoardAction[];
}

export interface BoardColumn {
  /** Stable `<stage>.<slot>` id — survives an operator renaming the label. */
  id: string;
  title: string;
  /** The GitHub label this column collects. */
  label: string;
  count: number;
  /** Cards in this column with a pending approval — the HITL badge. */
  awaitingHumanCount: number;
  cards: BoardCard[];
}

export interface BoardScope {
  repos: string[];
  truncated: boolean;
  reason: string;
  /**
   * Every repo this board COULD show — the autonomy allow-list intersected with
   * the managed set — whether or not it is in the current `repos` scope.
   *
   * The scope picker is built from this rather than from `GET /repos`. That
   * endpoint answers "what does this deployment manage", which is a strictly
   * larger set, so a picker fed from it offers repos the board can never
   * display: pick one and you get an empty board with no explanation, because
   * the server correctly filtered it out. The eligible list is the server's own
   * answer to the only question the picker is asking.
   */
  eligible: string[];
}

export interface BoardDegradation {
  repo: string;
  error: string;
  staleSince?: string;
}

export interface BoardResponse {
  generatedAt: string;
  ttlSeconds: number;
  /** False when the operator has configured no `autonomy.stages`. */
  configured: boolean;
  scope: BoardScope;
  degraded: BoardDegradation[];
  columns: BoardColumn[];
  unstaged?: { count: number; cards: BoardCard[] };
}

export interface BuildBoardInput {
  /**
   * The phase each ACTIVE run is running right now, keyed by RUN id — one
   * `inFlightPhasesForRuns` answer. See {@link BoardBuilderRun.phase}.
   */
  inFlight?: Map<string, string>;
  /**
   * Why each FAILED run failed, keyed by RUN id — not by trigger id, unlike
   * {@link BuildBoardInput.runs}. One `failureReasonsForRuns` answer, passed in
   * rather than merged by the caller so the clipping rule lives here with the
   * rest of the projection and is table-tested with it.
   */
  failures?: Map<string, { phase: string; error: string }>;
  items: BoardBuilderItem[];
  /** Keyed by trigger id (`owner/repo#N`) — one `latestForTriggers` answer. */
  runs: Map<string, BoardBuilderRun>;
  /** Pending approvals, in any order; indexed by `workflowRunId` here. */
  approvals: BoardBuilderApproval[];
  /** The ordered `autonomy.stages` list. Empty means "not configured". */
  stages: BoardStage[];
  holdLabel: string;
  scope: BoardScope;
  degraded: BoardDegradation[];
  generatedAt?: string;
  ttlSeconds: number;
}

export interface BuildBoardOptions {
  /** Populate the `unstaged` bucket. Off by default — it is the long tail. */
  unstaged?: boolean;
}

/** The universal subject key. Matches `build-decisions.ts`'s `issueTriggerId`. */
function cardKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/**
 * A column heading from a label name: `ready-for-agent` → `Ready for agent`.
 *
 * Derived rather than mapped, because the label is operator-owned — a lookup
 * table would render a renamed stage as a blank or a stale heading, and the
 * label is the only name the operator ever wrote down.
 */
function titleForLabel(label: string): string {
  const words = label.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : label;
}

/**
 * The ordered column definitions for a set of stages.
 *
 * Four slots per stage in pipeline order, skipping unconfigured labels and
 * collapsing a label two stages share onto its first column.
 */
function columnsForStages(stages: BoardStage[]): Array<{ id: string; title: string; label: string }> {
  const slots: Array<keyof Omit<BoardStage, "id">> = ["enter", "running", "on_success", "on_failure"];
  const seen = new Set<string>();
  const out: Array<{ id: string; title: string; label: string }> = [];
  for (const stage of stages) {
    for (const slot of slots) {
      const label = stage[slot];
      if (!label || seen.has(label)) continue;
      seen.add(label);
      out.push({ id: `${stage.id}.${slot}`, title: titleForLabel(label), label });
    }
  }
  return out;
}

/**
 * Why a held card is inert, in the wording `holdReply` uses on every other
 * surface — it NAMES the label, because the label is the remedy.
 *
 * Declared once and read by both the card's `heldReason` and every disabled
 * action's `disabledReason`, so the tooltip and the menu item can never
 * disagree about why the same card is inert. The client used to derive this by
 * taking the first action that happened to carry a reason, which is a guess: on
 * a card whose actions are disabled for an unrelated cause (a run already owns
 * it) that guess reads back the wrong sentence entirely.
 *
 * Not imported from `pr-decisions.ts`'s `holdReply`: this module is pure by
 * construction and has no imports at all, and the two sentences address
 * different readers — that one answers a maintainer who asked the bot to act,
 * this one labels a card in a UI.
 */
function heldReasonFor(holdLabel: string): string {
  return `Held by \`${holdLabel}\` — remove the label to let Last Light act.`;
}

/**
 * What the board offers to DO with a card, and why it can't.
 *
 * The order of the branches is the policy. A hold outranks everything, for the
 * same reason it does at the dispatch gate (`build-decisions.ts` branch 1): it
 * is the one instruction that means "you, the bot, are off this subject
 * entirely", and an action that stayed enabled through it would not mean that.
 * Opening the item on GitHub survives a hold because reading is not acting.
 */
function actionsFor(args: {
  held: boolean;
  holdLabel: string;
  run: BoardBuilderRun | null;
  approval: BoardBuilderApproval | null;
  staged: boolean;
  /** The label this card is filed under now. */
  stageLabel: string;
  /** Its stage's `enter` label — where "start again" puts it. */
  entryLabel: string | null;
  /** Its stage's `on_failure` label — where a stopped run parks. */
  failureLabel: string | null;
}): BoardAction[] {
  const { held, holdLabel, run, approval, staged, stageLabel, entryLabel, failureLabel } = args;
  const actions: BoardAction[] = [
    { id: "open", label: "Open on GitHub", kind: "link", enabled: true, disabledReason: null },
  ];
  const holdReason = heldReasonFor(holdLabel);
  const gate = (action: BoardAction): BoardAction =>
    held ? { ...action, enabled: false, disabledReason: holdReason } : action;

  if (approval) {
    actions.push(
      gate({ id: "approve", label: "Approve", kind: "approval", enabled: true, disabledReason: null }),
      gate({ id: "reject", label: "Reject", kind: "approval", enabled: true, disabledReason: null }),
    );
  }

  const live = run ? ["queued", "running", "paused"].includes(run.status) : false;
  if (live) {
    actions.push(gate({ id: "cancel", label: "Cancel run", kind: "run", enabled: true, disabledReason: null }));
  } else if (run && run.status === "failed") {
    actions.push(gate({ id: "retry", label: "Retry run", kind: "run", enabled: true, disabledReason: null }));
  }

  // ── UNBLOCK ───────────────────────────────────────────────────────────
  //
  // The affordance for a card that has STOPPED: it carries the stage's
  // `on_failure` label, or its last run failed, and nothing will move it again
  // on its own — the backstop sweep queries the `enter` label, so a parked card
  // is deliberately invisible to it (`issue-discovery.ts`).
  //
  // Distinct from `retry` above, and the distinction is the whole point.
  // `retry` RESUMES the same run: same row, same branch, same workspace, from
  // the phase that failed. This starts AGAIN — it moves the card back to the
  // entry column, which crosses the dispatch gate as the human who pressed it
  // and begins a fresh build. A guardrails block wants this one; a run that
  // died on a flaky step wants the other.
  //
  // It posts the SAME request the drag gesture does, which is why it carries
  // `to` rather than a dedicated endpoint: one path, one gate, one set of
  // refusals. The stale FAILED band clears by itself, because the new run
  // becomes the latest for this trigger.
  const parked =
    staged &&
    !!entryLabel &&
    stageLabel !== entryLabel &&
    (run?.status === "failed" || (!!failureLabel && stageLabel === failureLabel));
  if (parked) {
    const disabledReason = held ? holdReason : live ? "A run already owns this issue." : null;
    actions.push({
      id: "unblock",
      label: "Unblock & rebuild",
      kind: "stage",
      enabled: !disabledReason,
      disabledReason,
      to: entryLabel!,
    });
  }

  // A PREVIOUS run does NOT disable it, and that is load-bearing. The gate
  // treats a human ask as an explicit retry — `resolveBuildTrigger`'s
  // `already-built` branch hard-skips only a BOT re-label, and this surface
  // crosses with `senderIsBot: false` — so disabling on `run` made the board
  // STRICTER than the server it speaks for, refusing something the endpoint
  // would have honoured.
  //
  // That was a trap with no way out. An issue whose build failed on the ENTRY
  // column has no `unblock` (there is nowhere back to move it) and no
  // `dispatch` (a run exists), leaving only `retry`, which resumes the same
  // failed run in its stale workspace. If the blocker was fixed upstream, that
  // is precisely the one thing that cannot help.
  {
    const disabledReason = held
      ? holdReason
      : live
        ? "A run already owns this issue."
        : !staged
          ? "No stage label — apply one to put this issue in the pipeline."
          : null;
    actions.push({
      id: "dispatch",
      // Named for what it does to THIS card: a first build, or another one.
      label: run ? "Rebuild" : "Start build",
      kind: "dispatch",
      enabled: !disabledReason,
      disabledReason,
    });
  }

  return actions;
}

/**
 * Project the live items onto the configured columns.
 *
 * Three inputs, no I/O, no exceptions. An item that matches no column is
 * unstaged — an ordinary open issue the pipeline has not been asked about.
 */
/**
 * Two rendered lines' worth of reason. The same argument `boardExcerpt` makes
 * about bodies: a thrown failure's `error` can be a whole stack trace, and the
 * payload is the budget — so it is clipped HERE, on the server, rather than by
 * a CSS clamp that ships the whole trace to every open tab.
 */
const FAILURE_REASON_CHARS = 160;

/** A ledger error, flattened and clipped for a card. */
function failureReason(error: string): string {
  const flat = error.replace(/\s+/g, " ").trim();
  return flat.length > FAILURE_REASON_CHARS ? `${flat.slice(0, FAILURE_REASON_CHARS - 1)}…` : flat;
}

/**
 * `<workflowName>:<phaseName>` → `phaseName`. Ledger rows are namespaced by
 * their workflow; the card already says which workflow it is.
 */
function phaseOfSkill(workflowName: string, skill: string): string {
  const prefix = `${workflowName}:`;
  return skill.startsWith(prefix) ? skill.slice(prefix.length) : skill;
}

export function buildBoard(input: BuildBoardInput, opts: BuildBoardOptions = {}): BoardResponse {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const base = {
    generatedAt,
    ttlSeconds: input.ttlSeconds,
    scope: input.scope,
    degraded: input.degraded,
  };

  const defs = columnsForStages(input.stages);
  if (defs.length === 0) {
    // Not configured. No columns at all — see the module header.
    return { ...base, configured: false, columns: [] };
  }

  const approvalsByRun = new Map<string, BoardBuilderApproval>();
  for (const approval of input.approvals) {
    // Newest wins only if the caller ordered them so; a run has at most one
    // pending gate in practice, so the first entry stands.
    if (!approvalsByRun.has(approval.workflowRunId)) approvalsByRun.set(approval.workflowRunId, approval);
  }

  const columnIndexByLabel = new Map<string, number>();
  defs.forEach((def, idx) => columnIndexByLabel.set(def.label, idx));

  const columns: BoardColumn[] = defs.map((def) => ({
    ...def,
    count: 0,
    awaitingHumanCount: 0,
    cards: [],
  }));
  const unstaged: BoardCard[] = [];

  for (const item of input.items) {
    const names = item.labels.map((l) => l.name);
    const held = names.includes(input.holdLabel);

    const key = cardKey(item.repo, item.number);
    const baseRun = input.runs.get(key) ?? null;

    // The FALLBACK placement: right-most configured stage, on the reading that
    // the card has progressed. A finished run overrides it just below.
    let index = -1;
    let matches = 0;
    const matched: number[] = [];
    for (const name of names) {
      const at = columnIndexByLabel.get(name);
      if (at === undefined) continue;
      matches++;
      matched.push(at);
      if (at > index) index = at;
    }

    // ── THE TIE-BREAK ───────────────────────────────────────────────────────
    //
    // Two stage labels and a finished run: the RUN is the fact, so it picks the
    // column. See the module header — column order alone files a re-run that
    // succeeded under "blocked", because `on_failure` sits right-most.
    if (matches > 1 && baseRun) {
      const wanted =
        baseRun.status === "succeeded"
          ? ".on_success"
          : baseRun.status === "failed" || baseRun.status === "cancelled"
            ? ".on_failure"
            : null;
      if (wanted) {
        const byRun = matched.find((at) => defs[at]!.id.endsWith(wanted));
        if (byRun !== undefined) index = byRun;
      }
    }

    // Which STAGE this card is filed under, so "back to the start" means that
    // stage's entry column rather than the board's first one.
    const stageId = index >= 0 ? (defs[index]!.id.split(".")[0] ?? "") : "";
    const stage = stageId ? input.stages.find((candidate) => candidate.id === stageId) ?? null : null;

    // Only a FAILED run owes an explanation, and only the ledger has one.
    const failed = baseRun?.status === "failed" ? input.failures?.get(baseRun.id) : undefined;
    // The phase to SHOW. `currentPhase` is written on completion, so it lags —
    // prefer the ledger's answer: what a live run is running, or what a failed
    // one died in.
    const liveNow = baseRun ? input.inFlight?.get(baseRun.id) : undefined;
    const displayPhase = failed
      ? phaseOfSkill(baseRun!.workflowName, failed.phase)
      : liveNow
        ? phaseOfSkill(baseRun!.workflowName, liveNow)
        : undefined;

    const run: BoardBuilderRun | null = baseRun
      ? {
          ...baseRun,
          ...(failed
            ? {
                failure: {
                  phase: phaseOfSkill(baseRun.workflowName, failed.phase),
                  reason: failureReason(failed.error),
                },
              }
            : {}),
          ...(displayPhase && displayPhase !== baseRun.currentPhase ? { phase: displayPhase } : {}),
        }
      : null;
    const approval = run ? approvalsByRun.get(run.id) ?? null : null;
    const staged = index >= 0;

    const card: BoardCard = {
      key,
      repo: item.repo,
      number: item.number,
      title: item.title,
      author: item.author,
      createdAt: item.createdAt,
      url: item.url,
      labels: item.labels,
      ...(item.body ? { body: item.body } : {}),
      ...(item.linkedPrs && item.linkedPrs.length > 0 ? { linkedPrs: item.linkedPrs } : {}),
      stageLabel: staged ? columns[index]!.label : "",
      ambiguousStage: matches > 1,
      held,
      ...(held ? { heldReason: heldReasonFor(input.holdLabel) } : {}),
      run,
      approval,
      actions: actionsFor({
        held,
        holdLabel: input.holdLabel,
        run,
        approval,
        staged,
        stageLabel: staged ? columns[index]!.label : "",
        entryLabel: stage?.enter ?? null,
        failureLabel: stage?.on_failure ?? null,
      }),
    };

    if (!staged) {
      unstaged.push(card);
      continue;
    }
    const column = columns[index]!;
    column.cards.push(card);
    column.count++;
    if (approval) column.awaitingHumanCount++;
  }

  return {
    ...base,
    configured: true,
    columns,
    ...(opts.unstaged ? { unstaged: { count: unstaged.length, cards: unstaged } } : {}),
  };
}
