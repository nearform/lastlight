import { useCallback, useEffect, useState } from "react";
import {
  api,
  isImageArtifact,
  isVideoArtifact,
  type ArtifactRepoEntry,
  type ArtifactKeyEntry,
} from "../api";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { ArtifactEditor } from "./ArtifactEditor";
import { ArtifactImageViewer } from "./ArtifactImageViewer";
import { ArtifactVideoViewer } from "./ArtifactVideoViewer";
import { GhLink } from "./GhLink";
import { repoUrl } from "../lib/githubLinks";
import {
  useUrlState,
  stringParser,
  stringSerializer,
} from "../hooks/useUrlState";
import { timeRangeToSince } from "../lib/timeRange";

/**
 * Build-assets ("Artifacts") tab. Browses the server-mode handoff docs
 * (architect-plan.md, status.md, executor-summary.md, …) that live under
 * $STATE_DIR/build-assets/<owner>/<repo>/<issueKey>/*.md and lets an operator
 * edit + save them via the shared {@link ArtifactEditor}.
 *
 * The left pane is a two-level browser served entirely from the store:
 *   • no repo selected → the repos that actually have artifacts (the header
 *     search filters them; always shown regardless of age so it can't go empty
 *     under the default 24h window);
 *   • a repo selected → that repo's run keys, newest first, filtered by the
 *     header time range + search, each showing its age.
 * Both levels page in with "load more" so a busy store never dumps thousands of
 * rows at once.
 *
 * Deep-link params (set by server-mode PR links via {{artifactUrl}}):
 *   ?tab=repos&rtab=assets&repo=<owner>/<repo>&key=<issueKey>&doc=<file>
 * land directly on the selected doc (this page renders as the Repos tab's
 * Assets sub-tab, locked to the repo).
 *
 * When no store is configured (repo mode) the list endpoints report empty and
 * the page degrades to a clear empty state rather than erroring.
 */

const PAGE_SIZE = 50;

/** Relative age of an ISO timestamp — "3h", "2d" (mirrors WorkflowList). */
function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

interface ArtifactsPageProps {
  /** Header date filter (hour/day/week/all/live) — scopes the run-key list. */
  timeRange: string;
  /** Header free-text search — filters the repo list, or the key list once a
   *  repo is selected. */
  query: string;
  /**
   * When set, pin the page to this `owner/repo` — the repo-browser level and
   * its picker/back controls are hidden and the left pane jumps straight to the
   * repo's run keys. Used to embed the page inside the Repos tab's repo detail.
   */
  lockedRepo?: string;
}

