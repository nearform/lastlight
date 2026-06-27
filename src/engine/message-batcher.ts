import type { EventEnvelope } from "../connectors/types.js";

/**
 * Per-session message batcher that sits *before* routing/classification.
 *
 * A human in a Slack thread fires several messages in quick succession, and
 * the HTTP Events API can deliver them out of order. If each message were
 * routed and run independently, the LLM classifier (~700ms, run concurrently
 * per message) would reorder them and the agent would answer each fragment
 * separately.
 *
 * This batcher coalesces a burst at the connector→dispatch boundary: the first
 * message for an idle session opens a short settle window; every message that
 * lands in that window (or while a turn is already in flight) is collected,
 * sorted back into send order by source timestamp, combined into one envelope,
 * and dispatched **once** — so the burst is classified once and answered as a
 * single ordered turn. Per session it serializes; different sessions run in
 * parallel.
 *
 * It deliberately knows nothing about chat specifically — it batches any
 * same-session `message` envelopes and hands the combined one to the normal
 * dispatch pipeline, which then classifies + handles it.
 */

const DEFAULT_DEBOUNCE_MS = 700;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface MessageBatcherDeps {
  /** Dispatch one (possibly combined) envelope through the normal pipeline. */
  dispatch: (envelope: EventEnvelope) => Promise<void>;
  /**
   * Settle window (ms) to collect an initial burst before the first turn of an
   * idle session. 0 disables it (first message runs immediately, later ones
   * still batch after it). Default 700ms.
   */
  debounceMs?: number;
  /** Injectable delay for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-session key for an envelope. Default: `raw.sessionId`. */
  keyOf?: (envelope: EventEnvelope) => string | undefined;
}

interface Pending {
  envelope: EventEnvelope;
  ts?: number;
}

interface SessionState {
  queue: Pending[];
  draining: boolean;
}

export class MessageBatcher {
  private deps: MessageBatcherDeps;
  private debounceMs: number;
  private sleep: (ms: number) => Promise<void>;
  private keyOf: (envelope: EventEnvelope) => string | undefined;
  private sessions = new Map<string, SessionState>();

  constructor(deps: MessageBatcherDeps) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.sleep = deps.sleep ?? realSleep;
    this.keyOf = deps.keyOf ?? ((e) => sessionIdOf(e));
  }

  /**
   * Enqueue an envelope for its session. Pass-through (dispatched immediately,
   * unbatched) if it has no session key. Fire-and-forget — the transport has
   * already acked delivery.
   */
  submit(envelope: EventEnvelope): void {
    const key = this.keyOf(envelope);
    if (!key) {
      void this.deps.dispatch(envelope);
      return;
    }
    let state = this.sessions.get(key);
    if (!state) {
      state = { queue: [], draining: false };
      this.sessions.set(key, state);
    }
    state.queue.push({ envelope, ts: parseTs(envelope) });
    if (!state.draining) {
      state.draining = true;
      void this.drain(key, state);
    }
  }

  /** Number of sessions currently batching (for tests / introspection). */
  get activeSessions(): number {
    return this.sessions.size;
  }

  private async drain(key: string, state: SessionState): Promise<void> {
    try {
      // Settle window: let a rapid burst land before the first turn so the
      // whole burst is sorted + combined into a single classified turn.
      if (this.debounceMs > 0) await this.sleep(this.debounceMs);
      while (state.queue.length > 0) {
        const batch = state.queue.splice(0, state.queue.length);
        // Sort back into send order — delivery can reorder a burst. Stable:
        // entries without a timestamp keep arrival order (sorted last).
        batch.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
        try {
          await this.deps.dispatch(combine(batch));
        } catch (err) {
          console.error(`[message-batcher] dispatch failed for ${key}:`, err);
        }
      }
    } finally {
      state.draining = false;
      this.sessions.delete(key);
    }
  }
}

function sessionIdOf(e: EventEnvelope): string | undefined {
  const raw = e.raw as { sessionId?: unknown } | null | undefined;
  return raw && typeof raw.sessionId === "string" ? raw.sessionId : undefined;
}

function parseTs(e: EventEnvelope): number | undefined {
  const raw = e.raw as { ts?: unknown } | null | undefined;
  const v = raw?.ts;
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Fold a sorted batch into one envelope. A single-message batch passes through
 * unchanged. Otherwise the bodies are newline-joined and the *latest* message's
 * envelope is the base — so the reply threads under the most recent message and
 * its session/ts metadata is carried.
 */
function combine(batch: Pending[]): EventEnvelope {
  const last = batch[batch.length - 1].envelope;
  if (batch.length === 1) return last;
  return { ...last, body: batch.map((b) => b.envelope.body).join("\n") };
}
