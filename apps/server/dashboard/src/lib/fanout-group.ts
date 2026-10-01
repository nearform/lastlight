/**
 * Derived phase names, and the compact fan-out block's chip model.
 *
 * Pure — no React, no DOM — so the pipeline's grouping rules are unit-tested
 * (`tests/fanoutGroup.test.ts`) instead of living untested inside
 * `WorkflowPipeline`'s layout `useMemo`.
 */
import type { WorkflowRun, WorkflowRunExecution } from "../api";
import type { PhaseStatus } from "../components/pipeline-node";

/**
 * Map a dynamic phase name (e.g. "reviewer_fix_1", "reviewer_recheck_1") back
 * to the declared phase it iterates on. The runner names loop iterations like
 * `${parent}_recheck_${n}` (re-reviews) or `${parent}_fix_${n}` (fix
 * iterations), so the parent is the longest declared name `d` such that the
 * dynamic name is `${d}` or starts with `${d}_`.
 */
export function findParentDeclared(name: string, declared: string[]): string | null {
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
export type DerivedRef =
  | { kind: "branch"; base: string; branch: string; suffix?: "retry" | "check" | "regate" }
  | { kind: "iter"; base: string; index: number; suffix?: "retry" | "check" }
  | { kind: "fix" | "recheck"; base: string; index: number };

export function parseDerived(name: string): DerivedRef | null {
  let m = name.match(/^(.*)_branch_([A-Za-z0-9-]+)_(retry|check|regate)$/);
  if (m) return { kind: "branch", base: m[1]!, branch: m[2]!, suffix: m[3] as "retry" | "check" | "regate" };
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
export function derivedLabel(ref: DerivedRef): string {
  const suffix =
    "suffix" in ref && ref.suffix
      ? ref.suffix === "check"
        ? " · gate"
        : ref.suffix === "regate"
          ? " · re-run"
          : " · retry"
      : "";
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
export function gateOwnerOf(name: string): string | null {
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
export function foldGateStatus(ownStatus: PhaseStatus, gate: WorkflowRunExecution | undefined): PhaseStatus {
  if (!gate || ownStatus !== "done") return ownStatus;
  if (gate.success === true && gate.stopReason === "condition_not_met") return "unmet";
  if (gate.success === false && gate.stopReason !== "skipped") return "failed";
  return ownStatus;
}

/**
 * A fan-out wider than this draws as ONE compact block (a chip per branch)
 * instead of a row of full cards. Four cards still read as a group; sixteen —
 * pr-review's `site-review` when paired — ran off the canvas, and most of them
 * were "done in 0s" empties.
 */
export const COMPACT_FANOUT_MIN = 5;

/** What the server records in `scratch.fanout[<phase>]` for a `branches_from:` fan-out. */
export interface FanoutPlan {
  dynamic?: boolean;
  planned: { name: string; model?: string | null }[];
  truncated?: number;
}

/** The plan a dynamic fan-out recorded before its branches started, if any. */
export function fanoutPlanOf(run: Pick<WorkflowRun, "scratch">, phase: string): FanoutPlan | null {
  const plan = (run.scratch?.fanout as Record<string, unknown> | undefined)?.[phase] as FanoutPlan | undefined;
  if (!plan || !Array.isArray(plan.planned)) return null;
  const planned = plan.planned.filter((p) => p && typeof p.name === "string");
  return { ...plan, planned };
}

export interface FanoutChip {
  /** The branch's ledger name (`<phase>_branch_<name>`) — the click target. */
  id: string;
  /** The branch name with the siblings' shared prefix trimmed (`001`, `001-b`). */
  label: string;
  status: PhaseStatus;
  duration?: number;
  model?: string | null;
  selected?: boolean;
}

export type FanoutCounts = Record<"done" | "active" | "failed" | "pending" | "skipped" | "unmet", number>;

/**
 * Trim the prefix every name shares, up to its last `-`, so a chip says `001`
 * rather than `site-001`. Only a whole `-`-delimited prefix is dropped (never
 * part of a word), and a name the trim would empty keeps its full form.
 */
export function shortChipLabels(names: readonly string[]): string[] {
  if (names.length < 2) return [...names];
  let prefix = names[0]!;
  for (const n of names) {
    while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  const cut = prefix.lastIndexOf("-") + 1;
  return names.map((n) => (cut > 0 && n.length > cut ? n.slice(cut) : n));
}

/**
 * The compact block's chips and count strip.
 *
 * `branches` are the ledger rows that are real work (gates already folded into
 * their status by the caller); `plan` adds a `pending` chip for every planned
 * branch with no row yet, so a live run shows the whole fan-out from the
 * moment it starts. Order is the plan's (the manifest order — primaries, then
 * their pairs), then any unplanned row by name.
 */
export function summarizeFanout(
  base: string,
  branches: readonly { id: string; status: PhaseStatus; duration?: number }[],
  plan: FanoutPlan | null,
  selectedId?: string | null,
): { chips: FanoutChip[]; counts: FanoutCounts } {
  const byId = new Map(branches.map((b) => [b.id, b] as const));
  const plannedIds: string[] = (plan?.planned ?? []).map((p) => `${base}_branch_${p.name}`);
  const modelById = new Map<string, string | null | undefined>((plan?.planned ?? []).map((p) => [`${base}_branch_${p.name}`, p.model]));
  const extra = branches.map((b) => b.id).filter((id) => !plannedIds.includes(id)).sort((a, b) => a.localeCompare(b));
  const ids = [...plannedIds, ...extra];
  const names = ids.map((id) => {
    const ref = parseDerived(id);
    return ref?.kind === "branch" ? ref.branch : id;
  });
  const labels = shortChipLabels(names);
  const counts: FanoutCounts = { done: 0, active: 0, failed: 0, pending: 0, skipped: 0, unmet: 0 };
  const chips = ids.map((id, i): FanoutChip => {
    const row = byId.get(id);
    const status = row?.status ?? "pending";
    counts[status === "paused" ? "active" : status] += 1;
    return {
      id,
      label: labels[i]!,
      status,
      ...(row?.duration !== undefined ? { duration: row.duration } : {}),
      ...(modelById.get(id) ? { model: modelById.get(id) } : {}),
      ...(selectedId === id ? { selected: true } : {}),
    };
  });
  return { chips, counts };
}

/** A cheap equality key for the chips, so the pipeline's reconcile notices a change. */
export function chipsKey(chips: readonly FanoutChip[] | undefined): string {
  return (chips ?? []).map((c) => `${c.id}:${c.status}:${c.duration ?? ""}:${c.selected ? 1 : 0}`).join("|");
}
