import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type ReactFlowInstance,
  Background,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  WorkflowRun,
  WorkflowDefinition,
  PhaseHistoryEntry,
  WorkflowRunExecution,
  WorkflowApproval,
} from "../api";
import {
  pipelineNodeTypes,
  type PhaseStatus,
  type PipelineNodeData,
} from "./pipeline-node";
import { isNoOpSummary, phaseSummary } from "../lib/phase-outcome";

type PhaseNodeData = PipelineNodeData;

const nodeTypes = pipelineNodeTypes;

/** Compare the run-view fields we actually render, to skip needless updates. */
function nodeDataEqual(a: PhaseNodeData, b: PhaseNodeData): boolean {
  return (
    a.label === b.label &&
    a.status === b.status &&
    a.timestamp === b.timestamp &&
    a.duration === b.duration &&
    a.selected === b.selected &&
    a.kind === b.kind &&
    a.pulse === b.pulse &&
    a.summary === b.summary
  );
}

/**
 * Merge freshly-computed nodes into the live xyflow state, preserving the
 * object identity — and thus xyflow's measured dimensions — of any node whose
 * id, position and rendered data are unchanged. Returns `prev` untouched when
 * nothing changed so React bails out of the update entirely. The pipeline
 * polls every few seconds, so this keeps the per-poll churn (and the window for
 * the fitView-vs-store-update race that blanked the canvas) to a minimum.
 */
function reconcileNodes(
  prev: Node<PhaseNodeData>[],
  next: Node<PhaseNodeData>[],
): Node<PhaseNodeData>[] {
  const prevById = new Map(prev.map((n) => [n.id, n] as const));
  let changed = prev.length !== next.length;
  const merged = next.map((n) => {
    const old = prevById.get(n.id);
    if (
      old &&
      old.position.x === n.position.x &&
      old.position.y === n.position.y &&
      old.parentId === n.parentId &&
      old.type === n.type &&
      nodeDataEqual(old.data, n.data)
    ) {
      return old; // unchanged — keep identity + xyflow's measured dimensions
    }
    changed = true;
    // `parentId` / `extent` / `type` must be carried across explicitly: a node
    // that gained a parent between polls (a fan-out's first branch appearing)
    // would otherwise keep the old object's absent parentId and render at the
    // canvas origin, because child positions are RELATIVE to the parent.
    return old
      ? {
          ...old,
          type: n.type,
          position: n.position,
          data: n.data,
          style: n.style,
          parentId: n.parentId,
          extent: n.extent,
        }
      : n;
  });
  if (!changed) {
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] !== prev[i]) {
        changed = true;
        break;
      }
    }
  }
  return changed ? merged : prev;
}

/** Same idea for edges — they only change when nodes are added / removed. */
function reconcileEdges(prev: Edge[], next: Edge[]): Edge[] {
  const prevById = new Map(prev.map((e) => [e.id, e] as const));
  let changed = prev.length !== next.length;
  const merged = next.map((e) => {
    const old = prevById.get(e.id);
    if (old && old.source === e.source && old.target === e.target) return old;
    changed = true;
    return e;
  });
  if (!changed) {
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] !== prev[i]) {
        changed = true;
        break;
      }
    }
  }
  return changed ? merged : prev;
}

/**
 * Card width. Wider than it needs to be for the text, deliberately: the phase
 * labels are sentences ("Reconcile · the conservation floor"), and at a narrow
 * width each one wraps to a different number of lines, so every card in the row
 * was a different height. Width is the cheap lever on that — it buys uniform
 * height without truncating anything.
 */
const NODE_WIDTH = 150;
const NODE_GAP = 40;
// Approximate rendered height of a nested node (label + the combined
// time·duration line + padding). Sets the vertical pitch inside a container.
const NODE_ROW_HEIGHT = 62;
const ROW_GAP = 20;
// ── Container geometry (fan-out branches and loop iterations) ─────────────
// A phase with dynamic children is drawn as a box they sit INSIDE (React Flow
// `parentId`), rather than as a card with a vertical stack hanging off it. The
// stack was the bug: five branches interleaved with five gate cards made a
// ten-deep ladder that ran off the canvas and pushed the rest of the row out of
// frame, while drawing concurrent work as something with an order.
const GROUP_PAD = 10;
/**
 * Header height inside the container, i.e. where the first child starts.
 *
 * Sized for the WORST case rather than the average: a two-line wrapped label
 * plus the combined time·duration line and the child count. A one-line label
 * leaves a little slack, which is the cheap direction to be wrong in — too
 * small and the header sits on top of the first child.
 */
