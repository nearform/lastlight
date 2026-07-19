import { useCallback, useEffect, useState } from "react";
import { api, type WorkflowApproval, type ArtifactRef, type WorkflowRun } from "../api";
import { ArtifactEditor } from "./ArtifactEditor";
import { GhLink } from "./GhLink";
import { repoUrl, issueUrl } from "../lib/githubLinks";

interface Props {
  approvalId: string;
  /** Return to the full dashboard (clears the ?approval param). */
  onClose: () => void;
}

interface Loaded {
  approval: WorkflowApproval;
  artifactRef: ArtifactRef | null;
  run: WorkflowRun | null;
}

/**
 * Focused approval view — a minimal, deep-linkable surface (no tab bar, no
 * sidebar) for resolving one approval gate against its artifact. Reached via
 * `?approval=<id>` (from the GitHub/Slack gate message's {{approvalUrl}} link or
 * the in-dashboard "Open focused review" button).
 *
 * - Server storage mode → embeds the {@link ArtifactEditor} so the reviewer can
 *   read, edit, and save the handoff doc before approving.
 * - Repo storage mode → links out to the doc's file on GitHub.
 *
 * Approve/reject reuses the same `POST /approvals/:id/respond` endpoint as the
 * inline banner (approve → resume the run, reject → fail it).
 */
export function FocusedApprovalView({ approvalId, onClose }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [respondError, setRespondError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<"approved" | "rejected" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    api.approval(approvalId)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [approvalId]);

  const respond = useCallback(async (decision: "approved" | "rejected") => {
    setPending(true);
    setRespondError(null);
    try {
      await api.respondToApproval(approvalId, decision, reason || undefined);
      setResolved(decision);
    } catch (e) {
      setRespondError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setPending(false);
    }
  }, [approvalId, reason]);

  const approval = data?.approval;
  const artifactRef = data?.artifactRef ?? null;
  const run = data?.run ?? null;
  // Already-resolved (loaded as non-pending) or just resolved by us.
  const alreadyResolved = !!approval && approval.status !== "pending";
  const isDone = resolved !== null || alreadyResolved;

  return (
    <div className="h-full flex flex-col bg-base-100">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-base-300 px-4 py-2.5">
        <button className="btn btn-xs btn-ghost" onClick={onClose}>← Dashboard</button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-base-content">Approval</span>
            {approval && <span className="badge badge-warning badge-sm">{approval.gate}</span>}
          </div>
          {run &&
            (() => {
              const rHref = repoUrl(run.repo);
              const iHref = issueUrl(run.repo, run.issueNumber, run.workflowName);
              return (
                <p className="truncate text-[11px] text-base-content/50">
                  {run.workflowName}
                  {run.repo && (
                    <>
                      {" · "}
                      {rHref ? (
                        <GhLink href={rHref} title={`Open ${run.repo} on GitHub`}>
                          {run.repo}
                        </GhLink>
                      ) : (
                        run.repo
                      )}
                    </>
                  )}
                  {run.issueNumber ? (
                    <>
                      {" "}
                      {iHref ? (
                        <GhLink href={iHref} title={`Open #${run.issueNumber} on GitHub`}>
                          #{run.issueNumber}
                        </GhLink>
                      ) : (
                        `#${run.issueNumber}`
                      )}
                    </>
                  ) : null}
                </p>
              );
            })()}
        </div>
      </div>

      {loadError && (
        <div className="m-4 rounded border border-error/30 bg-error/10 p-3 text-sm text-error">
          Failed to load approval: {loadError}
        </div>
      )}

      {!data && !loadError && (
        <div className="p-6 text-sm text-base-content/50">Loading…</div>
      )}

      {approval && (
        <>
          {/* ── Summary ─────────────────────────────────────────────────── */}
          <div className="border-b border-base-300 px-4 py-3">
            <p className="text-sm text-base-content/80">{approval.summary}</p>
            {approval.artifact && (
              <p className="mt-1 text-xs text-base-content/50">
                Artifact: <span className="font-mono">{approval.artifact}</span>
              </p>
            )}
          </div>

          {/* ── Body: editor (server) | GitHub link (repo) ──────────────── */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {artifactRef?.mode === "server" ? (
              <ArtifactEditor
                owner={artifactRef.owner}
                repo={artifactRef.repo}
                docKey={artifactRef.issueKey}
                doc={artifactRef.doc}
              />
            ) : artifactRef?.mode === "repo" ? (
              <div className="p-6">
                <div className="rounded-lg border border-base-300 ll-surface p-4">
                  <p className="text-sm text-base-content/70">
                    This artifact is committed to the repository. Review it on GitHub:
                  </p>
                  {artifactRef.githubUrl ? (
                    <a
                      className="btn btn-sm btn-primary mt-3"
                      href={artifactRef.githubUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      🔗 {artifactRef.doc} on GitHub
                    </a>
                  ) : (
                    <p className="mt-2 text-xs text-base-content/50">
                      <span className="font-mono">{artifactRef.doc}</span> — no branch link
                      available for this run.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-6 text-sm text-base-content/50">
                No artifact is linked to this gate — approve or reject below.
              </div>
            )}
          </div>

          {/* ── Footer: approve / reject ────────────────────────────────── */}
          <div className="border-t border-base-300 px-4 py-3">
            {isDone ? (
              <div className="flex items-center gap-3">
                <span className={`badge ${(resolved ?? approval.status) === "approved" ? "badge-success" : "badge-error"}`}>
                  {resolved ?? approval.status}
                </span>
                <span className="text-sm text-base-content/70">
                  This approval is resolved.
                </span>
                <button className="btn btn-xs btn-ghost ml-auto" onClick={onClose}>
                  Back to dashboard
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <textarea
                  className="textarea textarea-bordered textarea-sm w-full resize-none"
                  placeholder="Optional reason (required by some teams on reject)…"
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={pending}
                />
                {respondError && <span className="text-xs text-error">{respondError}</span>}
                <div className="flex gap-2">
                  <button
                    className="btn btn-sm btn-success"
                    onClick={() => respond("approved")}
                    disabled={pending}
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn-sm btn-error btn-outline"
                    onClick={() => respond("rejected")}
                    disabled={pending}
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
