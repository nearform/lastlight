import { Moon, Sun } from "lucide-react";
import { useIndex, useMicroIndex, usePhaseReplayIndex, useUnitSurveyIndex } from "./lib/api";
import { GRADE_TIER_KEY, MICRO_TIER_KEY, PHASE_REPLAY_TIER_KEY, UNIT_SURVEY_TIER_KEY, useNavigate, useRoute } from "./lib/router";
import { useTheme } from "./hooks/useTheme";
import { Home } from "./components/Home";
import { MicroSurveyDetail, MicroSurveyList } from "./components/MicroSurvey";
import { NearformLogo } from "./components/NearformLogo";
import { Overview } from "./components/Overview";
import { RepeatView } from "./components/RepeatView";
import { RunView } from "./components/RunView";
import { UnitSurveyDetail, UnitSurveyList } from "./components/UnitSurvey";
import { PhaseReplayDetail, PhaseReplayList } from "./components/PhaseReplay";
import { GradePage } from "./components/Grade";

export default function App() {
  const { data: index, isLoading, error } = useIndex();
  // A second, independent index: micro-survey replays are not runs (no tier, no
  // scorecard, no graded cases), so they have their own endpoint and their own
  // route. Its failure must never take the runs view down with it.
  const { data: micro, isLoading: microLoading } = useMicroIndex();
  // A third, for the same reason: unit-survey replays (`/api/unit-survey`).
  const { data: unitSurvey, isLoading: unitLoading } = useUnitSurveyIndex();
  // A fourth: phase replays (micro-falsify / micro-site-review, `/api/phase-replay`).
  const { data: phaseReplay, isLoading: phaseLoading } = usePhaseReplayIndex();
  const route = useRoute();
  const navigate = useNavigate();
  const { isDark, toggleTheme } = useTheme();

  const tiers = index?.tiers ?? [];
  const microReports = micro?.reports ?? [];
  // `micro-survey` occupies the tier-key slot in the hash but is never a tier —
  // see MICRO_TIER_KEY for why that cannot collide.
  const microRoute = route.tierKey === MICRO_TIER_KEY;
  const microEntry = microRoute && route.runId ? microReports.find((r) => r.id === route.runId) : undefined;
  const unitReports = unitSurvey?.reports ?? [];
  const unitRoute = route.tierKey === UNIT_SURVEY_TIER_KEY;
  const unitEntry = unitRoute && route.runId ? unitReports.find((r) => r.id === route.runId) : undefined;
  const phaseReports = phaseReplay?.reports ?? [];
  const phaseRoute = route.tierKey === PHASE_REPLAY_TIER_KEY;
  const phaseEntry = phaseRoute && route.runId ? phaseReports.find((r) => r.id === route.runId) : undefined;
  // Human grading: its findings come from site-review reports, so the nav link
  // shows once one exists (or while the page is open).
  const gradeRoute = route.tierKey === GRADE_TIER_KEY;
  const hasGradable = phaseReports.some((r) => r.kind === "site-review" && !r.audit);
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
            {microReports.length > 0 && (
              <button
                onClick={() => navigate(MICRO_TIER_KEY)}
                title="Micro-survey replays — one survey branch against a preserved workspace, ~2 minutes each"
                className={
                  "rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold " +
                  (microRoute
                    ? "border-info bg-info/15 text-info"
                    : "border-base-300 bg-base-200 text-base-content/60 hover:border-info hover:text-base-content")
                }
              >
                micro-survey
                <span className="ml-1.5 text-base-content/40">{microReports.length}</span>
              </button>
            )}
            {unitReports.length > 0 && (
              <button
                onClick={() => navigate(UNIT_SURVEY_TIER_KEY)}
                title="Unit-survey replays — the per-unit survey over preserved pr-review fixtures, vs the agent survey"
                className={
                  "rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold " +
                  (unitRoute
                    ? "border-info bg-info/15 text-info"
                    : "border-base-300 bg-base-200 text-base-content/60 hover:border-info hover:text-base-content")
                }
              >
                unit-survey
                <span className="ml-1.5 text-base-content/40">{unitReports.length}</span>
              </button>
            )}
            {phaseReports.length > 0 && (
              <button
                onClick={() => navigate(PHASE_REPLAY_TIER_KEY)}
                title="Phase replays — falsify or site-review re-run over preserved pr-review fixtures"
                className={
                  "rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold " +
                  (phaseRoute
                    ? "border-info bg-info/15 text-info"
                    : "border-base-300 bg-base-200 text-base-content/60 hover:border-info hover:text-base-content")
                }
              >
                phase-replay
                <span className="ml-1.5 text-base-content/40">{phaseReports.length}</span>
              </button>
            )}
            {(hasGradable || gradeRoute) && (
              <button
                onClick={() => navigate(GRADE_TIER_KEY)}
                title="Grade flagged findings by hand — real? × importance, reused across arms and repeats"
                className={
                  "rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold " +
                  (gradeRoute
                    ? "border-info bg-info/15 text-info"
                    : "border-base-300 bg-base-200 text-base-content/60 hover:border-info hover:text-base-content")
                }
              >
                grade
              </button>
            )}
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
        ) : gradeRoute ? (
          <div>
            <button onClick={() => navigate()} className="mb-5 font-mono text-xs text-info hover:underline">
              ← overview
            </button>
            <GradePage reportLabel={route.runId} />
          </div>
        ) : microRoute && microLoading && !micro ? (
          <Loading />
        ) : microRoute && microEntry ? (
          <div>
            <button
              onClick={() => navigate(MICRO_TIER_KEY)}
              className="mb-5 font-mono text-xs text-info hover:underline"
            >
              ← all micro-survey reports
            </button>
            <MicroSurveyDetail entry={microEntry} />
          </div>
        ) : microRoute ? (
          <div>
            <button onClick={() => navigate()} className="mb-5 font-mono text-xs text-info hover:underline">
              ← overview
            </button>
            <MicroSurveyList reports={microReports} />
          </div>
        ) : unitRoute && unitLoading && !unitSurvey ? (
          <Loading />
        ) : unitRoute && unitEntry ? (
          <div>
            <button
              onClick={() => navigate(UNIT_SURVEY_TIER_KEY)}
              className="mb-5 font-mono text-xs text-info hover:underline"
            >
              ← all unit-survey reports
            </button>
            <UnitSurveyDetail entry={unitEntry} />
          </div>
        ) : unitRoute ? (
          <div>
            <button onClick={() => navigate()} className="mb-5 font-mono text-xs text-info hover:underline">
              ← overview
            </button>
            <UnitSurveyList reports={unitReports} />
          </div>
        ) : phaseRoute && phaseLoading && !phaseReplay ? (
          <Loading />
        ) : phaseRoute && phaseEntry ? (
          <div>
            <button
              onClick={() => navigate(PHASE_REPLAY_TIER_KEY)}
              className="mb-5 font-mono text-xs text-info hover:underline"
            >
              ← all phase-replay reports
            </button>
            <PhaseReplayDetail entry={phaseEntry} />
          </div>
        ) : phaseRoute ? (
          <div>
            <button onClick={() => navigate()} className="mb-5 font-mono text-xs text-info hover:underline">
              ← overview
            </button>
            <PhaseReplayList reports={phaseReports} />
          </div>
        ) : isLoading && !index ? (
          <Loading />
        ) : !tiers.length && !unitReports.length ? (
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
          <Home tiers={tiers} unitReports={unitReports} />
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