const GROUP_HEADER = 76;
/** Vertical pitch between branches inside the container. */
const BRANCH_GAP = 12;

/**
 * Map a dynamic phase name (e.g. "reviewer_fix_1", "reviewer_recheck_1") back
 * to the declared phase it iterates on. The runner names loop iterations like
 * `${parent}_recheck_${n}` (re-reviews) or `${parent}_fix_${n}` (fix
 * iterations), so the parent is the longest declared name `d` such that the
 * dynamic name is `${d}` or starts with `${d}_`.
 */
function findParentDeclared(name: string, declared: string[]): string | null {
  let best: string | null = null;
  for (const d of declared) {
    if (name === d || name.startsWith(`${d}_`)) {
      if (!best || d.length > best.length) best = d;
    }
  }
  return best;
}

/**
 * The derived-phase-name grammar, MIRRORED from
 * `packages/workflow-engine/src/core/phase-ref.ts` (`PhaseRef.format`/`parse`).
 *
 * Mirrored rather than imported because the dashboard has no dependency on
 * `lastlight-workflow-engine` — the same reason it hand-mirrors the config
 * types in `api.ts`. If the grammar there gains a form, it has to be added
 * here too; the failure mode is cosmetic (the raw ledger key renders, which is
 * exactly what this replaces) rather than a crash.
 *
 * Branch names are schema-constrained to `[A-Za-z0-9-]`, and that is what makes
 * the greedy-base split unambiguous against a base that may itself contain `_`.
 * Order matters: the two SUFFIXED branch forms must be tried before the bare
 * one, and likewise for the iteration forms.
 */
type DerivedRef =
  | { kind: "branch"; base: string; branch: string; suffix?: "retry" | "check" }
  | { kind: "iter"; base: string; index: number; suffix?: "retry" | "check" }
  | { kind: "fix" | "recheck"; base: string; index: number };

function parseDerived(name: string): DerivedRef | null {
  let m = name.match(/^(.*)_branch_([A-Za-z0-9-]+)_(retry|check)$/);
  if (m) return { kind: "branch", base: m[1]!, branch: m[2]!, suffix: m[3] as "retry" | "check" };
  m = name.match(/^(.*)_branch_([A-Za-z0-9-]+)$/);
  if (m) return { kind: "branch", base: m[1]!, branch: m[2]! };
  m = name.match(/^(.*)_iter_(\d+)_(retry|check)$/);
  if (m) return { kind: "iter", base: m[1]!, index: Number(m[2]), suffix: m[3] as "retry" | "check" };
  m = name.match(/^(.*)_iter_(\d+)$/);
  if (m) return { kind: "iter", base: m[1]!, index: Number(m[2]) };
  m = name.match(/^(.*)_fix_(\d+)$/);
  if (m) return { kind: "fix", base: m[1]!, index: Number(m[2]) };
  m = name.match(/^(.*)_recheck_(\d+)$/);
  if (m) return { kind: "recheck", base: m[1]!, index: Number(m[2]) };
  return null;
}

/**
 * A SHORT label for a derived node. Short is the requirement, not a preference:
 * these render in a narrow card inside a parent that already names the phase,
 * so
 * `survey_branch_contract` overflowed its box and read as a different phase
 * rather than as one branch of the node directly above it.
 */
function derivedLabel(ref: DerivedRef): string {
  const suffix = "suffix" in ref && ref.suffix ? (ref.suffix === "check" ? " · gate" : " · retry") : "";
  switch (ref.kind) {
    case "branch":
      return `${ref.branch}${suffix}`;
    case "iter":
      return `#${ref.index}${suffix}`;
    case "fix":
      return `fix ${ref.index}`;
    case "recheck":
      return `recheck ${ref.index}`;
  }
}

