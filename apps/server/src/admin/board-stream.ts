/**
 * The board's change SIGNAL — one revision string every dashboard watches.
 *
 * Deliberately NOT the board itself, which is the one real design decision
 * here. `GET /board` resolves its scope PER CALLER: `?repos=`, `?unstaged=`,
 * and per-actor team visibility (issue #169). A stream that pushed the rendered
 * board would therefore have to re-run that whole resolution for every
 * connected client on every tick — and would have to carry repo names in the
 * frame, which is a side channel around the very visibility boundary that
 * resolution exists to hold. The session-list stream can afford its full
 * payload because its work is a directory listing plus `docker ps`; three
 * queries and a possibly-cold GitHub read are not comparable.
 *
 * So the frame says only THAT something changed. Each client then refetches at
 * its own scope, through the same authorized route it already uses, and the
 * expensive work happens only for tabs that are actually open. Keep it that
 * way: the moment this frame grows a repo list it stops being safe to send to
 * everyone.
 *
 * The tick is shared — one signature computation for the whole process,
 * however many tabs are connected.
 */
import type { StateDb } from "../state/db.js";
import { boardRevision } from "./board-cache.js";

/** How often the signature is recomputed. */
export const BOARD_TICK_MS = 3000;

/**
 * A board can sit unchanged for hours, so a SILENT stream is its normal state —
 * and an idle reverse proxy will close one. The heartbeat is what makes this
 * endpoint different from the session stream it is otherwise modelled on, which
 * changes often enough to keep itself alive.
 */
export const BOARD_HEARTBEAT_MS = 25_000;

/**
 * Run-side changes the cache knows nothing about.
 *
 * Bumped from a terminal-run observer at boot. The GitHub half of a card is
 * cached and the run half is read live, so without this a run finishing would
 * be invisible until something else moved.
 */
let runRevision = 0;

/** Note that a run reached a terminal state — see {@link runRevision}. */
export function noteBoardRunChange(): void {
  runRevision++;
}

/** Test-only: reset the run revision. */
export function resetBoardStreamForTests(): void {
  runRevision = 0;
}

/**
 * What the board would show right now, as a comparable string.
 *
 * Three components: the cached GitHub answer's revision, the terminal-run
 * counter, and the live shape of every ACTIVE run — the last because a run
 * moving `queued → running`, or advancing a phase, changes a card without
 * changing either counter.
 *
 * One query per tick for the whole process, on an indexed status filter.
 */
export async function boardSignature(db: StateDb): Promise<string> {
  const active = await db.runs.listActive();
  const live = active
    .map((run) => `${run.id}:${run.status}:${run.currentPhase ?? ""}`)
    .sort()
    .join("|");
  return `${boardRevision()}:${runRevision}:${live}`;
}
