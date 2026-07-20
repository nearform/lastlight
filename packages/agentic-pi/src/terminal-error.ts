// Surfacing a swallowed provider error onto the synthesized terminal agent_end.
//
// Pi emits an `agent_end` for every internal attempt; a retryable provider
// failure (e.g. an OpenAI 429) rides an intermediate `agent_end` with
// `willRetry: true` carrying an assistant message whose `stopReason` is
// "error"/"aborted" and whose `errorMessage` holds the provider text. If the
// run is then aborted mid retry-backoff, Pi never emits a terminal
// (`willRetry: false`) `agent_end`, so the runner synthesizes an empty one — and
// the observed provider error is lost, surfacing downstream as "empty
// completion — no usable output" instead of the real cause.
//
// These pure helpers let the runner remember that error and, when it has to
// synthesize the terminal backstop, make it the terminal assistant message so
// consumers (lastlight's `extractAgentError`) classify the run by its actual
// cause. Kept pure + separate so the behaviour is unit-testable without a live
// Pi session.

type MessageLike = { role?: string; stopReason?: string };

/**
 * The errored assistant message at the tail of a message list, or undefined.
 * Mirrors the downstream tail scan: skip trailing tool/user messages, then look
 * at the most recent assistant turn only — an earlier failure that was retried
 * to a clean answer must not be resurfaced as a failure.
 */
export function tailAssistantError<T>(messages: readonly T[]): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as MessageLike | undefined;
    if (m?.role !== "assistant") continue;
    return m.stopReason === "error" || m.stopReason === "aborted" ? messages[i] : undefined;
  }
  return undefined;
}

/**
 * The message list to emit on the synthesized terminal `agent_end`. When the
 * run degenerated without a clean terminal answer but a provider error was
 * captured earlier, append it so it becomes the terminal assistant message.
 * A no-op when there's no captured error, or when the tail is already that
 * error (so a genuine terminal error isn't duplicated).
 */
export function surfaceTerminalError<T>(
  sessionMessages: readonly T[],
  capturedError: T | undefined,
): T[] {
  const messages = [...sessionMessages];
  if (capturedError !== undefined && tailAssistantError(messages) === undefined) {
    messages.push(capturedError);
  }
  return messages;
}