/**
 * The node a `_retry` / `_check` row is a verdict ABOUT, if it is one.
 *
 * Both shapes of container have them: a fan-out branch
 * (`survey_branch_contract_check`) and a loop iteration
 * (`adjudicate_iter_1_check`). Neither is independent work, so neither gets a
 * card of its own — see {@link foldGateStatus}.
 */
function gateOwnerOf(name: string): string | null {
  const ref = parseDerived(name);
  if (!ref) return null;
  if (ref.kind === "branch" && ref.suffix) return `${ref.base}_branch_${ref.branch}`;
  if (ref.kind === "iter" && ref.suffix) return `${ref.base}_iter_${ref.index}`;
  return null;
}

/**
 * Fold a `_check` (exit gate) or `_retry` row INTO the status of the node it
 * judges, instead of drawing it as a sibling card.
 *
 * A gate is a verdict about the row above it, not work of its own, and giving
 * each one a card doubled the height of every fan-out and every loop for rows
 * whose entire content is a tone. The verdict is not dropped — it decides the
 * colour, and the reason rides the card's tooltip and the detail panel.
 *
 * `unmet` only overrides a row that otherwise passed. A row that genuinely
 * failed keeps `failed`: a red gate under a red iteration is the same news
 * twice, and the row's own failure is the more specific of the two.
 */
function foldGateStatus(
  ownStatus: PhaseStatus,
  gate: WorkflowRunExecution | undefined,
): PhaseStatus {
  if (!gate || ownStatus !== "done") return ownStatus;
  if (gate.success === true && gate.stopReason === "condition_not_met") return "unmet";
  if (gate.success === false && gate.stopReason !== "skipped") return "failed";
  return ownStatus;
}

interface Props {
  run: WorkflowRun;
  /** Workflow YAML definition. The pipeline is fully definition-driven. */
  definition: WorkflowDefinition | null;
  /**
   * Per-phase execution rows from /workflow-runs/:id/executions. Used as the
   * source of truth for node timing (started, duration) — phase_history only
   * records the moment persistPhase fired, which is *after* a phase
   * completes, so its timestamps are useless as start times.
   */
  executions?: WorkflowRunExecution[];
  /**
   * Approval gates for this run (all statuses). Rendered in place of the
   * generic `waiting_approval` history marker as status-colored gate nodes,
   * labeled by gate name. Node ids are `approval:<id>` so the detail panel can
   * resolve the clicked gate back to its record.
   */
  approvals?: WorkflowApproval[];
  /** Pixel height of the pipeline canvas. Defaults to 180. */
  height?: number | string;
  /** Optional: phase name currently selected (for visual indicator). */
  selectedPhase?: string | null;
  /** Optional: invoked when the user clicks a phase node. */
  onPhaseClick?: (phaseName: string) => void;
}

/**
 * Pipeline visualisation for a workflow run. Fully driven by the workflow
 * YAML definition (passed in as a prop, fetched once by the parent so the
 * detail panel can share it) — no hardcoded phase lists, no fallback labels.
 *
 * Phase visual states are derived from `run.phaseHistory` (completed) and
 * `run.currentPhase` (active). Phases that show up in history but aren't in
 * the definition (e.g. dynamically-named loop iterations like
 * reviewer_recheck_1, reviewer_fix_1) are appended after the definition's phases so they remain
 * visible.
 */
