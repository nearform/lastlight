import { Moon, Sun } from "lucide-react";
import { useIndex } from "./lib/api";
import { useNavigate, useRoute } from "./lib/router";
import { useTheme } from "./hooks/useTheme";
import { Home } from "./components/Home";
import { NearformLogo } from "./components/NearformLogo";
import { Overview } from "./components/Overview";
import { RepeatView } from "./components/RepeatView";
import { RunView } from "./components/RunView";

export default function App() {
  const { data: index, isLoading, error } = useIndex();
  const route = useRoute();
  const navigate = useNavigate();
  const { isDark, toggleTheme } = useTheme();

  const tiers = index?.tiers ?? [];
  // No tier in the URL → the Home landing (all tiers + recent runs). A tier is
  // only "selected" when its key is actually in the route.
  const selectedTier = route.tierKey ? tiers.find((t) => t.key === route.tierKey) : undefined;
  const run = route.runId && selectedTier ? selectedTier.runs.find((r) => r.id === route.runId) : undefined;

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-[1600px] px-8 pb-20 pt-10">
        <nav className="mb-7 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button onClick={() => navigate()} className="flex items-center gap-2.5 text-xl font-semibold tracking-tight text-base-content">
            <NearformLogo size={28} className="nf-logo h-7 w-7" />
            Last Light <span className="text-accent">·</span> <span className="text-base-content/70">Evals</span>
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {tiers.map((t) => (
              <button
                key={t.key}
                onClick={() => navigate(t.key)}
                className={
                  "rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold " +
                  (t.key === selectedTier?.key
                    ? "border-info bg-info/15 text-info"
                    : "border-base-300 bg-base-200 text-base-content/60 hover:border-info hover:text-base-content")
                }
              >
                {t.key}
                <span className="ml-1.5 text-base-content/40">{t.runs.length}</span>
              </button>
            ))}
            <button
              onClick={toggleTheme}
              className="rounded-lg border border-base-300 bg-base-200 p-1.5 text-base-content/60 hover:border-info hover:text-base-content"
              title={isDark ? "Switch to light theme" : "Switch to dark theme"}
              aria-label="Toggle light/dark theme"
            >
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </nav>

        {error && index && (
          <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-2xs text-warning">
            Lost contact with the eval server — showing the last data. Is <span className="font-semibold">lastlight-evals serve</span> still running?
          </div>
        )}

        {error && !index ? (
          <ServerDown message={(error as Error).message} />
        ) : isLoading && !index ? (
          <Loading />
        ) : !tiers.length ? (
          <Empty />
        ) : run && selectedTier && route.view === "repeats" ? (
          <div>
            <button
              onClick={() => navigate(selectedTier.key, run.id)}
              className="mb-5 font-mono text-xs text-info hover:underline"
            >
              ← back to this run
            </button>
            <RepeatView
              tierKey={selectedTier.key}
              anchor={run}
              runs={selectedTier.runs}
              labels={Object.assign({}, ...selectedTier.runs.map((r) => r.labels))}
              onOpenRun={(runId) => navigate(selectedTier.key, runId)}
            />
          </div>
        ) : run && selectedTier ? (
          <div>
            <button
              onClick={() => navigate(selectedTier.key)}
              className="mb-5 font-mono text-xs text-info hover:underline"
            >
              ← all {selectedTier.key} runs
            </button>
            <RunView run={run} onShowRepeats={() => navigate(selectedTier.key, run.id, "repeats")} />
          </div>
        ) : selectedTier ? (
          <div>
            <button onClick={() => navigate()} className="mb-5 font-mono text-xs text-info hover:underline">
              ← overview
            </button>
            <h1 className="mb-1 text-2xl font-semibold text-base-content">{selectedTier.key}</h1>
            <p className="mb-6 font-mono text-xs text-base-content/50">
              {selectedTier.runs.length} run{selectedTier.runs.length === 1 ? "" : "s"} · click a run to open its scorecard
            </p>
            <Overview tier={selectedTier} />
          </div>
        ) : (
          <Home tiers={tiers} />
        )}

        <footer className="mt-12 border-t border-base-300 pt-5 font-mono text-2xs text-base-content/40">
          Real production workflows · mocked GitHub · deterministic grading. ★ = best in column. Generated by{" "}
          <span className="text-base-content/60">lastlight-evals run</span>.
        </footer>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="rounded-xl border border-base-300 bg-base-200 px-5 py-10 text-center">
      <p className="font-mono text-sm text-base-content/60">No runs yet.</p>
      <p className="mt-2 font-mono text-xs text-base-content/40">
        Run <span className="text-accent">lastlight-evals run</span> to record one.
      </p>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col items-center gap-3 py-20">
      <span className="loading loading-spinner loading-md text-base-content/30" />
      <p className="font-mono text-xs text-base-content/40">loading eval results…</p>
    </div>
  );
}

/** The harness server isn't answering (it's only up during/after `run`, or via
 * `serve`). Distinct from {@link Empty} so a stopped server doesn't read as
 * "no runs". */
function ServerDown({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-error/40 bg-error/10 px-5 py-10 text-center">
      <p className="font-mono text-sm text-error">Couldn't reach the eval server.</p>
      <p className="mt-2 font-mono text-xs text-base-content/50">
        Start it with <span className="text-accent">lastlight-evals serve</span> (or it stays up after a{" "}
        <span className="text-accent">run</span>).
      </p>
      <p className="mt-3 font-mono text-2xs text-base-content/30">{message}</p>
    </div>
  );
}