export function ArtifactsPage({ timeRange, query, lockedRepo }: ArtifactsPageProps) {
  const [repo, setRepo] = useUrlState<string>("repo", "", stringParser, stringSerializer);
  const [key, setKey] = useUrlState<string>("key", "", stringParser, stringSerializer);
  const [doc, setDoc] = useUrlState<string>("doc", "", stringParser, stringSerializer);

  // When locked, the fixed repo wins over the URL `repo` param so the embed is
  // decoupled from the browser's own repo state.
  const effectiveRepo = lockedRepo || repo;

  const [repoInput, setRepoInput] = useState(repo);

  const [repos, setRepos] = useState<ArtifactRepoEntry[]>([]);
  const [repoTotal, setRepoTotal] = useState(0);
  const [repoLimit, setRepoLimit] = useState(PAGE_SIZE);

  const [keys, setKeys] = useState<ArtifactKeyEntry[]>([]);
  const [keyTotal, setKeyTotal] = useState(0);
  const [keyLimit, setKeyLimit] = useState(PAGE_SIZE);

  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [owner, name] = effectiveRepo.includes("/") ? effectiveRepo.split("/", 2) : ["", ""];
  // When locked to a repo, never show the repo-browsing level.
  const browsingRepos = !lockedRepo && (!repo || !repo.includes("/"));

  // ── Reset paging when the search / repo / time window changes ────────────
  useEffect(() => { setRepoLimit(PAGE_SIZE); }, [query]);
  useEffect(() => { setKeyLimit(PAGE_SIZE); }, [effectiveRepo, query, timeRange]);

  // ── Load the repo list while no repo is selected ─────────────────────────
  useEffect(() => {
    if (!browsingRepos) return;
    let cancelled = false;
    setError(null);
    api.listArtifactRepos({ q: query, limit: repoLimit })
      .then((res) => { if (!cancelled) { setRepos(res.repos); setRepoTotal(res.total); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [browsingRepos, query, repoLimit]);

  // ── Load the run keys for the selected repo ──────────────────────────────
  useEffect(() => {
    if (browsingRepos) { setKeys([]); setKeyTotal(0); return; }
    let cancelled = false;
    setError(null);
    api.listArtifactKeys(effectiveRepo, { q: query, since: timeRangeToSince(timeRange), limit: keyLimit })
      .then((res) => { if (!cancelled) { setKeys(res.keys); setKeyTotal(res.total); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [browsingRepos, effectiveRepo, query, timeRange, keyLimit]);

  // ── Load doc filenames for the expanded key ──────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (browsingRepos || !key) { setFiles([]); return; }
    api.listArtifactFiles(owner, name, key)
      .then((res) => { if (!cancelled) setFiles(res.files); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [browsingRepos, effectiveRepo, key, owner, name]);

  const openRepo = useCallback((slug: string) => {
    setRepoInput(slug);
    setKey("");
    setDoc("");
    setRepo(slug);
  }, [setRepo, setKey, setDoc]);

  const applyRepo = useCallback(() => {
    openRepo(repoInput.trim());
  }, [repoInput, openRepo]);

  const backToRepos = useCallback(() => {
    setRepoInput("");
    setKey("");
    setDoc("");
    setRepo("");
  }, [setRepo, setKey, setDoc]);

  return (
    <div className="flex flex-1 overflow-hidden bg-base-100">
      {/* ── Left list pane ──────────────────────────────────────────────── */}
      <div className="w-72 shrink-0 border-r border-base-300 flex flex-col overflow-hidden">
        {/* When locked to a repo (embedded in the Repos tab), the repo picker
            and "all repositories" back-link are hidden — the parent owns repo
            selection. Just show the run-key list. */}
        {!lockedRepo && (
          <div className="border-b border-base-300 px-3 py-3 space-y-2">
            <label className="text-xs font-semibold text-base-content/70">Repository</label>
            <div className="flex gap-1">
              <input
                type="text"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applyRepo(); }}
                placeholder="owner/repo"
                className="flex-1 min-w-0 rounded border border-base-300 bg-base-200 px-2 py-1 text-xs"
              />
              <button
                onClick={applyRepo}
                className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-content hover:bg-primary/90"
              >
                Go
              </button>
            </div>
            {!browsingRepos && (
              <button
                onClick={backToRepos}
                className="text-[11px] text-base-content/60 hover:text-base-content"
              >
                ← All repositories
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-2 rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
              {error}
            </div>
          )}

          {browsingRepos ? (
            /* ── Repo list ─────────────────────────────────────────────── */
            repos.length === 0 && !error ? (
              <div className="p-3 text-xs text-base-content/50">
                {query ? "No repositories match your search." : "No repositories have stored artifacts."}
              </div>
            ) : (
              <>
                <ul className="py-1">
                  {repos.map((r) => {
                    const href = repoUrl(`${r.owner}/${r.repo}`);
                    return (
                      <li key={r.slug}>
                        {/* role="button" (not <button>) so the GitHub link can
                            be a real <a> without nesting interactive elements. */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => openRepo(r.slug)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openRepo(r.slug);
                            }
                          }}
                          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-base-content/80 hover:bg-base-300/50"
                        >
                          <span className="flex-1 truncate font-medium">{r.slug}</span>
                          {href && (
                            <GhLink
                              href={href}
                              className="shrink-0 text-base-content/40 hover:text-primary"
                              title={`Open ${r.owner}/${r.repo} on GitHub`}
                            >
                              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                            </GhLink>
                          )}
                          <span className="shrink-0 rounded bg-base-200 px-1 text-[10px] text-base-content/60">
                            {r.keyCount}
                          </span>
                          <span className="shrink-0 text-[10px] text-base-content/40">
                            {timeAgo(r.updatedAt)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <ListFooter shown={repos.length} total={repoTotal} onLoadMore={() => setRepoLimit((l) => l + PAGE_SIZE)} />
              </>
            )
          ) : (
            /* ── Run keys for the selected repo ────────────────────────── */
            keys.length === 0 && !error ? (
              <div className="p-3 text-xs text-base-content/50">
                {query || timeRange !== "all"
                  ? "No artifacts match the current search / time range."
                  : "No build assets stored for this repo."}
              </div>
            ) : (
              <>
                <ul className="py-1">
                  {keys.map((k) => {
                    const isOpen = k.key === key;
                    return (
                      <li key={k.key}>
                        <button
                          onClick={() => { setDoc(""); setKey(isOpen ? "" : k.key); }}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium ${
                            isOpen ? "bg-primary/10 text-primary" : "text-base-content/80 hover:bg-base-300/50"
                          }`}
                        >
                          <span className="flex-1 truncate">{k.key}</span>
                          <span className="shrink-0 text-[10px] text-base-content/40">
                            {timeAgo(k.updatedAt)}
                          </span>
                        </button>
                        {isOpen && (
                          <ul className="pb-1">
                            {files.length === 0 ? (
                              <li className="px-5 py-1 text-[11px] text-base-content/40">No docs</li>
                            ) : (
                              files.map((f) => (
                                <li key={f}>
                                  <button
                                    onClick={() => setDoc(f)}
                                    className={`w-full text-left px-5 py-1 text-[11px] truncate ${
                                      f === doc
                                        ? "text-primary font-semibold"
                                        : "text-base-content/60 hover:text-base-content"
                                    }`}
                                  >
                                    {f}
                                  </button>
                                </li>
                              ))
                            )}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <ListFooter shown={keys.length} total={keyTotal} onLoadMore={() => setKeyLimit((l) => l + PAGE_SIZE)} />
              </>
            )
          )}
        </div>
      </div>

      {/* ── Main pane — image/video viewer for evidence, else editor ───── */}
      {doc && isImageArtifact(doc) ? (
        <ArtifactImageViewer owner={owner} repo={name} docKey={key} doc={doc} />
      ) : doc && isVideoArtifact(doc) ? (
        <ArtifactVideoViewer owner={owner} repo={name} docKey={key} doc={doc} />
      ) : (
        <ArtifactEditor owner={owner} repo={name} docKey={key} doc={doc} />
      )}
    </div>
  );
}

/** Shared "{shown} / {total}" footer with a load-more button. */
function ListFooter({ shown, total, onLoadMore }: { shown: number; total: number; onLoadMore: () => void }) {
  if (total === 0) return null;
  const hasMore = shown < total;
  return (
    <div className="sticky bottom-0 border-t border-base-300 bg-base-100 px-3 py-1.5 text-[11px] text-base-content/50">
      {hasMore ? (
        <button onClick={onLoadMore} className="text-primary hover:underline">
          Load more · {shown} / {total}
        </button>
      ) : (
        <span>{shown} / {total}</span>
      )}
    </div>
  );
}
