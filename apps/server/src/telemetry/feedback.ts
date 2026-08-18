import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  metrics,
  trace,
  type Context,
} from "@opentelemetry/api";
import { isTelemetryEnabled, safeMetricAttributes, setSpanAttributes, telemetryIncludesContent } from "./index.js";
import { OI, SpanKind } from "./openinference.js";
import type { FeedbackSignal } from "../state/feedback-store.js";
import type { FeedbackAnchor } from "../state/feedback-store.js";
import { logger } from "../logging/logger.js";

const log = logger("otel");

/**
 * Export a human feedback signal to OpenTelemetry (issue #255).
 *
 * The interesting part is WHERE the span goes. A 👍 arrives minutes or days
 * after the run it grades has finished and every one of its spans has closed,
 * so the obvious implementation — start a span now — produces a second,
 * disconnected trace that no backend can relate to the work. Instead we
 * remembered the run's trace and span ids (`workflow_runs.trace_id/span_id`,
 * written by the observability adapter in `src/workflows/runner.ts`) and
 * synthesize a **remote parent context** from them here. The signal is then
 * exported as a late-arriving child of `lastlight.workflow.run`, in the *same
 * trace*, and Phoenix / Langfuse show the score against the run it is about.
 * Trace backends accept late spans on an existing trace — the trace is a join
 * on trace id, not a closed object.
 *
 * Without a recorded trace (telemetry was off during the run, or the anchor was
 * never tied to a run) the span still exports, as its own root. Losing the
 * association is much better than losing the signal.
 *
 * Vocabulary: `openinference.span.kind = EVALUATOR` is what Phoenix reads, and
 * `langfuse.score.*` is Langfuse's. Langfuse does not yet map those attributes
 * to first-class Scores on its OTLP ingest path (langfuse discussion #14652) —
 * today they ride along on a span that lands correctly on the trace, and they
 * become a real Score the day that ships, with no change here.
 */

/** The score name both backends key on. One name keeps the series comparable. */
const SCORE_NAME = "user_feedback";

export interface FeedbackSpanInput {
  signal: FeedbackSignal;
  anchor: Pick<FeedbackAnchor, "kind" | "createdAt">;
  /** Deep link to the reacted-to artefact, when we can build one. */
  anchorUrl?: string;
  /** The run's recorded trace coordinates, when it has any. */
  parent?: { traceId: string; spanId: string };
}

/**
 * Build the remote parent context for a run's trace, or undefined when we have
 * nothing to attach to. `isRemote` is the honest description: this process did
 * not create that span, it is joining a trace it only knows by id.
 */
function parentContext(parent: FeedbackSpanInput["parent"]): Context | undefined {
  if (!parent?.traceId || !parent.spanId) return undefined;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parent.traceId,
    spanId: parent.spanId,
    // SAMPLED, because the parent was: an unsampled flag here would let a
    // sampling processor drop the very signal we went to this trouble to place.
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

/**
 * Emit one signal as a span + metrics. No-op when telemetry is disabled.
 * Never throws — a telemetry failure must not lose a recorded signal.
 */
export function recordFeedbackSignal(input: FeedbackSpanInput): void {
  if (!isTelemetryEnabled()) return;
  const { signal, anchor } = input;
  try {
    const at = Date.parse(signal.reactedAt ?? signal.observedAt);
    const startTime = Number.isFinite(at) ? new Date(at) : new Date();
    const span = trace
      .getTracer("lastlight")
      .startSpan(
        "lastlight.feedback.signal",
        { startTime },
        parentContext(input.parent),
      );

    // Set directly rather than through `safeSpanAttributes`: the scrubber
    // strips keys matching /token|prompt|content/, which would silently drop
    // the OpenInference keys. Everything below is non-sensitive by
    // construction, except `reactor` — gated with the other content values.
    setSpanAttributes(span, {
      [OI.SPAN_KIND]: SpanKind.EVALUATOR,
      "feedback.source": signal.source,
      "feedback.emoji": signal.emoji,
      "feedback.score": signal.score,
      "feedback.sentiment": signal.sentiment,
      "feedback.anchor.kind": anchor.kind,
      ...(input.anchorUrl ? { "feedback.anchor.url": input.anchorUrl } : {}),
      ...(signal.workflowName ? { "workflow.name": signal.workflowName } : {}),
      ...(signal.workflowRunId ? { "workflow.run_id": signal.workflowRunId } : {}),
      ...(signal.repo ? { repo: signal.owner ? `${signal.owner}/${signal.repo}` : signal.repo } : {}),
      ...(signal.issueNumber ? { "github.issue_number": signal.issueNumber } : {}),
      // Langfuse's score vocabulary. Inert on backends that don't read it.
      [`langfuse.score.${SCORE_NAME}`]: signal.score,
      [`langfuse.score.${SCORE_NAME}.data_type`]: "NUMERIC",
      [`langfuse.score.${SCORE_NAME}.comment`]: signal.emoji,
    });

    // The reactor is a person. Same gate as every other content value.
    if (telemetryIncludesContent() && signal.reactor) {
      setSpanAttributes(span, { "feedback.reactor": signal.reactor });
    }

    span.setStatus({ code: SpanStatusCode.OK });
    // Zero-duration: a reaction is an instant, not an interval. Ending at the
    // start time keeps it a point on the trace timeline rather than a bar whose
    // width means nothing.
    span.end(startTime);

    recordFeedbackMetrics(signal, anchor.kind);
  } catch (err: unknown) {
    log.warn("Failed to export a feedback signal", { signalId: signal.id, err });
  }
}

function recordFeedbackMetrics(signal: FeedbackSignal, anchorKind: string): void {
  const attrs = safeMetricAttributes({
    "feedback.source": signal.source,
    "feedback.sentiment": signal.sentiment,
    "feedback.emoji": signal.emoji,
    "feedback.anchor.kind": anchorKind,
    "workflow.name": signal.workflowName ?? undefined,
    repo: signal.repo ?? undefined,
  });
  const m = metrics.getMeter("lastlight");
  m.createCounter("lastlight.feedback.signals").add(1, attrs);
  // A histogram rather than a counter: we want the DISTRIBUTION of opinion.
  // Summing scores would let one 🎉 cancel out one 👎 and report silence.
  m.createHistogram("lastlight.feedback.score").record(signal.score, attrs);
}
