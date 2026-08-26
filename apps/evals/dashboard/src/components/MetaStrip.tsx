import type { InstanceResult, RunMeta } from "../types";
import { modelLabel } from "../lib/format";

/**
 * What produced this run — model, overlay, core, sandbox, git SHA, toolchain.
 *
 * Two runs whose numbers differ are only comparable if what produced them is
 * known, and the answer used to live in a terminal scrollback. Several of these
 * fields are being added to `RunMeta` by the harness; every one is optional here
 * and a missing field simply doesn't render, so this works before and after they
 * land rather than needing to ship in lockstep.
 *
 * The toolchain falls back to the per-case evidence packet
 * (`review.pipeline.toolchain`) when the run-level stamp is absent — a run that
 * recorded its analyser versions per case has still recorded them.
 */
export function MetaStrip({
  meta,
  results,
  labels,
  fallback,
}: {
  meta?: RunMeta;
  results: InstanceResult[];
  labels: Record<string, string>;
  fallback: { gitSha?: string; models: string[] };
}) {
  const arms = (meta?.models?.length ? meta.models : fallback.models).map((m) => modelLabel(labels, m));
  const gitSha = meta?.gitSha ?? fallback.gitSha;
  const core = meta?.core;
  const coreText = core
    ? [core.version, core.published ? "published" : core.root ? "working tree" : undefined].filter(Boolean).join(" · ")
    : undefined;
  const toolchain =
    meta?.toolchain ?? results.find((r) => r.review?.pipeline?.toolchain)?.review?.pipeline?.toolchain;

  const items: [string, string | undefined, string?][] = [
    ["model", arms.join(", ") || undefined],
    ["overlay", meta?.overlay],
    ["core", coreText, core?.root],
    ["sandbox", meta?.sandbox],
    ["git", gitSha],
    ["trials", meta?.runs && meta.runs > 1 ? `${meta.runs}× per case` : undefined],
    [
      "concurrency",
      meta?.concurrency && meta.concurrency > 1 ? String(meta.concurrency) : undefined,
      "Cases of this arm run at once — the arm's elapsed time is then not the sum of its cases.",
    ],
    [
      "repeat",
      meta?.repeat ? `${meta.repeat.group}${meta.repeat.of ? ` (${meta.repeat.index}/${meta.repeat.of})` : ""}` : undefined,
    ],
  ];
  const shown = items.filter(([, v]) => !!v);
  if (!shown.length && !toolchain) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-base-300 bg-base-200 px-4 py-2.5 font-mono text-2xs">
      {shown.map(([k, v, hint]) => (
        <span key={k} title={hint} className="whitespace-nowrap">
          <span className="text-base-content/40">{k}</span>{" "}
          <span className="text-base-content/80">{v}</span>
        </span>
      ))}
      {toolchain && Object.keys(toolchain).length > 0 && (
        <span
          className="whitespace-nowrap"
          title={Object.entries(toolchain)
            .map(([k, v]) => `${k} ${v}`)
            .join("\n")}
        >
          <span className="text-base-content/40">toolchain</span>{" "}
          <span className="text-base-content/80">
            {Object.entries(toolchain)
              .map(([k, v]) => `${k}@${v}`)
              .join(" ")}
          </span>
        </span>
      )}
    </div>
  );
}
