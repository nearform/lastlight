import { useState } from "react";
import { api, ApiError, type ManagedRepos, type WhenEmpty } from "../api";
import { followAppCount, removeNeedsChoice, showGapSection, toggleConfirmText } from "../lib/managed-repos-view";

/**
 * Config → Managed repos, the writable part: the "Require repo approval"
 * switch, the approved list (remove) and the gap — repos the GitHub App can
 * see that are not approved (approve selected / all).
 *
 * Every write answers with the full `/managed-repos` view, which replaces the
 * pane's data via `onChange`, so what is shown is always the server's state.
 *
 * The dashboard has no modal system; the two confirms here are one-off
 * overlays in the same style as MessageFeed's terminate confirm, because the
 * choice they ask for (follow the App vs require approval) widens or stops
 * everything the bot does and the operator asked for it to be unmissable.
 */
export function RepoApprovalPanel({
  data,
  onChange,
}: {
  data: ManagedRepos;
  onChange: (next: ManagedRepos) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  /** Repos whose removal is waiting on the follow-app / require-approval choice. */
  const [pendingRemove, setPendingRemove] = useState<string[] | null>(null);
  /** The switch position waiting on its confirm. */
  const [pendingToggle, setPendingToggle] = useState<boolean | null>(null);

  /**
   * Send a write and adopt the view it answers with. A 409 means this pane was
   * stale (another tab or operator changed the list): re-fetch, then put the
   * question the server asked — the same confirm the pane would have shown had
   * it been current.
   */
  async function run(write: () => Promise<ManagedRepos>, retry?: { remove?: string[]; toggle?: boolean }) {
    setBusy(true);
    setError(null);
    setPendingRemove(null);
    setPendingToggle(null);
    try {
      const next = await write();
      onChange(next);
      setSelected((s) => s.filter((r) => next.gap?.includes(r)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const fresh = await api.managedRepos().catch(() => null);
        if (fresh) onChange(fresh);
        if (err.message === "would-empty" && retry?.remove) setPendingRemove(retry.remove);
        else if (err.message === "would-follow-app" && retry?.toggle === false) setPendingToggle(false);
        else setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function remove(repos: string[]) {
    if (removeNeedsChoice(data, repos)) setPendingRemove(repos);
    else void run(() => api.removeManagedRepos(repos), { remove: repos });
  }

  function toggle(enable: boolean) {
    if (toggleConfirmText(data, enable)) setPendingToggle(enable);
    else void run(() => api.setRequireRepoApproval(enable), { toggle: enable });
  }

  const gap = data.gap;
  const noAccess = new Set(data.approvedNoAccess.map((r) => r.toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="rounded border border-hairline ll-surface p-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-2 text-sm font-medium text-base-content cursor-pointer">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={data.requireApproval}
            disabled={busy}
            onChange={(e) => toggle(e.target.checked)}
          />
          Require repo approval
        </label>
        <span className="text-xs text-muted min-w-0">
          {data.requireApproval
            ? "Only approved repos get work; repos newly granted to the App wait below until approved."
            : data.approved.length > 0
              ? "Only the approved repos get work."
              : "Off: the bot works on every repo the App can see, including future ones."}
        </span>
      </div>

      {data.yamlDiffers && (
        <p className="text-xs text-muted">
          Managed from the dashboard; the config file's <code>managedRepos</code> /{" "}
          <code>requireRepoApproval</code> are no longer used.
        </p>
      )}

      {error && (
        <div className="rounded border border-error/30 bg-error/10 p-3 text-sm text-error">{error}</div>
      )}

      {data.showApprovalLists && (
        <div className="grid gap-3 lg:grid-cols-2">
          <section className="rounded border border-hairline ll-surface p-3 min-w-0">
            <div className="text-sm font-medium text-base-content mb-2">
              Approved ({data.approved.length})
            </div>
            {data.approved.length === 0 ? (
              <div className="text-sm text-warning">No repo is approved — the bot will respond to nothing.</div>
            ) : (
              <ul className="grid gap-1">
                {data.approved.map((r) => (
                  <li
                    key={r}
                    className="rounded border border-hairline px-2 py-1 flex flex-wrap items-center gap-2 text-xs"
                  >
                    <span className="font-mono text-base-content break-all min-w-0 flex-1">{r}</span>
                    {noAccess.has(r.toLowerCase()) && <span className="text-warning">App has no access</span>}
                    <button className="btn btn-xs btn-ghost" disabled={busy} onClick={() => remove([r])}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {showGapSection(data) && (
            <section className="rounded border border-hairline ll-surface p-3 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <div className="text-sm font-medium text-base-content flex-1">
                  Not approved{gap ? ` (${gap.length})` : ""}
                </div>
                {gap && gap.length > 0 && (
                  <>
                    <button
                      className="btn btn-xs btn-ghost"
                      disabled={busy || selected.length === 0}
                      onClick={() => void run(() => api.approveManagedRepos(selected))}
                    >
                      Approve selected
                    </button>
                    <button
                      className="btn btn-xs btn-primary"
                      disabled={busy}
                      onClick={() => void run(() => api.approveManagedRepos(gap))}
                    >
                      Approve all ({gap.length})
                    </button>
                  </>
                )}
              </div>
              {gap === null ? (
                <div className="text-sm text-muted">The App's repo list hasn't been discovered yet.</div>
              ) : gap.length === 0 ? (
                <div className="text-sm text-muted">Every repo the App can see is approved.</div>
              ) : (
                <ul className="grid gap-1">
                  {gap.map((r) => (
                    <li key={r} className="rounded border border-hairline px-2 py-1 text-xs">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-xs"
                          checked={selected.includes(r)}
                          disabled={busy}
                          onChange={(e) =>
                            setSelected((s) => (e.target.checked ? [...s, r] : s.filter((x) => x !== r)))
                          }
                        />
                        <span className="font-mono text-base-content break-all">{r}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}

      {pendingRemove && (
        <Confirm
          title={`Enable all ${followAppCount(data)} repos the App can see, and future repos, automatically?`}
          body="This removes the last approved repo. Yes: the bot follows the App's repo grant. No: require approval, so nothing gets work until you approve repos."
          busy={busy}
          actions={[
            { label: "Cancel", className: "btn-ghost", onClick: () => setPendingRemove(null) },
            { label: "No", className: "btn-ghost", onClick: () => removeWith("require-approval") },
            { label: "Yes", className: "btn-primary", onClick: () => removeWith("follow-app") },
          ]}
        />
      )}

      {pendingToggle !== null && (
        <Confirm
          title={pendingToggle ? "Require repo approval?" : "Stop requiring repo approval?"}
          body={toggleConfirmText(data, pendingToggle) ?? ""}
          busy={busy}
          actions={[
            { label: "Cancel", className: "btn-ghost", onClick: () => setPendingToggle(null) },
            {
              label: pendingToggle ? "Require approval" : "Follow the App",
              className: "btn-primary",
              onClick: () => void run(() => api.setRequireRepoApproval(pendingToggle, true)),
            },
          ]}
        />
      )}
    </div>
  );

  function removeWith(whenEmpty: WhenEmpty) {
    const repos = pendingRemove;
    if (repos) void run(() => api.removeManagedRepos(repos, whenEmpty));
  }
}

function Confirm({
  title,
  body,
  busy,
  actions,
}: {
  title: string;
  body: string;
  busy: boolean;
  actions: { label: string; className: string; onClick: () => void }[];
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true">
      <div className="bg-base-200 border border-hairline rounded-panel p-6 max-w-md w-full shadow-2xl">
        <h3 className="text-base font-semibold text-base-content mb-2">{title}</h3>
        <p className="text-sm text-muted mb-4">{body}</p>
        <div className="flex flex-wrap justify-end gap-2">
          {actions.map((a) => (
            <button key={a.label} className={`btn btn-sm ${a.className}`} disabled={busy} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