export function WorkflowPipeline({
  run,
  definition,
  executions,
  approvals,
  height = 180,
  selectedPhase,
  onPhaseClick,
}: Props) {
  const computed = useMemo(() => {
    if (!definition) {
      return { nodes: [] as Node<PhaseNodeData>[], edges: [] as Edge[], canvasHeight: 0 };
    }

    const historyMap = new Map<string, PhaseHistoryEntry>();
    for (const entry of run.phaseHistory) {
      // Tolerate a malformed / legacy history row (no `phase`) rather than
      // letting an undefined name crash the whole pipeline downstream.
      if (!entry?.phase) continue;
      historyMap.set(entry.phase, entry);
    }

    // phase → most-recent-execution. Loop iterations (reviewer_recheck_1, etc.) get
    // their own keys here so each iteration is independently selectable.
    const execByPhase = new Map<string, WorkflowRunExecution>();
    for (const ex of executions ?? []) {
      execByPhase.set(ex.phase, ex);
    }

    const declaredNames = definition.phases.map((p) => p.name);
    const declaredSet = new Set(declaredNames);
    const declaredLabelByName = new Map(
      definition.phases.map((p) => [p.name, p.label] as const),
    );

    // Dynamic phases that don't appear in the YAML — loop iterations like
    // `reviewer_recheck_1` (re-reviews) and `reviewer_fix_1` (fix attempts).
    const dynamicNames = Array.from(
      new Set([
        ...run.phaseHistory.map((e) => e.phase),
        ...(executions ?? []).map((e) => e.phase),
      ]),
    ).filter((name): name is string => Boolean(name) && !declaredSet.has(name));

    // Group each dynamic phase under its declared parent, sorted by start
    // time so iteration order matches the actual run.
    const childrenByParent = new Map<string, string[]>();
    const orphans: string[] = [];
    for (const name of dynamicNames) {
      const parent = findParentDeclared(name, declaredNames);
      if (parent) {
        const arr = childrenByParent.get(parent) ?? [];
        arr.push(name);
        childrenByParent.set(parent, arr);
      } else {
        orphans.push(name);
      }
    }
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => {
        const ea = execByPhase.get(a)?.startedAt;
        const eb = execByPhase.get(b)?.startedAt;
        if (ea && eb) return ea.localeCompare(eb);
        return a.localeCompare(b);
      });
    }

    const isTerminalRun =
      run.status === "failed" || run.status === "succeeded" || run.status === "cancelled";

    const buildNode = (
      name: string,
      x: number,
      y: number,
      opts: {
        /** Render the outcome summary line. Top-row nodes only — see below. */
        withSummary?: boolean;
        /** Fold this row's verdict into the node's status (fan-out branches). */
        gate?: WorkflowRunExecution;
      } = {},
    ): Node<PhaseNodeData> => {
      // Declared name → its YAML `label:`. Otherwise it is a DERIVED name
      // (a fan-out branch or a loop iteration), and the raw ledger key is the
      // last resort rather than the default: `survey_branch_contract` overflows
      // a branch card and reads as an unrelated phase instead of as one branch
      // of the node above it.
      const derived = declaredLabelByName.has(name) ? null : parseDerived(name);
      const label = declaredLabelByName.get(name) ?? (derived ? derivedLabel(derived) : name);
      const histEntry = historyMap.get(name);
      const exec = execByPhase.get(name);

      let status: PhaseStatus = "pending";
      let timestamp: string | undefined;
      let duration: number | undefined;

      if (exec) {
        // Execution row is the source of truth for both timing and status —
        // phase_history is just a "this happened" marker written after the
        // fact and would otherwise show finish time as if it were start time.
        timestamp = exec.startedAt;
        if (typeof exec.durationMs === "number") {
          duration = exec.durationMs / 1000;
        }
        if (exec.success === true)
          // A generic-loop `until_bash` check (`<phase>_iter_N_check`) records
          // success = "did the check run", with the verdict in stopReason. A
          // RED gate ran fine but did NOT finish the loop — neither green nor
          // red, so give it the muted `unmet` tone.
          status = exec.stopReason === "condition_not_met" ? "unmet" : "done";
        else if (exec.success === false)
          // A cascade-skipped phase is stored as success=0 (so it re-evaluates
          // on resume) but carries stopReason="skipped" — it never ran, so don't
          // paint it red like a genuine failure.
          status = exec.stopReason === "skipped" ? "skipped" : "failed";
        // A row with no `success` is unfinished. On a live run that's "active";
        // on a terminal run it's a never-finalized (dangling) row — show it as
        // failed rather than a perpetually-pulsing "active".
        else status = isTerminalRun ? "failed" : "active";
      } else if (histEntry) {
        status = histEntry.success ? "done" : "failed";
        timestamp = histEntry.timestamp;
      } else if (name === run.currentPhase) {
        status = run.status === "paused" ? "paused" : "active";
      }

      // A declared loop phase (e.g. `socratic`) has no execution of its own —
      // the work happened in its dynamic iterations. Derive its status + timing
      // from them so it doesn't render as a perpetually "pending" parent.
      if (status === "pending") {
        const kids = childrenByParent.get(name) ?? [];
        const kidExecs = kids
          .map((k) => execByPhase.get(k))
          .filter((e): e is WorkflowRunExecution => !!e);
        if (kidExecs.length > 0) {
          // A FAN-OUT's children are concurrent; a LOOP's are sequential. That
          // one difference changes both answers below, so decide it once.
          const isFanout = kids.some((k) => parseDerived(k)?.kind === "branch");
          const lastExec = execByPhase.get(kids[kids.length - 1]!);
          if (kidExecs.some((kx) => kx.success === undefined))
            status = isTerminalRun ? "failed" : "active";
          else if (isFanout) {
            // "Last child wins" is a loop rule — the final iteration is the
            // outcome. Concurrent branches have no last, only a worst: one red
            // branch is a red fan-out however the start times happened to sort.
            const failed = kidExecs.find((kx) => kx.success === false && kx.stopReason !== "skipped");
            const skipped = kidExecs.every((kx) => kx.stopReason === "skipped");
            status = failed ? "failed" : skipped ? "skipped" : "done";
          } else if (lastExec?.success === true)
            // Same rule as the leaf above: a loop whose LAST child is a red
            // exit check ran out of iterations without its gate ever going
            // green. That is not a failure, but it is not a pass either.
            status = lastExec.stopReason === "condition_not_met" ? "unmet" : "done";
          else if (lastExec?.success === false)
            status = lastExec.stopReason === "skipped" ? "skipped" : "failed";
          timestamp = kidExecs.reduce(
            (min, kx) => (kx.startedAt < min ? kx.startedAt : min),
            kidExecs[0]!.startedAt,
          );
          if (isFanout) {
            // WALL CLOCK, not the sum. Summing concurrent branches reports a
            // number the run never spent: the five surveys of a real pr-review
            // measured 161+59+235+233+194s, which summed to 882s for a phase
            // that actually took 235 — so the fan-out looked like the most
            // expensive step in the run when it was the point at which the run
            // stopped being sequential.
            const startMs = kidExecs.map((kx) => Date.parse(kx.startedAt));
            const endMs = kidExecs.map((kx) => Date.parse(kx.startedAt) + (kx.durationMs ?? 0));
            const spanMs = Math.max(...endMs) - Math.min(...startMs);
            if (spanMs > 0) duration = spanMs / 1000;
          } else {
            const totalMs = kidExecs.reduce((sum, kx) => sum + (kx.durationMs ?? 0), 0);
            if (totalMs > 0) duration = totalMs / 1000;
          }
        }
      }

      // A fan-out branch's exit gate is a verdict about the branch, not work of
      // its own — fold it in rather than drawing it as a second card.
      status = foldGateStatus(status, opts.gate);

      // What the phase DID, so a green-but-did-nothing node is distinguishable
      // from a green-and-did-a-lot one without opening the panel.
      //
      // TOP ROW ONLY. Two reasons, both about not bloating the graph: the
      // nested nodes are loop iterations and fan-out branches whose summaries
      // are boilerplate ("iteration 3 — work complete"), and their vertical
      // pitch is a fixed constant an extra line per card would silently
      // overrun. Every node still carries the full text in its tooltip and in
      // the detail panel.
      //
      // Passed in rather than inferred from `y === 0`: a fan-out branch is a
      // React Flow child, so its `y` is relative to its container and the first
      // branch in every fan-out is at `y === 0` without being a top-row node.
      const summary = opts.withSummary ? phaseSummary(histEntry) : undefined;

      return {
        id: name,
        type: "phase",
        position: { x, y },
        data: {
          label,
          status,
          timestamp,
          duration,
          summary,
          summaryNoOp: summary ? isNoOpSummary(summary) : undefined,
          selected: selectedPhase === name,
        },
        style: { width: NODE_WIDTH },
      };
    };

    // An approval gate, rendered in place of the generic `waiting_approval`
    // history marker. Colored by approval status; a pending gate pulses to
    // signal it's blocking the run.
    const buildApprovalNode = (a: WorkflowApproval, x: number, y = 0): Node<PhaseNodeData> => {
      const id = `approval:${a.id}`;
      const status: PhaseStatus =
        a.status === "approved" ? "done" : a.status === "rejected" ? "failed" : "paused";
      return {
        id,
        type: "phase",
        position: { x, y },
        data: {
          label: a.gate,
          status,
          kind: "approval",
          pulse: a.status === "pending",
          timestamp: a.respondedAt ?? a.createdAt,
          selected: selectedPhase === id,
        },
        style: { width: NODE_WIDTH },
      };
    };

    const reactFlowNodes: Node<PhaseNodeData>[] = [];
    const reactFlowEdges: Edge[] = [];
    const linkTo = (target: string, prev: string | undefined) => {
      if (!prev) return;
      reactFlowEdges.push({
        id: `${prev}->${target}`,
        source: prev,
        target,
        sourceHandle: "right",
        targetHandle: "left",
        style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
        animated: false,
      });
    };

    // Start time of a declared phase (execution row first, else its history
    // marker) — used to slot each approval gate into its true chronological
    // position rather than dumping all gates at the tail.
    const startOf = (name: string): string | undefined =>
      execByPhase.get(name)?.startedAt ?? historyMap.get(name)?.timestamp;

    // For each approval, the declared phase it should follow: the last declared
    // phase (in declaration order) that started before the gate was created.
    // -1 → before the first phase. Robust to non-monotonic start times — it
    // tracks the highest matching index, not a running count. So a
    // `post_architect` gate lands right after Architect, not after PR.
    const approvalRows = approvals ?? [];
    // An approval whose gate names a dynamic loop iteration (e.g. the interactive
    // generic_loop gate `socratic_iter_2`) belongs in that iteration's vertical
    // stack, not the main horizontal row. Split those out; the rest slot into
    // the top row by chronological position.
    const dynamicSet = new Set(dynamicNames);
    const loopApprovalsByIter = new Map<string, WorkflowApproval[]>();
    const mainRowApprovals: WorkflowApproval[] = [];
    for (const a of approvalRows) {
      if (dynamicSet.has(a.gate)) {
        const arr = loopApprovalsByIter.get(a.gate) ?? [];
        arr.push(a);
        loopApprovalsByIter.set(a.gate, arr);
      } else {
        mainRowApprovals.push(a);
      }
    }
    const approvalsAfterIdx = new Map<number, WorkflowApproval[]>();
    for (const a of mainRowApprovals) {
      let afterIdx = -1;
      declaredNames.forEach((name, idx) => {
        const s = startOf(name);
        if (s && s < a.createdAt) afterIdx = idx;
      });
      const arr = approvalsAfterIdx.get(afterIdx) ?? [];
      arr.push(a);
      approvalsAfterIdx.set(afterIdx, arr);
    }

    // Ordered top-row slots: declared phases in declaration order, with approval
    // gates spliced into their chronological slot. The generic `waiting_approval`
    // marker is suppressed once approvals have loaded (the gate nodes replace
    // it); if they haven't, it falls back to rendering as a plain orphan so a
    // paused run never loses the node.
    type Slot = { kind: "phase"; name: string } | { kind: "approval"; a: WorkflowApproval };
    const slots: Slot[] = [];
    for (const a of approvalsAfterIdx.get(-1) ?? []) slots.push({ kind: "approval", a });
    declaredNames.forEach((name, idx) => {
      slots.push({ kind: "phase", name });
      for (const a of approvalsAfterIdx.get(idx) ?? []) slots.push({ kind: "approval", a });
    });
    for (const name of orphans) {
      if (name === "waiting_approval" && approvalRows.length > 0) continue;
      slots.push({ kind: "phase", name });
    }

    // Lay the slots out left-to-right. A fan-out or loop phase becomes a
    // CONTAINER holding its children, so a column's height is the tallest
    // container rather than a stack depth.
    let maxGroupHeight = 0;
    let prevId: string | undefined;
    slots.forEach((slot, col) => {
      const x = col * (NODE_WIDTH + NODE_GAP);
      if (slot.kind === "approval") {
        const node = buildApprovalNode(slot.a, x);
        reactFlowNodes.push(node);
        linkTo(node.id, prevId);
        prevId = node.id;
        return;
      }
      const name = slot.name;
      const children = childrenByParent.get(name) ?? [];

      // No dynamic children — an ordinary card in the row.
      if (children.length === 0) {
        reactFlowNodes.push(buildNode(name, x, 0, { withSummary: true }));
        linkTo(name, prevId);
        prevId = name;
        return;
      }

      // ── A container column: a fan-out or a loop ──────────────────────────
      // Both draw their children INSIDE the parent (React Flow `parentId`)
      // rather than as a stack hanging below it. The one difference that
      // matters is preserved: a LOOP's iterations are sequential and stay
      // chained, a FAN-OUT's branches are concurrent and are not.
      const isFanout = children.some((c) => parseDerived(c)?.kind === "branch");

      // Split the rows that are real work from the `_retry` / `_check` rows,
      // which are verdicts about them and fold into their colour.
      const gateFor = new Map<string, WorkflowRunExecution>();
      const rows: string[] = [];
      for (const c of children) {
        const owner = gateOwnerOf(c);
        if (owner) {
          const ex = execByPhase.get(c);
          // A row can have both a `_retry` and a `_check`; keep whichever
          // actually decided the outcome (a red verdict beats a green one).
          if (ex && (!gateFor.has(owner) || ex.success !== true)) gateFor.set(owner, ex);
        } else {
          rows.push(c);
        }
      }
      // Fan-out branches sort by NAME: they start within milliseconds of each
      // other, so a start-time sort jittered the order between polls, and there
      // is no real order to preserve. Loop iterations keep the chronological
      // sort applied upstream — for them the order IS the information.
      if (isFanout) rows.sort((a, b) => a.localeCompare(b));

      // An interactive `generic_loop` approval belongs beside the iteration it
      // paused. These are human gates, not `until_bash` verdicts, so they stay
      // as their own (diamond) node rather than folding.
      type StackItem =
        | { kind: "phase"; name: string }
        | { kind: "approval"; a: WorkflowApproval };
      const stackItems: StackItem[] = [];
      for (const rowName of rows) {
        stackItems.push({ kind: "phase", name: rowName });
        for (const a of loopApprovalsByIter.get(rowName) ?? []) {
          stackItems.push({ kind: "approval", a });
        }
      }

      const groupWidth = NODE_WIDTH + GROUP_PAD * 2;
      const groupHeight =
        GROUP_HEADER +
        stackItems.length * NODE_ROW_HEIGHT +
        Math.max(0, stackItems.length - 1) * BRANCH_GAP +
        GROUP_PAD;

      // PARENT FIRST — React Flow requires a parent to appear before its
      // children in the nodes array or the containment is not processed.
      const parent = buildNode(name, x, 0, { withSummary: true });
      reactFlowNodes.push({
        ...parent,
        type: "fanout",
        data: {
          ...parent.data,
          // The summary would compete with the children for the header; the
          // count is what the header has room to say.
          summary: undefined,
          summaryNoOp: undefined,
          subtitle: isFanout
            ? `${stackItems.length} branches`
            : `${rows.length} iteration${rows.length === 1 ? "" : "s"}`,
        },
        style: { width: groupWidth, height: groupHeight },
      });
      linkTo(name, prevId);
      prevId = name;

      let childPrev: string | undefined;
      stackItems.forEach((item, idx) => {
        // Positions are RELATIVE to the container once `parentId` is set.
        const y = GROUP_HEADER + idx * (NODE_ROW_HEIGHT + BRANCH_GAP);
        const childId = item.kind === "phase" ? item.name : `approval:${item.a.id}`;
        const node =
          item.kind === "phase"
            ? buildNode(item.name, GROUP_PAD, y, { gate: gateFor.get(item.name) })
            : buildApprovalNode(item.a, GROUP_PAD, y);
        reactFlowNodes.push({ ...node, parentId: name, extent: "parent", draggable: false });

        // A LOOP chains child→child, because iteration 2 really did wait for
        // iteration 1 — that edge is the only thing on this canvas that says
        // these ran in sequence. A FAN-OUT draws none: a line between
        // concurrent branches asserts an order the run does not have, and the
        // box already says they belong together.
        if (!isFanout && childPrev) {
          reactFlowEdges.push({
            id: `${childPrev}->${childId}`,
            source: childPrev,
            target: childId,
            sourceHandle: "bottom",
            targetHandle: "top",
            style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
            animated: false,
            // React Flow renders edges in a layer BENEATH nodes, so an edge
            // between two children of a container is drawn behind the
            // container's own background and is simply invisible. Lift it.
            zIndex: 10,
          });
        }
        childPrev = childId;
      });

      if (groupHeight > maxGroupHeight) maxGroupHeight = groupHeight;
    });

    const canvasHeight = Math.max(maxGroupHeight, NODE_ROW_HEIGHT + ROW_GAP) + 20;

    return { nodes: reactFlowNodes, edges: reactFlowEdges, canvasHeight };
  }, [definition, run, executions, approvals, selectedPhase]);

  // ── Live React Flow state ──────────────────────────────────────────────
  // Hold the graph in xyflow's own state and reconcile `computed` into it each
  // poll, rather than feeding <ReactFlow> a brand-new node/edge array every few
  // seconds. Reusing node identities (and their measured dimensions) cuts the
  // per-poll churn that widened the fitView-vs-store-update race window.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PhaseNodeData>>(computed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(computed.edges);
  useEffect(() => {
    setNodes((prev) => reconcileNodes(prev, computed.nodes));
  }, [computed.nodes, setNodes]);
  useEffect(() => {
    setEdges((prev) => reconcileEdges(prev, computed.edges));
  }, [computed.edges, setEdges]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<Node<PhaseNodeData>, Edge> | null>(null);
  const mountedRef = useRef(true);

  // Fit the viewport, but never leave it collapsed. xyflow throws
  // `Cannot read properties of undefined (reading 'payload')` when fitView
  // races a node-list / store update mid-poll; the old code swallowed that
  // throw and the canvas stayed blank until a resize that never came. Retry
  // once on the next frame so a transient race self-heals instead of blanking.
  const safeFitView = useCallback((retry = true) => {
    if (!mountedRef.current) return;
    const flow = flowRef.current;
    if (!flow) return;
    try {
      if (flow.getNodes().length === 0) return;
      flow.fitView({ padding: 0.2, minZoom: 0.4, maxZoom: 1 });
    } catch {
      if (retry) requestAnimationFrame(() => safeFitView(false));
    }
  }, []);

  // Re-center on resize. The pipeline section is wrapped in a draggable
  // divider; without this the nodes drift off-screen as the section shrinks.
  //
  // Hooks must be declared before any conditional return — keep these above
  // the `!definition` short-circuit to satisfy the rules of hooks.
  useEffect(() => {
    mountedRef.current = true;
    const el = wrapperRef.current;
    if (!el) return undefined;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => safeFitView());
    });
    ro.observe(el);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      flowRef.current = null;
    };
  }, [safeFitView]);

  // Re-fit whenever the graph's *topology* changes — a phase or loop iteration
  // appearing / disappearing shifts every downstream node, so the previous fit
  // no longer frames the graph. Keyed on the node id set (not their data), so a
  // plain status / timing tick doesn't jerk the viewport. Double-rAF so xyflow
  // has measured the new nodes before we fit to them.
  const topoKey = useMemo(() => computed.nodes.map((n) => n.id).join("|"), [computed.nodes]);
  useEffect(() => {
    if (!topoKey) return undefined;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => safeFitView());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [topoKey, safeFitView]);

  if (!definition) {
    return (
      <div className="p-4 text-sm text-base-content/50">Loading workflow definition…</div>
    );
  }

  // Grow the canvas when loop iterations stack vertically. The default
  // `height` prop is the minimum (used by simple linear runs); when there
  // are children, expand to fit them.
  const numericHeight = typeof height === "number" ? height : 180;
  const effectiveHeight = Math.max(numericHeight, computed.canvasHeight);

  return (
    <div ref={wrapperRef} style={{ width: "100%", height: effectiveHeight }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        // Cap auto-fit zoom so single-node workflows (e.g. triage) don't
        // expand to fill the whole canvas. 1.0 keeps nodes at their declared
        // pixel size; min keeps very long pipelines readable.
        fitViewOptions={{ padding: 0.2, minZoom: 0.4, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // Allow pan + scroll-zoom so long pipelines and tall iteration stacks
        // are navigable when fitView can't squeeze them into the viewport.
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        onNodeClick={(_, node) => onPhaseClick?.(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={0.5} color="var(--color-base-300, #ccc)" />
      </ReactFlow>
    </div>
  );
}
