import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  api,
  type ConfigSource,
  type OverlayAsset,
  type RepoConfigBundle,
  type RepoConfigWarning,
} from "../api";
import { pretty } from "./ConfigPage";

/**
 * Repos → Config: the effective configuration for ONE repository (issue #180).
 *
 * A managed repo may commit a `.lastlight/` directory that overrides a bounded
 * subset of the instance config for runs against itself. This pane answers two
 * questions at a glance:
 *
 *   1. **Which values came from the repo rather than the instance?** That's the
 *      `repo` provenance, deliberately the loudest thing on the page — a solid
 *      badge plus a highlighted row, where every other layer is a muted chip.
 *   2. **What did the harness throw away, and why?** The server warns-and-
 *      continues on a bad `lastlight.yml` rather than failing the run, so the
 *      warnings block is the ONLY place a repo owner can find out their typo
 *      was ignored. It sits above the fold, before the values.
 *
 * A repo with no `.lastlight/` is a normal, non-error state: the banner says so
 * and the inherited effective config is shown anyway.
 *
 * Reuses {@link pretty} and the pane styling from ConfigPage so the instance
 * and per-repo config views look like one feature.
 */

/**
 * Sections rendered, in order. `fix` / `dependencies` / `review` are the
 * policy blocks (issues #251, #252): the endpoint returned them with
 * provenance from the day they shipped, but this list stopped at `approval`,
 * so a repo's budgets were invisible on the one surface an operator uses to
 * check them (#256).
 */
const SECTIONS = [
  "models",
  "variants",
  "disabled",
  "approval",
  "fix",
  "dependencies",
  "review",
  "notifications",
] as const;
type Section = (typeof SECTIONS)[number];

/** One row of the effective-config table. */
interface Leaf {
  path: string;
  value: unknown;
  source: ConfigSource;
}

const SOURCE_STYLE: Record<ConfigSource, string> = {
  default: "bg-base-200 text-base-content/60",
  overlay: "bg-info/20 text-info",
  env: "bg-warning/20 text-warning",
  // The one value the view exists to communicate — solid, not a tint.
  repo: "bg-secondary text-secondary-content font-semibold",
};

const SOURCE_LABEL: Record<ConfigSource, string> = {
  default: "default",
  overlay: "overlay",
  env: "env",
  repo: "repo",
};

