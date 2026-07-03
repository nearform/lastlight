import { useEffect } from "react";

import type { ReviewTrace } from "../types";

/** A colored badge for one finding/gold row's match status. */
function MatchBadge({ label, kind }: { label: string; kind: "match" | "fp" | "miss" }) {
  const cls =
    kind === "match"
      ? "border-success/40 bg-success/10 text-success"
      : kind === "fp"
        ? "border-error/40 bg-error/10 text-error"
        : "border-warning/40 bg-warning/10 text-warning";
  return (
    <span className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-2xs ${cls}`}>{label}</span>
  );
}

/** A collapsible raw-text block (review text / raw judge reply). */
function RawBlock({ title, text }: { title: string; text?: string }) {
  if (!text?.trim()) return null;
  return (
    <details className="border-t border-base-300">
      <summary className="cursor-pointer px-4 py-2 font-mono text-2xs text-base-content/60 hover:text-base-content">
        {title}
      </summary>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words bg-base-200/40 px-4 py-3 font-mono text-2xs leading-5 text-base-content/80">
        {text}
      </pre>
    </details>
  );
}

/**
 * Full-screen overlay making a pr-review F-beta score inspectable: the two-step
 * LLM judge's working — the findings it distilled from the review, the gold set,
 * the finding↔gold pairing (green = matched, red = false positive, amber =
 * missed gold), and its raw replies. Reads the trace embedded in the scorecard
 * (no fetch). Closes on backdrop click or Esc — mirrors {@link DiffModal}. */
export function JudgeModal({ title, trace, onClose }: { title: string; trace: ReviewTrace; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const matched = trace.findings.filter((f) => f.matchedGold !== null).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex h-[calc(100vh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-base-300 bg-base-200/80 px-4 py-2.5">
          <span className="truncate font-mono text-xs text-base-content/70">{title}</span>
          <span className="shrink-0 whitespace-nowrap rounded border border-base-300 bg-base-200 px-1.5 py-0.5 font-mono text-2xs text-base-content/60">
            judge: {trace.judgeModel}
          </span>
          <span className="shrink-0 whitespace-nowrap font-mono text-2xs text-base-content/50">
            {matched}/{trace.gold.length} gold matched · {trace.findings.length} posted
          </span>
          {trace.usedDiff && (
            <span
              className="shrink-0 whitespace-nowrap rounded border border-info/40 bg-info/10 px-1.5 py-0.5 font-mono text-2xs text-info"
              title="The PR diff was fed to the judge (--judge-with-diff) — not comparable to Martian's diff-blind offline leaderboard"
            >
              diff-aware
            </span>
          )}
          <button onClick={onClose} className="btn btn-ghost btn-xs ml-auto h-6 min-h-0" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Findings the judge distilled from the review. */}
          <section className="px-4 py-3">
            <h3 className="mb-2 font-mono text-2xs uppercase tracking-wide text-base-content/50">
              Findings extracted from the review ({trace.findings.length})
            </h3>
            {trace.findings.length === 0 ? (
              <p className="font-mono text-2xs text-base-content/40">No concrete findings extracted.</p>
            ) : (
              <ul className="space-y-1.5">
                {trace.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 font-mono text-2xs leading-5">
                    <span className="shrink-0 text-base-content/40">#{i}</span>
                    <span className="min-w-0 flex-1">
                      {f.file && <span className="text-info">{f.file}: </span>}
                      <span className="text-base-content/85">{f.description}</span>
                    </span>
                    {f.matchedGold !== null ? (
                      <MatchBadge kind="match" label={`✓ gold #${f.matchedGold}`} />
                    ) : (
                      <MatchBadge kind="fp" label="false positive" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* The gold set, with which finding (if any) caught each. */}
          <section className="border-t border-base-300 px-4 py-3">
            <h3 className="mb-2 font-mono text-2xs uppercase tracking-wide text-base-content/50">
              Gold set ({trace.gold.length})
            </h3>
            {trace.gold.length === 0 ? (
              <p className="font-mono text-2xs text-base-content/40">No gold comments for this PR.</p>
            ) : (
              <ul className="space-y-1.5">
                {trace.gold.map((g, i) => (
                  <li key={i} className="flex items-start gap-2 font-mono text-2xs leading-5">
                    <span className="shrink-0 text-base-content/40">#{i}</span>
                    <span className="shrink-0 text-base-content/50">[{g.severity}]</span>
                    <span className="min-w-0 flex-1 text-base-content/85">{g.description}</span>
                    {g.matchedFinding !== null ? (
                      <MatchBadge kind="match" label={`✓ finding #${g.matchedFinding}`} />
                    ) : (
                      <MatchBadge kind="miss" label="missed" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Raw judge working, collapsed by default. */}
          <RawBlock title="Review text the judge read" text={trace.reviewText} />
          <RawBlock title="Raw judge reply — finding extraction" text={trace.rawExtract} />
          <RawBlock title="Raw judge reply — gold matching" text={trace.rawMatch} />
        </div>
      </div>
    </div>
  );
}
