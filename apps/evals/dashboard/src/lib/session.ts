import { useQueries, useQuery } from "@tanstack/react-query";

import { toBaseMessages } from "../adapters/lastlightToTimeline";
import { unwrapLine } from "../adapters/streamJson";
import { processMessages } from "../timeline";
import type { TimelineItem as TimelineItemT } from "../timeline";
import type { Message } from "../timeline/message";

/** One agent session inside a log file, identified by its `sessionId`.
 *
 * A log used to hold exactly one of these. Since the `fanout` phase type landed,
 * a single phase can run several agent sessions AT THE SAME TIME — the six
 * `pr-review` survey families are one phase and six sessions — so both the
 * consolidated `full.jsonl` and that phase's own split hold many, written in
 * whatever order each session's shim happened to flush. Rendered as one stream
 * they read as unrelated paragraphs with the clock jumping backwards at every
 * boundary, which is what makes the consolidated log unfollowable. */
export interface SessionLane {
  /** `""` for lines the shim wrote without one (bash phases, harness notices). */
  sessionId: string;
  /** Display name — a harness-recorded branch name when one can be confirmed,
   * else a positional fallback. See {@link deriveLaneLabel}. */
  label: string;
  /** True when {@link label} is a real name read off the session's own opening
   * prompt, false when it is a positional placeholder. Drives the "named vs
   * guessing" affordance — a reader should be able to tell them apart. */
  named: boolean;
  /** `command` for a deterministic `bash`/`script` run the shim mirrored into a
   * session (its opening "prompt" is the shell command, prefixed `$ ` by
   * `event-shim.ts`), `agent` for a model conversation. Worth distinguishing
   * because a fan-out's split also catches the `until_bash` gate and any bash
   * phase that landed in the same window — four lines of shell sitting in a list
   * of six survey agents, which reads as a mystery until it is labelled. */
  kind: "agent" | "command";
  /** For a `command` lane, the first real line of the command — the tooltip. */
  command?: string;
  /** The harness's own ledger label for this branch (`survey_branch_contract`),
   * when the case's recorded `phases[]` confirms the mined name. Absent while a
   * run is still in flight, since the scorecard has no `phases[]` until the case
   * finishes. */
  full?: string;
  items: TimelineItemT[];
  messageCount: number;
  /** Model turns: one per `type: "assistant"` line the shim wrote, which is what
   * agentic-pi means by a turn (`"turns": 25` in the executor's Result log).
   * Counted on the RAW lines, before `unwrapLine` fans one assistant message out
   * into text + tool-call messages — so this is turns, not messages. */
  turns: number;
  firstTs?: string;
  lastTs?: string;
  /** Epoch ms of the first/last line, for ordering and duration. `undefined`
   * when a lane carried no parseable timestamp. */
  firstMs?: number;
  lastMs?: number;
}

export interface SessionLog {
  /** Every lane merged back into one clock-ordered stream — the whole-file view. */
  items: TimelineItemT[];
  lanes: SessionLane[];
  messageCount: number;
}

/** The fan-out branch names the harness itself recorded for a case, reduced to
 * the bare family. `scorecard.json` → `results[].phases[].phase` carries the real
 * ledger labels (`survey_branch_contract`, `adjudicate_iter_2`, …) because the
 * fan-out handler returns one `PhaseResult` per branch; this pulls the `<family>`
 * out of the `<phase>_branch_<family>` form and keeps the full label beside it. */
export function branchVocabulary(phases: { phase: string }[] | undefined): Map<string, string> {
  const vocab = new Map<string, string>();
  for (const p of phases ?? []) {
    const m = /^(.+)_branch_(.+?)(?:_retry|_check)?$/.exec(p.phase);
    if (m) vocab.set(m[2], p.phase);
  }
  return vocab;
}

/** Name a lane, preferring something the HARNESS recorded over something mined.
 *
 * The honest position first: nothing in the stream ties a `sessionId` to a phase
 * or branch. `sessionId` is a bare uuid, the `system` lines carry only extension
 * status, and the harness cannot help either — a fan-out reports ONE phase window
 * (`fanout.ts` calls `reporter.onStart(phase.name)` once) inside which six
 * sessions start milliseconds apart, so `bucketSessionsByPhase`'s
 * last-phase-started-before-this rule assigns all six to `survey` and stops.
 * Closing that properly means writing the phase label into the session jsonl,
 * which is a core change and is reported rather than attempted here.
 *
 * So the family is read out of the opening prompt, and `vocab` CONFIRMS it —
 * two different jobs, deliberately not collapsed into one. The marker is
 * purpose-built and unambiguous (`## Your family: \`contract\``), which is why it
 * can stand alone; the heuristic it replaced was a loose "first markdown heading"
 * match that labelled a lane `process that DIES.` from a shell comment inside a
 * prompt. Requiring the vocabulary outright would have been the safer-looking
 * rule and the wrong one: a live run's scorecard has no `phases[]` until the case
 * finishes, so every lane would sit unnamed for exactly the half-hour someone is
 * watching it. A confirmed name additionally carries the harness's own ledger
 * label, which is what `full` reports in its tooltip. */
