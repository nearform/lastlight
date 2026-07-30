import { ApiException } from "@kubernetes/client-node";

/**
 * Thrown by the pod-create path when the namespace `ResourceQuota` rejects the
 * Pod (`403 ... exceeded quota ...`). Distinct from every other create failure
 * so the orchestrator can stamp a `stopReason: "error_quota"` and the workflow
 * layer can treat it as BACKPRESSURE (requeue + retry) instead of a hard fail.
 * The cluster's quota is the concurrency authority (see the Concurrency section
 * of `spec/09-sandbox.md`).
 */
export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * True iff `err` is a k8s `403` produced by the ResourceQuota admission plugin.
 * That plugin emits two phrasings, both of which are the quota rejecting the
 * create and both of which we treat as backpressure:
 *  - over the limit — `... is forbidden: exceeded quota: <name>, requested: ...`
 *  - missing a metered field — `... is forbidden: failed quota: <name>: must
 *    specify requests.cpu, ...` (fires when a compute quota exists but the pod
 *    declares no request/limit for a tracked resource). Sandbox pods now set
 *    resource requests (`pod.ts`), so this form shouldn't originate from us —
 *    matching it is defence-in-depth so such a rejection re-queues (bounded by
 *    the queue TTL) rather than hard-failing the run.
 */
export function isQuotaExceeded(err: unknown): boolean {
  if (!(err instanceof ApiException) || err.code !== 403) return false;
  const body = err.body as { message?: string } | undefined;
  const text = `${body?.message ?? ""} ${err.message ?? ""}`;
  return /(?:exceeded|failed) quota/i.test(text);
}

/** Generic fallback used by {@link quotaMessage} when the rejecting error
 *  carries no body message to surface (e.g. a malformed/empty Status body). */
const GENERIC_QUOTA_MESSAGE = "pod create rejected by ResourceQuota";

/** Extracts the human-readable rejection reason off a quota-rejecting error —
 *  the k8s Status body's `message` field, which is where the ResourceQuota
 *  admission plugin puts the useful detail (`isQuotaExceeded`'s docstring
 *  covers the two phrasings). Callers are expected to have already confirmed
 *  `isQuotaExceeded(err)`; this is the ONLY place that casts `.body.message`
 *  off the error, so a `QuotaExceededError` is always built from this. Falls
 *  back to a generic message when the body has none (or `err` isn't the
 *  `ApiException` shape at all). */
export function quotaMessage(err: unknown): string {
  if (!(err instanceof ApiException)) return GENERIC_QUOTA_MESSAGE;
  const body = err.body as { message?: string } | undefined;
  return body?.message ?? GENERIC_QUOTA_MESSAGE;
}
