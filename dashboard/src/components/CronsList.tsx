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

  useEffect(() => {
    setDraftSchedule(cron.schedule);
  }, [cron.schedule]);

  const dirty = editing && draftSchedule.trim() !== cron.schedule;
  const hasOverride = !!cron.override;

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

  return (
    <tr className={cron.enabled ? "" : "opacity-60"}>
      <td>
        <button
          className="font-mono text-xs link link-hover text-left"
          onClick={() => onOpenRuns(cron.workflow)}
          title={`See recent runs of ${cron.workflow}`}
        >
          {cron.name}
        </button>
        <div className="text-2xs text-base-content/50">{cron.workflow}</div>
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
        <div className="text-xs">{cron.nextRun ? formatRel(cron.nextRun) : "—"}</div>
        <div className="text-2xs text-base-content/40">
          {cron.nextRun ? new Date(cron.nextRun).toLocaleString() : ""}
        </div>
      </td>
      <td>
        <button
          className="link link-hover text-left inline-flex items-center gap-1.5"
          onClick={() => onOpenRuns(cron.workflow)}
          disabled={!cron.lastRun}
          title={cron.lastRun ? `Open recent runs of ${cron.workflow}` : "no runs yet"}
        >
          <span className="text-xs">{cron.lastRun ? formatRel(cron.lastRun) : "never"}</span>
          {cron.lastStatus && (
            <span
              className={`badge badge-2xs ${
                cron.lastStatus === "succeeded"
                  ? "badge-success"
                  : cron.lastStatus === "failed"
                    ? "badge-error"
                    : cron.lastStatus === "running"
                      ? "badge-info"
                      : ""
              }`}
            >
              {cron.lastStatus}
            </span>
          )}
        </button>
      </td>
      <td className="text-right">
        {cron.recentFailures > 0 ? (
          <span className="badge badge-xs badge-error">{cron.recentFailures}</span>
        ) : (
          <span className="text-base-content/30">0</span>
        )}
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
        Reset reverts to the YAML default.
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
