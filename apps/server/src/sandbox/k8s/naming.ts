import { createHash } from "node:crypto";
import { Rfc1123Label } from "./resource-name.js";

/** Longest suffix `secretNameFor` (secret.ts) appends to a pod name:
 *  "-prompt" (7 chars). Reserve room for it (+1 margin) so a pod name at the
 *  cap never produces an invalid (>63-char) Secret name. `secretNameFor`'s
 *  `Rfc1123Label.withSuffix` call (F6) is the runtime backstop if this
 *  budget is ever wrong — it throws instead of silently emitting a >63-char
 *  Secret name. */
const SECRET_SUFFIX_BUDGET = 8;

/** RFC-1123 label: lowercase alnum + '-', ≤63 chars, starts/ends alnum.
 *  We slug the taskId and append a short stable hash to guarantee uniqueness
 *  after truncation. Budget also reserves room for the creds/prompt Secret
 *  name suffix (see `SECRET_SUFFIX_BUDGET`), so the derived Secret name stays
 *  a valid RFC-1123 label too. Returns the `Rfc1123Label` itself, not a bare
 *  string: `secretNameFor` (secret.ts) takes exactly this type, so "a Secret
 *  name is only ever derived from a pod name" is a compile-time fact (F6),
 *  not a comment callers can route around with an arbitrary string. Callers
 *  that need the raw pod name (manifests, log-stream calls, …) read
 *  `.value`. */
export function podNameFor(taskId: string, phaseSuffix = "run"): Rfc1123Label {
  const hash = createHash("sha1").update(`${taskId}/${phaseSuffix}`).digest("hex").slice(0, 8);
  const maxLength = Rfc1123Label.MAX_LENGTH - 1 - hash.length - SECRET_SUFFIX_BUDGET;
  const base = Rfc1123Label.slug(`${taskId}-${phaseSuffix}`, { prefix: "ll-", maxLength });
  return base.withSuffix(hash);
}

/** RFC-1123 label VALUE: `[a-zA-Z0-9._-]`, ≤63 chars. Unlike `podNameFor`'s
 *  label NAME rules this allows uppercase and `.` — but we lowercase anyway so
 *  the pod and PVC (and later the reclaim run-selector) compare byte-for-byte
 *  regardless of the source runId's casing. Its character class differs from
 *  {@link Rfc1123Label}'s NAME rules (dots/underscores stay), so it keeps its
 *  own sanitizer rather than routing through the shared slug. */
export function sanitizeLabelValue(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, Rfc1123Label.MAX_LENGTH);
}
