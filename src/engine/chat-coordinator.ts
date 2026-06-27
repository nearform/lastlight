/**
 * Per-session chat batching.
 *
 * A human in a Slack thread often fires several messages in quick succession
 * (and the webhook transport can deliver them near-simultaneously). Without
 * coordination each one becomes its own turn + its own reply, so the agent
 * answers "A", then "B", then "C" separately instead of taking in the whole
 * thought.
 *
 * This coordinator gives the Claude-Code-style behaviour the user expects:
 * the first message starts a turn immediately; any messages that arrive while
 * that turn is in flight are queued and, once it finishes, drained together as
 * a SINGLE combined follow-up turn (one model call, one reply). Neither chat
 * runtime supports injecting context into a running agent (pi-ai is a
 * stateless completion client; its only mid-flight primitive is AbortSignal),
 * so "finish then run the queue" is the only non-wasteful option — and the one
 * chosen here. See spec / the melodic-mixing-hippo plan for the rationale.
 *
 * Serialization is per messagingSessionId: different threads run in parallel,
 * the same thread strictly in order. One drained batch == one `runTurn` call
 * == one executions row == one reply.
 */

/** One queued, not-yet-processed user message. */
interface PendingMessage {
  message: string;
  sender: string;
  reply: (msg: string) => Promise<void>;
  /**
   * Source-platform send timestamp (e.g. Slack `ts`, epoch seconds). Used to
   * sort a batch back into send order — webhook delivery can reorder rapid
   * messages. Undefined for sources that don't carry one (sorted last, stably).
   */
  ts?: number;
}

interface SessionState {
  queue: PendingMessage[];
  draining: boolean;
}

export interface ChatCoordinatorDeps {
  /**
   * Run one chat turn to completion: record the execution, call the model,
   * and post `reply`. Injected (rather than wiring the dispatcher/db in here)
   * so the coordinator only owns the queueing policy and stays trivially
   * testable. The combined batch text is passed as `message`.
   */
  runTurn: (
    sessionId: string,
    message: string,
    sender: string,
    reply: (msg: string) => Promise<void>,
  ) => Promise<void>;
}

export interface ChatSubmitInput {
  sessionId: string;
  message: string;
  sender: string;
  reply: (msg: string) => Promise<void>;
  /** Source send timestamp (epoch seconds) for in-batch ordering, if known. */
  ts?: number;
}

export class ChatCoordinator {
  private deps: ChatCoordinatorDeps;
  private sessions = new Map<string, SessionState>();

  constructor(deps: ChatCoordinatorDeps) {
    this.deps = deps;
  }

  /**
   * Enqueue a message for its session. If no turn is in flight, the drain
   * loop starts immediately; otherwise the message rides along in the next
   * batch. Fire-and-forget — the transport has already acked the delivery.
   */
  submit(input: ChatSubmitInput): void {
    let state = this.sessions.get(input.sessionId);
    if (!state) {
      state = { queue: [], draining: false };
      this.sessions.set(input.sessionId, state);
    }
    state.queue.push({ message: input.message, sender: input.sender, reply: input.reply, ts: input.ts });
    if (!state.draining) {
      state.draining = true;
      void this.drain(input.sessionId, state);
    }
  }

  /** Number of sessions currently draining (for tests / introspection). */
  get activeSessions(): number {
    return this.sessions.size;
  }

  private async drain(sessionId: string, state: SessionState): Promise<void> {
    try {
      // Re-check after every turn: messages that arrive during the awaited
      // `runTurn` accumulate in `queue` and are picked up by the next
      // iteration as one combined batch. JS is single-threaded, so there is
      // no `await` between the empty-queue check and clearing `draining` —
      // a submit cannot interleave there and strand a message.
      while (state.queue.length > 0) {
        const batch = state.queue.splice(0, state.queue.length);
        // Sort back into send order — webhook delivery can reorder a rapid
        // burst, so arrival order isn't reliable. Stable: messages without a
        // timestamp keep their arrival position (sorted last).
        batch.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
        const combined = batch.map((b) => b.message).join("\n");
        // Reply via the most recent message so the response threads under the
        // latest thing the user typed.
        const last = batch[batch.length - 1];
        try {
          await this.deps.runTurn(sessionId, combined, last.sender, last.reply);
        } catch (err) {
          // runTurn owns its own error reply; this is a defensive backstop so
          // a throw can never wedge the drain loop or leave `draining` stuck.
          console.error(`[chat-coordinator] turn failed for ${sessionId}:`, err);
        }
      }
    } finally {
      state.draining = false;
      this.sessions.delete(sessionId);
    }
  }
}
