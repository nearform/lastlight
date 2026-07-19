import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { api, type RepoEntry } from "../api";
import { WorkflowList } from "./WorkflowList";
import { ArtifactsPage } from "./ArtifactsPage";
import { GhLink } from "./GhLink";
import { repoUrl } from "../lib/githubLinks";
import {
  useUrlState,
  stringParser,
  stringSerializer,
  enumParser,
  enumSerializer,
} from "../hooks/useUrlState";

/**
 * Repos tab — a repo-centric way to navigate the instance. The left pane lists
 * the effective managed repos (∪ repos with activity), annotated with run +
 * artifact counts and sorted newest-activity first (served by GET /repos).
 * Selecting one opens a detail pane with two sub-tabs that REUSE the existing
 * views, scoped to the repo:
 *   • Workflows → {@link WorkflowList} with a server-side `repo` filter;
 *   • Assets    → {@link ArtifactsPage} locked to the repo (picker hidden).
 *
 * A team filter (GitHub team → repo grants) is a follow-up that rides on the
 * team tables from issue #169 — see the placeholder above the list.
 *
 * Deep-link params: ?tab=repos&repo=<owner/repo>&rtab=workflows|assets.
 */

const REPO_TABS = ["workflows", "assets"] as const;
type RepoTab = (typeof REPO_TABS)[number];

/** Relative age of an ISO timestamp — "3h", "2d" (mirrors WorkflowList). */
function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

interface ReposPageProps {
  /** Header date filter — forwarded to the scoped Workflows / Assets views. */
  timeRange: string;
  /** Header free-text search — filters the repo list, and forwarded down. */
  query: string;
}

export function ReposPage({ timeRange, query }: ReposPageProps) {
  // `repo` is the same URL param the embedded ArtifactsPage reads, so a locked
  // Assets sub-tab agrees with the selected repo without extra prop threading.
  const [repo, setRepo] = useUrlState<string>("repo", "", stringParser, stringSerializer);
  const [rtab, setRtab] = useUrlState<RepoTab>(
    "rtab",
    "workflows",
    enumParser(REPO_TABS, "workflows"),
    enumSerializer<RepoTab>("workflows"),
  );

  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Poll so run counts / last-activity stay live while the tab is open.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .repos()
        .then((res) => { if (!cancelled) { setRepos(res.repos); setError(null); } })
        .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    };
    load();
    const timer = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const visibleRepos = useMemo(() => {
    if (!query) return repos;
    const q = query.toLowerCase();
    return repos.filter((r) => r.repo.toLowerCase().includes(q));
  }, [repos, query]);

  return (
    <div className="flex flex-1 overflow-hidden bg-base-100">
      {/* ── Repo list ──────────────────────────────────────────────────── */}
      <div className="w-72 shrink-0 border-r border-base-300 flex flex-col overflow-hidden">
        <div className="border-b border-base-300 px-3 py-3">
          <div className="text-xs font-semibold text-base-content/70">Repositories</div>
          {/* Phase 2 (issue #169): a GitHub-team filter <select> lands here,
              populated from the team→repo grants once those tables exist. */}
        </div>
        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-2 rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
              {error}
            </div>
          )}
          {visibleRepos.length === 0 && !error ? (
            <div className="p-3 text-xs text-base-content/50">
              {query ? "No repositories match your search." : "No repositories."}
            </div>
          ) : (
            <ul className="py-1">
              {visibleRepos.map((r) => {
                const active = r.repo === repo;
                const href = repoUrl(r.repo);
                return (
                  <li key={r.repo}>
                    {/* role="button" (not <button>) so the GitHub link below can
                        be a real <a> without nesting interactive elements. */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setRepo(r.repo)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setRepo(r.repo);
                        }
                      }}
                      className={clsx(
                        "flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left text-xs",
                        active
                          ? "bg-primary/10 text-primary"
                          : "text-base-content/80 hover:bg-base-300/50",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex-1 truncate font-medium">{r.repo}</span>
                        {href && (
                          <GhLink
                            href={href}
                            className="shrink-0 text-base-content/40 hover:text-primary"
                            title={`Open ${r.repo} on GitHub`}
                          >
                            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                          </GhLink>
                        )}
                        {r.lastRunAt && (
                          <span className="shrink-0 text-[10px] text-base-content/40">
                            {timeAgo(r.lastRunAt)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-base-content/50">
                        <span>{r.runCount} run{r.runCount === 1 ? "" : "s"}</span>
                        {r.artifactKeyCount > 0 && <span>· {r.artifactKeyCount} asset{r.artifactKeyCount === 1 ? "" : "s"}</span>}
                        {!r.managed && (
                          <span className="ml-auto rounded bg-base-200 px-1 text-[9px] text-base-content/40">
                            unmanaged
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ── Repo detail ────────────────────────────────────────────────── */}
      {repo ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Sub-tab strip */}
          <div className="flex items-center gap-2 border-b border-base-300 bg-base-200/40 px-4 py-2 shrink-0">
            {(() => {
              const href = repoUrl(repo);
              const cls = "text-sm font-semibold text-base-content font-mono";
              return href ? (
                <GhLink href={href} className={cls} title={`Open ${repo} on GitHub`}>
                  {repo}
                </GhLink>
              ) : (
                <span className={cls}>{repo}</span>
              );
            })()}
            <div className="ml-4 flex gap-1">
              {REPO_TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setRtab(t)}
                  className={clsx(
                    "btn btn-xs h-7 min-h-0 font-medium capitalize",
                    rtab === t ? "btn-primary" : "btn-ghost text-base-content/60",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-1 overflow-hidden">
            {rtab === "workflows" ? (
              <WorkflowList repo={repo} timeRange={timeRange} query={query} />
            ) : (
              <ArtifactsPage lockedRepo={repo} timeRange={timeRange} query={query} />
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-base-content/30">
          select a repository
        </div>
      )}
    </div>
  );
}
