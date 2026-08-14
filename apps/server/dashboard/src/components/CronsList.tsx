import { useCallback, useEffect, useState } from "react";
import { api, type CronInfo } from "../api";

function formatRel(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "ago" : "in";
  const units: Array<[number, string]> = [
    [86400_000, "d"],
    [3600_000, "h"],
    [60_000, "m"],
    [1000, "s"],
  ];
  for (const [size, label] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return ms < 0 ? `${n}${label} ${sign}` : `${sign} ${n}${label}`;
    }
  }
  return ms < 0 ? "just now" : "<1s";
}

interface RowProps {
  cron: CronInfo;
  onChanged: () => void;
  onOpenRuns: (workflow: string) => void;
}

function CronRow({ cron, onChanged, onOpenRuns }: RowProps) {
  const [draftSchedule, setDraftSchedule] = useState(cron.schedule);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triggered, setTriggered] = useState(false);

  useEffect(() => {
    setDraftSchedule(cron.schedule);
  }, [cron.schedule]);

  const dirty = editing && draftSchedule.trim() !== cron.schedule;
  const hasOverride = !!cron.override;

  // A globally-disabled cron KEEPS its scheduler tick (issue #180): a managed
  // repo can opt itself back in from its committed `.lastlight/lastlight.yml`,
  // and that participation is resolved at tick time — so the server can't drop
  // the timer without breaking opt-in. The tick therefore reports a real
  // `nextRun` even while this toggle reads off, which on its own looks like a
  // contradiction. Split the three honest cases:
  //   enabled                       → the timestamp, exactly as before
  //   disabled, nobody opted in     → "—"; the tick fires but dispatches nothing
  //   disabled, someone opted in    → the timestamp + who it actually runs for
  const optedIn = cron.optedInRepos ?? [];
  const optInOnly = !cron.enabled && optedIn.length > 0;
  const showNextRun = !!cron.nextRun && (cron.enabled || optInOnly);

  const toggle = async () => {
    setPending(true);
    setError(null);
    try {
      await api.toggleCron(cron.name);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "toggle failed");
    } finally {
      setPending(false);
    }
  };

  const save = async () => {
    const schedule = draftSchedule.trim();
    if (!schedule || schedule === cron.schedule) {
      setEditing(false);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.setCronSchedule(cron.name, schedule);
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "schedule update failed");
    } finally {
      setPending(false);
    }
  };

  const reset = async () => {
    setPending(true);
    setError(null);
    try {
      await api.resetCronOverride(cron.name);
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "reset failed");
    } finally {
      setPending(false);
    }
  };

  // Fire the cron now (fire-and-forget server-side). The 10s poll picks up the
  // resulting run's status; show a brief "triggered" confirmation meanwhile.
  const run = async () => {
    setPending(true);
    setError(null);
    try {
      await api.triggerCron(cron.name);
      setTriggered(true);
      setTimeout(() => setTriggered(false), 3000);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "trigger failed");
    } finally {
      setPending(false);
    }
  };

  // A `handler:` cron runs host-side code and dispatches no workflow, so
  // `cron.workflow` is null for it and there are no `workflow_runs` to open.
  const label = cron.workflow ?? cron.handler ?? cron.name;
  const hasRuns = !!cron.workflow;

  return (
    <tr className={cron.enabled ? "" : "opacity-60"}>
      <td>
        <button
          className="font-mono text-xs link link-hover text-left"
          onClick={() => cron.workflow && onOpenRuns(cron.workflow)}
          disabled={!hasRuns}
          title={hasRuns ? `See recent runs of ${label}` : `${label} runs in-process — no workflow runs to open`}
        >
          {cron.name}
        </button>
        <div className="text-2xs text-base-content/50">{label}</div>
      </td>
      <td>
        <div className="flex items-center gap-1">
          <input
            className="input input-bordered input-xs font-mono w-40"
            value={draftSchedule}
            onFocus={() => setEditing(true)}
            onChange={(e) => setDraftSchedule(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                setDraftSchedule(cron.schedule);
                setEditing(false);
              }
            }}
            disabled={pending}
          />
          {dirty && (
            <button className="btn btn-xs btn-primary" onClick={save} disabled={pending}>
              Save
            </button>
          )}
          {hasOverride && !dirty && (
            <button
              className="btn btn-xs btn-ghost"
              title={`Reset to YAML default (${cron.originalSchedule})`}
              onClick={reset}
              disabled={pending}
            >
              Reset
            </button>
          )}
        </div>
        {hasOverride && (
          <div className="text-2xs text-base-content/40 mt-0.5">
            override · default <span className="font-mono">{cron.originalSchedule}</span>
          </div>
        )}
        {error && <div className="text-2xs text-error mt-0.5">{error}</div>}
      </td>
      <td>
        <input
          type="checkbox"
          className="toggle toggle-xs toggle-success"
          checked={cron.enabled}
          onChange={toggle}
          disabled={pending}
        />
      </td>
      <td>
        <div className="text-xs">{showNextRun ? formatRel(cron.nextRun) : "—"}</div>
        <div className="text-2xs text-base-content/40">
          {showNextRun && cron.nextRun ? new Date(cron.nextRun).toLocaleString() : ""}
        </div>
        {optInOnly && (
          <div className="text-2xs text-warning" title={`Opted in via .lastlight/: ${optedIn.join(", ")}`}>
            opt-in only · {optedIn.length} repo{optedIn.length === 1 ? "" : "s"}
          </div>
        )}
      </td>
      <td>
        <button
          className="link link-hover text-left inline-flex items-center gap-1.5"
          onClick={() => cron.workflow && onOpenRuns(cron.workflow)}
          disabled={!cron.lastRun || !hasRuns}
          title={
            !hasRuns
              ? `${label} runs in-process — no workflow runs to open`
              : cron.lastRun
                ? `Open recent runs of ${label}`
                : "no runs yet"
          }
        >
          <span className="text-xs">{cron.lastRun ? formatRel(cron.lastRun) : "never"}</span>
          {cron.lastStatus && (
            <span
              className={`badge badge-2xs ${
                cron.lastStatus === "ok" || cron.lastStatus === "succeeded"
                  ? "badge-success"
                  : cron.lastStatus === "failed"
                    ? "badge-error"
                    : cron.lastStatus === "partial"
                      ? "badge-warning"
                      : cron.lastStatus === "running"
                        ? "badge-info"
                        : ""
              }`}
            >
              {cron.lastStatus}
            </span>
          )}
        </button>
        {cron.reposScanned !== null && (
          <div className="text-2xs text-base-content/40">
            scanned {cron.reposScanned}
            {cron.reposEligible !== null &&
              cron.reposEligible !== cron.reposScanned &&
              ` of ${cron.reposEligible}`}
            {cron.discovered !== null && ` · found ${cron.discovered}`}
            {cron.dispatched !== null && ` · dispatched ${cron.dispatched}`}
          </div>
        )}
      </td>
      <td className="text-right">
        {cron.recentFailures > 0 ? (
          <span className="badge badge-xs badge-error">{cron.recentFailures}</span>
        ) : (
          <span className="text-base-content/30">0</span>
        )}
      </td>
      <td className="text-right">
        <button
          className="btn btn-xs btn-ghost"
          onClick={run}
          disabled={pending}
          title={`Run ${label} now`}
        >
          {triggered ? "Triggered ✓" : "Run now"}
        </button>
      </td>
    </tr>
  );
}

export function CronsList({ onOpenRuns }: { onOpenRuns: (workflow: string) => void }) {
  const [crons, setCrons] = useState<CronInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.crons();
      setCrons(res.crons);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load crons");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) {
    return <div className="p-4 text-error text-sm">{error}</div>;
  }
  if (!crons) {
    return <div className="p-4 text-base-content/50 text-sm">Loading…</div>;
  }
  if (crons.length === 0) {
    return <div className="p-4 text-base-content/50 text-sm">No cron jobs registered.</div>;
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="text-xs text-base-content/60 mb-2">
        Toggle to enable/disable a cron, or edit its schedule. Overrides persist across restarts;
        Reset reverts to the YAML default. Run now fires the cron immediately (runs in the
        background — its run appears under Last run).
      </div>
      <table className="table table-xs">
        <thead>
          <tr>
            <th>Cron</th>
            <th>Schedule</th>
            <th>Enabled</th>
            <th>Next run</th>
            <th>Last run</th>
            <th className="text-right">Recent fails</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {crons.map((c) => (
            <CronRow key={c.name} cron={c} onChanged={load} onOpenRuns={onOpenRuns} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
