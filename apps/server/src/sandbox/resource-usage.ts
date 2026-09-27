/**
 * Sandbox resource usage, read from the sandbox's OWN cgroup v2 files.
 *
 * Every docker container and every k8s pod container runs in a private cgroup
 * namespace, so inside it `/sys/fs/cgroup` is exactly that sandbox's cgroup:
 *
 * - `cpu.stat` `usage_usec` — cumulative CPU time of everything that ran in it
 *   (the agentic-pi harness plus every tool it spawned). Exact, no sampling.
 * - `memory.peak` — the high-water mark (kernel >= 5.19; absent before).
 * - `memory.max` — the limit, or the literal `max` when unlimited.
 *
 * One shell snippet reads all three and prints ONE marker line, so both
 * backends share a single reader and a single parser: docker runs it through
 * `docker exec` just before teardown; k8s appends it to the pod's script and
 * picks the line off the log stream it already follows (the server pod can see
 * neither the sandbox's cgroup nor, without new RBAC, any metrics API).
 */

export interface ResourceUsage {
  cpuSeconds: number;
  peakMemoryBytes?: number;
  memoryLimitBytes?: number;
}

const MARKER_TYPE = "lastlight_sandbox_usage";

/**
 * The `stop_reason` of a fan-out's `<phase>_sandbox` executions row: it carries
 * the shared sandbox's CPU / memory and is NOT work, so the stats rollups leave
 * it out of every execution and outcome count (its CPU still sums) and the
 * dashboard draws no card for it.
 */
export const RESOURCE_USAGE_STOP_REASON = "resource_usage";

/** Exactly the line {@link CGROUP_USAGE_SCRIPT} prints — nothing before, after or between. */
const MARKER_RE = new RegExp(
  `^\\{"type":"${MARKER_TYPE}","usage_usec":"\\d*","memory_peak":"\\d*","memory_max":"(?:\\d*|max)"\\}$`,
);

/**
 * POSIX sh. Values are quoted as JSON strings and validated by
 * {@link parseUsageLine}, so a missing file (cgroup v1, old kernel) prints an
 * empty field rather than malformed JSON.
 */
export const CGROUP_USAGE_SCRIPT = [
  `cpu=$( (while read -r k v; do [ "$k" = usage_usec ] && echo "$v"; done < /sys/fs/cgroup/cpu.stat) 2>/dev/null )`,
  `peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)`,
  `max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)`,
  `printf '{"type":"${MARKER_TYPE}","usage_usec":"%s","memory_peak":"%s","memory_max":"%s"}\\n' "$cpu" "$peak" "$max"`,
].join("\n");

/**
 * True when `line` has exactly the marker's shape. A full-line match, not a
 * substring: a workload printing JSON that merely CONTAINS the type literal
 * (an agent working on this code, a command echoing test fixtures) is not
 * mistaken for a reading. Shape alone cannot say who printed it — see
 * `KubernetesSandbox.runPod` for the last-line rule that decides that.
 */
export function isUsageLine(line: string): boolean {
  return MARKER_RE.test(line.trimEnd());
}

function bytesOrUndefined(v: unknown): number | undefined {
  return typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
}

/** Parse the marker line; undefined for any other line or an unreadable cgroup. */
export function parseUsageLine(line: string): ResourceUsage | undefined {
  if (!isUsageLine(line)) return undefined;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line.trimEnd()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const usec = bytesOrUndefined(rec.usage_usec);
  if (usec === undefined) return undefined;
  const usage: ResourceUsage = { cpuSeconds: usec / 1e6 };
  const peak = bytesOrUndefined(rec.memory_peak);
  if (peak !== undefined) usage.peakMemoryBytes = peak;
  const max = bytesOrUndefined(rec.memory_max);
  if (max !== undefined) usage.memoryLimitBytes = max;
  return usage;
}

/**
 * Fold one cgroup's reading into a running total for a sandbox that spans
 * several (k8s runs one pod per turn). CPU adds; memory peak and limit are the
 * largest seen — pods run one after another or side by side, and either way the
 * useful sizing number is the biggest single one, not a sum.
 */
export function combineUsage(a: ResourceUsage | undefined, b: ResourceUsage): ResourceUsage {
  if (!a) return { ...b };
  const out: ResourceUsage = { cpuSeconds: a.cpuSeconds + b.cpuSeconds };
  const peak = maxDefined(a.peakMemoryBytes, b.peakMemoryBytes);
  if (peak !== undefined) out.peakMemoryBytes = peak;
  const limit = maxDefined(a.memoryLimitBytes, b.memoryLimitBytes);
  if (limit !== undefined) out.memoryLimitBytes = limit;
  return out;
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
