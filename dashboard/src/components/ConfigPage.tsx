import { useEffect, useState } from "react";
import { api, type ConfigBundle, type OverridesBundle, type OverlayAsset, type ManagedRepos } from "../api";

type Pane = "default" | "overlay" | "merged" | "sources" | "overrides" | "repos";

const PANE_LABELS: Record<Pane, string> = {
  default: "Default",
  overlay: "Overlay",
  merged: "Merged",
  sources: "Sources",
  overrides: "Overrides",
  repos: "Managed repos",
};

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const TYPE_ORDER: OverlayAsset["type"][] = ["workflow", "cron", "prompt", "skill", "agent-context"];

function OverridesPane({ data }: { data: OverridesBundle | null }) {
  if (!data) return <div className="text-sm text-base-content/60">Loading overrides…</div>;
  if (data.overrides.length === 0) {
    return (
      <div className="rounded border border-base-300 ll-surface p-3 text-sm text-base-content/70">
        No overlay overrides active.{" "}
        {data.overlayDir ? (
          <>Fork a built-in with <code className="text-xs">lastlight fork &lt;name&gt;</code>.</>
        ) : (
          <>No deployment overlay is configured.</>
        )}
      </div>
    );
  }
  const sorted = [...data.overrides].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.name.localeCompare(b.name),
  );
  return (
    <div className="overflow-auto">
      {data.overlayDir && (
        <p className="text-xs text-base-content/60 mb-3">
          Overlay: <code className="text-xs">{data.overlayDir}</code>
        </p>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-base-content/60 border-b border-base-300">
            <th className="py-1.5 pr-4 font-medium">Asset</th>
            <th className="py-1.5 pr-4 font-medium">Type</th>
            <th className="py-1.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={`${a.type}:${a.name}`} className="border-b border-base-300/50">
              <td className="py-1.5 pr-4 font-mono text-base-content">{a.name}</td>
              <td className="py-1.5 pr-4 text-base-content/70">{a.type}</td>
              <td className="py-1.5">
                <span
                  className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    a.shadowsDefault
                      ? "bg-warning/20 text-warning"
                      : "bg-success/20 text-success"
                  }`}
                >
                  {a.shadowsDefault ? "shadows default" : "added"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ManagedReposPane({ data }: { data: ManagedRepos | null }) {
  if (!data) return <div className="text-sm text-base-content/60">Loading managed repos…</div>;
  return (
    <div className="overflow-auto space-y-3">
      <div className="rounded border border-base-300 ll-surface p-3 text-sm text-base-content/70">
        Events are gated to the <strong>effective</strong> list below. Source:{" "}
        <span className="font-medium text-base-content">
          {data.source === "config"
            ? "overlay config (managedRepos is set)"
            : "GitHub App installation (managedRepos empty — tracking the App grant)"}
        </span>
        .{" "}
        {data.refreshedAt && (
          <>Installation list refreshed <code className="text-xs">{new Date(data.refreshedAt).toLocaleString()}</code>.</>
        )}
      </div>
      {data.effective.length === 0 ? (
        <div className="rounded border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          No managed repos — the bot will respond to nothing. Set an overlay{" "}
          <code className="text-xs">managedRepos</code> list, or wait for installation discovery.
        </div>
      ) : (
        <ul className="text-xs font-mono grid gap-1">
          {data.effective.map((r) => (
            <li key={r} className="rounded border border-base-300/50 px-2 py-1 text-base-content">{r}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-base-content/50">
        {data.configured.length} configured · {data.installation.length} accessible to the App installation
      </p>
    </div>
  );
}

export function ConfigPage() {
  const [config, setConfig] = useState<ConfigBundle | null>(null);
  const [overrides, setOverrides] = useState<OverridesBundle | null>(null);
  const [repos, setRepos] = useState<ManagedRepos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("merged");

  useEffect(() => {
    let cancelled = false;
    api.config()
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    api.overrides()
      .then((o) => { if (!cancelled) setOverrides(o); })
      .catch(() => { /* non-fatal — the Overrides pane shows its own loading state */ });
    api.managedRepos()
      .then((r) => { if (!cancelled) setRepos(r); })
      .catch(() => { /* non-fatal — the Managed repos pane shows its own loading state */ });
    return () => { cancelled = true; };
  }, []);

  const value = config && pane !== "overrides" && pane !== "repos" ? config[pane] : null;

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-base-100">
      <div className="border-b border-base-300 px-4 py-3">
        <h2 className="text-sm font-semibold text-base-content">Configuration</h2>
        <p className="text-xs text-base-content/60 mt-1">
          Read-only startup config. Secrets are omitted; changes require a harness restart.
          The Sources pane shows each value's provenance (default / overlay / env); the
          Overrides pane lists assets the deployment overlay forks; the Managed repos pane
          shows which repos events are gated to and where that list comes from.
        </p>
      </div>
      <div className="flex gap-1 border-b border-base-300 bg-base-200/60 px-4 py-2">
        {(["default", "overlay", "merged", "sources", "overrides", "repos"] as const).map((id) => (
          <button
            key={id}
            onClick={() => setPane(id)}
            className={`px-3 py-1.5 rounded text-xs font-medium ${pane === id ? "bg-primary text-primary-content" : "hover:bg-base-300 text-base-content/70"}`}
          >
            {PANE_LABELS[id]}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {error ? (
          <div className="rounded border border-error/30 bg-error/10 p-3 text-sm text-error">{error}</div>
        ) : pane === "overrides" ? (
          <OverridesPane data={overrides} />
        ) : pane === "repos" ? (
          <ManagedReposPane data={repos} />
        ) : !config ? (
          <div className="text-sm text-base-content/60">Loading configuration…</div>
        ) : value === null ? (
          <div className="rounded border border-base-300 ll-surface p-3 text-sm text-base-content/70">
            No overlay config is active.
          </div>
        ) : (
          <pre className="whitespace-pre-wrap rounded border border-base-300 ll-surface p-4 text-xs leading-relaxed text-base-content overflow-auto">
            {pretty(value)}
          </pre>
        )}
      </div>
    </div>
  );
}