/** The text of a lane's opening user message.
 *
 * `toBaseMessages` normalises a user turn to `content: { text }` — an OBJECT, not
 * the raw string the jsonl carried. Reading `content` as a string therefore
 * yields `""` for every lane, which is what silently defeated the family marker:
 * all six markers were present in the file and the pattern was correct, but it
 * was being matched against nothing. Accepts both shapes so a future adapter
 * change cannot reintroduce the same silence. */
function firstUserText(items: TimelineItemT[]): string {
  const first = items.find((it) => it.kind === "single" && it.message.type === "user");
  if (!first || first.kind !== "single") return "";
  const content = first.message.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function deriveLaneLabel(
  items: TimelineItemT[],
  index: number,
  vocab: Map<string, string>,
): { label: string; named: boolean; full?: string; kind: "agent" | "command"; command?: string } {
  const text = firstUserText(items);
  // A command run, not a conversation. The `$ ` prefix is written by the shim
  // for every `bash`/`script` phase, so this identifies rather than guesses.
  if (text.startsWith("$ ")) {
    const command = text
      .slice(2)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    return { label: "command", named: true, kind: "command", command };
  }
  const mined = text.match(/^##\s*Your family:\s*`([^`]+)`/m)?.[1];
  if (mined) return { label: mined, named: true, full: vocab.get(mined), kind: "agent" };
  return { label: `session ${index + 1}`, named: false, kind: "agent" };
}

function tsOf(item: TimelineItemT): string {
  return item.timestamp ?? "";
}

function msOf(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : undefined;
}

/** A lane's time span, as min/max over its items — NOT first/last.
 *
 * Within one agent session those are the same thing, but the `""` lane is not one
 * session: it collects every line the shim wrote without a session id, from every
 * phase, and `full.jsonl` is assembled by concatenating per-session files rather
 * than by merging them on the clock. So its lines arrive out of order, and
 * last-minus-first on the real data produced a duration of **−242,243ms**. */
function spanOf(items: TimelineItemT[]): {
  firstTs?: string;
  lastTs?: string;
  firstMs?: number;
  lastMs?: number;
} {
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  for (const it of items) {
    const ms = msOf(it.timestamp);
    if (ms === undefined) continue;
    if (firstMs === undefined || ms < firstMs) {
      firstMs = ms;
      firstTs = it.timestamp;
    }
    if (lastMs === undefined || ms > lastMs) {
      lastMs = ms;
      lastTs = it.timestamp;
    }
  }
  return { firstTs, lastTs, firstMs, lastMs };
}

/**
 * Load an archived agent session jsonl (written per case under a run's
 * `sessions/` dir) and turn it into a timeline the renderer can draw. Unlike the
 * Last Light dashboard's live `EventSource` stream, this is a one-shot fetch of a
 * static file served by the harness's `/data/*` route — so we parse the whole
 * file once. The raw lines are the agentic *stream-json* shape, so each is first
 * flattened via {@link unwrapLine} (which also drops the `result` metrics
 * envelope and system noise), then fed through the same adapter + processor. A
 * live file's trailing line may be half-written, so a parse failure is skipped.
 *
 * Lines are bucketed by `sessionId` BEFORE unwrapping, and each lane is
 * processed on its own. That ordering is the point: `processMessages` pairs a
 * tool call with the next matching result *after* it in the array, so feeding it
 * several concurrent sessions at once asks it to pair across agents. It happens
 * to survive that today only because `tool_use_id` is globally unique — a
 * property of the id generator, not of this code. Per-lane processing means the
 * renderer no longer depends on it.
 */
async function fetchSessionItems(url: string, vocab: Map<string, string>): Promise<SessionLog> {
  const res = await fetch(url, { headers: { accept: "application/x-ndjson, text/plain" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const text = await res.text();

  // sessionId → raw lines, insertion-ordered so lanes come out in the order
  // their first line appears (for a fan-out, that is branch declaration order).
  const bySession = new Map<string, Record<string, unknown>[]>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // a malformed / half-written trailing line
    }
    const sid = typeof raw.sessionId === "string" ? raw.sessionId : "";
    const bucket = bySession.get(sid);
    if (bucket) bucket.push(raw);
    else bySession.set(sid, [raw]);
  }

  let id = 0;
  let messageCount = 0;
  const lanes: SessionLane[] = [];
  for (const [sessionId, raws] of bySession) {
    const messages: Message[] = [];
    for (const raw of raws) {
      for (const m of unwrapLine(raw)) {
        m.id = id++; // stable, unique ACROSS lanes — the merged view reuses these
        messages.push(m);
      }
    }
    if (messages.length === 0) continue; // e.g. a lane of pure `result` envelopes
    messageCount += messages.length;
    // Counted on the RAW lines, not the unwrapped ones: `unwrapLine` fans a
    // single assistant message out into its text plus one message per tool call,
    // so counting after it would report tool calls as turns.
    const turns = raws.filter(
      (r) => r.type === "assistant" && !r.isApiErrorMessage && !r.error,
    ).length;
    const items = processMessages(toBaseMessages(messages));
    const { label, named, full, kind, command } = deriveLaneLabel(items, lanes.length, vocab);
    lanes.push({
      sessionId,
      label,
      named,
      full,
      kind,
      command,
      items,
      messageCount: messages.length,
      turns,
      ...spanOf(items),
    });
  }

  // Start-time order. The merged stream interleaves in CHUNKS — each session's
  // shim flushes a block at a time — so file position says nothing about which
  // session began first; only each lane's own first line does. Lanes without a
  // parseable timestamp keep their insertion order at the end.
  lanes.sort((a, b) => {
    if (a.firstMs === undefined) return b.firstMs === undefined ? 0 : 1;
    if (b.firstMs === undefined) return -1;
    return a.firstMs - b.firstMs;
  });

  // The whole-file view is the lanes merged back by clock, NOT a second parse —
  // so an item carries the same identity in both views and the two can never
  // disagree about what happened.
  const items = lanes
    .flatMap((l) => l.items)
    .sort((a, b) => (tsOf(a) < tsOf(b) ? -1 : tsOf(a) > tsOf(b) ? 1 : 0));

  return { items, lanes, messageCount };
}

/** TanStack-Query hook for one session jsonl. A finished log never changes, so
 * it's cached indefinitely; a `live` log (a still-running case) is re-fetched on
 * a short interval so the modal can be followed along as the agent works. */
export function useSessionLog(
  url: string | undefined,
  live = false,
  vocab: Map<string, string> = new Map(),
) {
  const vocabKey = vocabKeyOf(vocab);
  return useQuery({
    queryKey: ["session-log", url, live, vocabKey],
    queryFn: () => fetchSessionItems(url as string, vocab),
    enabled: !!url,
    staleTime: live ? 0 : Infinity,
    refetchInterval: live ? 1500 : false,
    placeholderData: (prev) => prev,
  });
}

/** The vocabulary only ever ADDS names to lanes, so it is keyed by its content
 * rather than its identity — a caller that rebuilds the Map each render must not
 * invalidate a cached parse of a finished log. */
function vocabKeyOf(vocab: Map<string, string>): string {
  return [...vocab.keys()].sort().join(",");
}

/** Every phase's transcript at once, so the panel can show each phase's sessions
 * — their names, durations and turn counts — without the reader having to open
 * each phase to discover what is inside it.
 *
 * Deliberately parallel and progressive rather than awaited as a batch: each
 * query resolves independently, so the panel renders immediately from the ledger
 * and fills in its nested lanes as the files land. A finished log never changes,
 * so these are cached indefinitely and the cost is paid once per case.
 *
 * The query key matches {@link useSessionLog}'s exactly, so the two share one
 * cache entry per file and selecting a phase never re-fetches what this already
 * loaded. */
export function usePhaseLogs(urls: (string | undefined)[], vocab: Map<string, string> = new Map()) {
  const vocabKey = vocabKeyOf(vocab);
  return useQueries({
    queries: urls.map((url) => ({
      queryKey: ["session-log", url, false, vocabKey],
      queryFn: () => fetchSessionItems(url as string, vocab),
      enabled: !!url,
      staleTime: Infinity,
    })),
  });
}
