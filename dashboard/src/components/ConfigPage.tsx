import { useEffect, useState } from "react";
import { api, type ConfigBundle } from "../api";

type Pane = "default" | "overlay" | "merged";

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function ConfigPage() {
  const [config, setConfig] = useState<ConfigBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("merged");

  useEffect(() => {
    let cancelled = false;
    api.config()
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  const value = config ? config[pane] : null;

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-base-100">
      <div className="border-b border-base-300 px-4 py-3">
        <h2 className="text-sm font-semibold text-base-content">Configuration</h2>
        <p className="text-xs text-base-content/60 mt-1">
          Read-only startup config. Secrets are omitted; changes require a harness restart.
        </p>
      </div>
      <div className="flex gap-1 border-b border-base-300 bg-base-200/60 px-4 py-2">
        {(["default", "overlay", "merged"] as const).map((id) => (
          <button
            key={id}
            onClick={() => setPane(id)}
            className={`px-3 py-1.5 rounded text-xs font-medium ${pane === id ? "bg-primary text-primary-content" : "hover:bg-base-300 text-base-content/70"}`}
          >
            {id === "default" ? "Default" : id === "overlay" ? "Overlay" : "Merged"}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {error ? (
          <div className="rounded border border-error/30 bg-error/10 p-3 text-sm text-error">{error}</div>
        ) : !config ? (
          <div className="text-sm text-base-content/60">Loading configuration…</div>
        ) : value === null ? (
          <div className="rounded border border-base-300 bg-base-200 p-3 text-sm text-base-content/70">
            No overlay config is active.
          </div>
        ) : (
          <pre className="whitespace-pre-wrap rounded border border-base-300 bg-base-200 p-4 text-xs leading-relaxed text-base-content overflow-auto">
            {pretty(value)}
          </pre>
        )}
      </div>
    </div>
  );
}