function SourceBadge({ source }: { source: ConfigSource }) {
  return (
    <span className={clsx("inline-block rounded px-1.5 py-0.5 text-[11px] font-medium", SOURCE_STYLE[source])}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

/**
 * Flatten `merged` + `sources` into one sorted row list, section by section.
 *
 * Most sections are a flat record of scalars, so this is one row per key. One
 * — `notifications` — nests (`slack.channel`), and the endpoint's provenance
 * for it is already keyed by that DOTTED leaf. So a nested value is descended
 * into and its path joined with a dot, which lands on the same key the sources
 * map uses. Without this the tab would render a row reading
 * `notifications.slack = [object Object]` with a provenance of "default",
 * hiding the one value that view exists to communicate.
 */
function toLeaves(data: RepoConfigBundle): Leaf[] {
  const rows: Leaf[] = [];
  const isNested = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  for (const section of SECTIONS) {
    const values = data.merged[section] as Record<string, unknown> | undefined;
    const sources = data.sources[section] as Record<string, ConfigSource> | undefined;

    const walk = (node: Record<string, unknown>, prefix: string) => {
      for (const key of Object.keys(node).sort()) {
        const leaf = prefix ? `${prefix}.${key}` : key;
        const value = node[key];
        if (isNested(value)) {
          walk(value, leaf);
          continue;
        }
        rows.push({
          path: `${section}.${leaf}`,
          value,
          source: (sources ?? {})[leaf] ?? "default",
        });
      }
    };
    walk(values ?? {}, "");
  }
  return rows;
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  // An explicit `null` is a VALUE in the policy blocks — `fix.maxCostUsd: null`
  // is "no ceiling", `review.requestLabel: null` is "no label trigger" — so it
  // must not render as the same em-dash an absent leaf gets.
  if (value === null) return "null";
  if (value === undefined) return "—";
  return String(value);
}

function WarningsBlock({ warnings }: { warnings: RepoConfigWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="rounded border border-warning/40 bg-warning/10 p-3">
      <div className="text-xs font-semibold text-warning">
        {warnings.length} item{warnings.length === 1 ? "" : "s"} dropped from this repo's{" "}
        <code className="text-[11px]">.lastlight/</code>
      </div>
      <p className="mt-1 text-[11px] text-base-content/60">
        Last Light warns and keeps going rather than failing the run, so these were ignored — the
        instance value stands.
      </p>
      <ul className="mt-2 grid gap-1.5">
        {warnings.map((w, i) => (
          <li key={`${w.code}:${w.path}:${i}`} className="rounded ll-surface px-2 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                {w.code}
              </span>
              <code className="font-mono text-[11px] text-base-content/80">{w.path}</code>
            </div>
            <div className="mt-1 text-base-content/70">{w.message}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TYPE_ORDER: OverlayAsset["type"][] = ["workflow", "cron", "prompt", "skill", "agent-context"];

function AssetsBlock({ assets }: { assets: OverlayAsset[] }) {
  if (assets.length === 0) return null;
  const sorted = [...assets].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.name.localeCompare(b.name),
  );
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-base-content">Assets contributed by this repo</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-base-300 text-left text-base-content/60">
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
                  className={clsx(
                    "inline-block rounded px-1.5 py-0.5 text-[11px] font-medium",
                    a.shadowsDefault ? "bg-warning/20 text-warning" : "bg-success/20 text-success",
                  )}
                >
                  {a.shadowsDefault ? "shadows instance" : "added"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function RepoConfigPane({ repo }: { repo: string }) {
  const [data, setData] = useState<RepoConfigBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (refresh: boolean) => {
      setBusy(true);
      return api
        .repoConfig(repo, { refresh })
        .then((res) => { setData(res); setError(null); })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false));
    },
    [repo],
  );

  // Re-read on repo change; the harness's own 60s TTL keeps this cheap, and the
  // Refresh button is the escape hatch after a `.lastlight/` change lands.
  useEffect(() => {
    setData(null);
    setError(null);
    void load(false);
  }, [load]);

  if (error) {
    return (
      <div className="flex-1 overflow-auto p-4">
        <div className="rounded border border-error/30 bg-error/10 p-3 text-sm text-error">{error}</div>
      </div>
    );
  }
  if (!data) {
    return <div className="flex-1 p-4 text-sm text-base-content/60">Loading repository configuration…</div>;
  }

  const leaves = toLeaves(data);
  const fromRepo = leaves.filter((l) => l.source === "repo").length;

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* ── Layer status ─────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <div className="flex-1">
          {data.repoLayer || data.assets.length > 0 ? (
            <div className="rounded border border-base-300 ll-surface p-3 text-sm text-base-content/70">
              <span className="font-medium text-base-content">{repo}</span> commits a{" "}
              <code className="text-xs">.lastlight/</code> layer, read from{" "}
              <code className="text-xs">{data.defaultBranch ?? "the default branch"}</code>
              {data.treeSha && <> at <code className="text-xs">{data.treeSha.slice(0, 7)}</code></>}
              {data.fetchedAt && <> · fetched {new Date(data.fetchedAt).toLocaleString()}</>}.
              <div className="mt-1 text-xs text-base-content/60">
                {fromRepo === 0
                  ? "No effective value currently comes from the repo."
                  : `${fromRepo} of ${leaves.length} effective values come from this repo.`}
              </div>
            </div>
          ) : (
            <div className="rounded border border-base-300 ll-surface p-3 text-sm text-base-content/70">
              No repo config — <span className="font-medium text-base-content">{repo}</span> has no{" "}
              <code className="text-xs">.lastlight/</code> directory on its default branch, so it
              inherits the instance configuration in full. Commit{" "}
              <code className="text-xs">.lastlight/lastlight.yml</code> to override the keys the
              operator allows (see Policy below).
            </div>
          )}
        </div>
        <button
          onClick={() => void load(true)}
          disabled={busy}
          className="btn btn-xs h-7 min-h-0 btn-ghost gap-1 text-base-content/60"
          title="Re-read .lastlight/ from the default branch now, bypassing the 60s cache"
        >
          <ArrowPathIcon className={clsx("h-3.5 w-3.5", busy && "animate-spin")} />
          Refresh
        </button>
      </div>

      {/* Warnings sit above the values: a repo owner whose lastlight.yml has a
          typo must not have to hunt for why nothing changed. */}
      <WarningsBlock warnings={data.warnings} />

      {/* ── Effective config ─────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-2 text-xs font-semibold text-base-content">
          Effective configuration for this repo
        </h3>
        {leaves.length === 0 ? (
          <div className="rounded border border-base-300 ll-surface p-3 text-sm text-base-content/70">
            No repo-settable values are configured on this instance.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-base-300 text-left text-base-content/60">
                <th className="py-1.5 pr-4 font-medium">Key</th>
                <th className="py-1.5 pr-4 font-medium">Value</th>
                <th className="py-1.5 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {leaves.map((leaf) => (
                <tr
                  key={leaf.path}
                  className={clsx(
                    "border-b border-base-300/50",
                    // Second, non-badge signal for the same fact — scannable
                    // without reading the Source column.
                    leaf.source === "repo" && "bg-secondary/10",
                  )}
                >
                  <td
                    className={clsx(
                      "py-1.5 pr-4 font-mono text-base-content",
                      leaf.source === "repo" && "border-l-2 border-secondary pl-2",
                    )}
                  >
                    {leaf.path}
                  </td>
                  <td className="py-1.5 pr-4 font-mono text-base-content/80">{renderValue(leaf.value)}</td>
                  <td className="py-1.5">
                    <SourceBadge source={leaf.source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <AssetsBlock assets={data.assets} />

      {/* ── Raw lastlight.yml ────────────────────────────────────────────── */}
      {data.repoLayer && (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-base-content">
            Committed <code className="text-[11px]">.lastlight/lastlight.yml</code>
          </h3>
          <p className="mb-2 text-[11px] text-base-content/50">
            As committed, before validation — compare against the warnings above. Secret-looking
            keys are redacted.
          </p>
          <pre className="overflow-auto whitespace-pre-wrap rounded border border-base-300 ll-surface p-4 text-xs leading-relaxed text-base-content">
            {pretty(data.repoLayer)}
          </pre>
        </section>
      )}

      {/* ── Operator bounds ──────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-2 text-xs font-semibold text-base-content">Policy (operator bounds)</h3>
        <p className="mb-2 text-[11px] text-base-content/50">
          {data.policy.enabled
            ? "What a repo is allowed to set on this instance — anything outside these bounds is dropped with a warning."
            : "Per-repository configuration is DISABLED on this instance; committed .lastlight/ config is ignored."}
        </p>
        <pre className="overflow-auto whitespace-pre-wrap rounded border border-base-300 ll-surface p-4 text-xs leading-relaxed text-base-content">
          {pretty(data.policy)}
        </pre>
      </section>
    </div>
  );
}
