import { useState } from "react";
import { api, type WorkflowApproval } from "../api";

interface Props {
  approvals: WorkflowApproval[];
  onResponded: () => void;
}

/**
 * In-SPA navigation to the focused approval view. Pushes `?approval=<id>` and
 * fires a synthetic popstate so App's router (which reads the param on
 * popstate) swaps to the focused view — same pattern as `openArtifact`.
 */
function openFocusedApproval(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("approval", id);
  window.history.pushState(null, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function ApprovalItem({ approval, onResponded }: { approval: WorkflowApproval; onResponded: () => void }) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (decision: "approved" | "rejected") => {
    setPending(true);
    setError(null);
    try {
      await api.respondToApproval(approval.id, decision, reason || undefined);
      onResponded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="border border-warning/40 bg-warning/5 rounded-panel p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="ll-status badge text-warning badge-sm">{approval.gate}</span>
        <span className="text-xs text-strong">{approval.summary}</span>
        {approval.artifact && (
          <button
            className="btn btn-xs btn-ghost text-primary ml-auto"
            onClick={() => openFocusedApproval(approval.id)}
            title={`Review ${approval.artifact}`}
          >
            Open focused review →
          </button>
        )}
      </div>
      <textarea
        className="textarea textarea-bordered textarea-xs w-full resize-none"
        placeholder="Optional reason…"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={pending}
      />
      {error && <span className="text-2xs text-error">{error}</span>}
      <div className="flex gap-2">
        <button
          className="btn btn-xs btn-success"
          onClick={() => respond("approved")}
          disabled={pending}
        >
          Approve
        </button>
        <button
          className="btn btn-xs btn-error btn-outline"
          onClick={() => respond("rejected")}
          disabled={pending}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

export function ApprovalBanner({ approvals, onResponded }: Props) {
  if (approvals.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 mb-3">
      <div className="text-2xs font-semibold uppercase tracking-wider text-warning">
        Pending Approvals
      </div>
      {approvals.map((a) => (
        <ApprovalItem key={a.id} approval={a} onResponded={onResponded} />
      ))}
    </div>
  );
}
