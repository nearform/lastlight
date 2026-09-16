/**
 * The software-factory STAGE vocabulary — the four label names an issue moves
 * through as the harness builds it.
 *
 * ```
 * ready-for-agent ──▶ agent-building ──▶ ready-for-human   (build succeeded)
 *                                   └──▶ agent-blocked     (build failed)
 * ```
 *
 * **The stage label is the source of truth.** There is no second place the
 * pipeline records where an issue has got to: the label on the issue IS the
 * state, which is what makes the pipeline legible to a human scanning the
 * tracker and what makes the backstop sweep's `label:ready-for-agent` query a
 * sound way to find work. The harness advances the labels itself, host-side, at
 * the dispatch choke point (`stage-advance.ts`) — there is no sandbox there and
 * no agent to ask.
 *
 * **These names are OPERATOR-OWNED.** A deployment configures them under
 * `autonomy.stages`, and a deployment that renames them is renaming what the
 * code gates on. What lives here is the PACKAGED DEFAULT set — the names the
 * prompts speak, the names a fresh install gets, and the names every test and
 * doc example uses. Read the configured value wherever one is available; reach
 * for these constants for the default, and never hardcode the string inline.
 *
 * Two of the four already exist in the wild, and two are new:
 *
 * - `ready-for-agent` / `ready-for-human` are part of the **triage** vocabulary
 *   and are already written by the triage agent today — see
 *   `apps/server/skills/issue-triage/SKILL.md` and
 *   `docs/agents/triage-labels.md`. The pipeline CONSUMES `ready-for-agent`
 *   (it is the entry signal) and lands on `ready-for-human` as the success
 *   terminus, which is why it needs no new label to say "a person's turn now":
 *   the triage vocabulary already had the right word.
 * - `agent-building` / `agent-blocked` are **new and agent-owned**. Nobody
 *   hand-edits these. They exist so the in-flight and failed states are visible
 *   on the issue rather than only in the run table, and because "the entry
 *   label is gone and something else is on" is what stops a sweep re-picking
 *   work that is already running.
 */

/** Entry signal: triage says this is fully specified and an agent can take it. */
export const STAGE_READY_FOR_AGENT = "ready-for-agent";

/** In flight: we have dispatched a build for this issue. Agent-owned. */
export const STAGE_AGENT_BUILDING = "agent-building";

/** Success terminus: there is something for a person to look at. */
export const STAGE_READY_FOR_HUMAN = "ready-for-human";

/** Failure terminus: the build did not get there. Agent-owned. */
export const STAGE_AGENT_BLOCKED = "agent-blocked";

/**
 * The packaged defaults as one object, for the config layer to spread over and
 * for callers that want the whole vocabulary rather than one name.
 */
export const DEFAULT_STAGE_LABELS = {
  readyForAgent: STAGE_READY_FOR_AGENT,
  agentBuilding: STAGE_AGENT_BUILDING,
  readyForHuman: STAGE_READY_FOR_HUMAN,
  agentBlocked: STAGE_AGENT_BLOCKED,
} as const;
