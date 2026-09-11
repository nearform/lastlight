import { useEffect, useState } from "react";
import { api } from "../api";

interface ArtifactVideoViewerProps {
  /** GitHub owner. */
  owner: string;
  /** Bare repository name. */
  repo: string;
  /** issueKey (build-asset run key). */
  docKey: string;
  /** Video doc filename, e.g. demo.mp4. */
  doc: string;
}

/**
 * Read-only viewer for binary video artifacts (the `/demo` workflow's mp4/webm).
 * Fetches the artifact as a Blob via the authenticated API, turns it into an
 * object URL, and renders it in a <video controls>. The object URL is revoked on
 * unmount / doc change so blobs don't leak. Seeking works client-side off the
 * in-memory blob; the artifacts are small (≤ a few MB). Mirrors
 * {@link ArtifactImageViewer}; markdown docs go through ArtifactEditor instead.
 */
export function ArtifactVideoViewer({ owner, repo, docKey, doc }: ArtifactVideoViewerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoFull = owner && repo ? `${owner}/${repo}` : "";

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    if (!owner || !repo || !docKey || !doc) return;
    setLoading(true);
    api.getArtifactBlob(owner, repo, docKey, doc)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [owner, repo, docKey, doc]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-base-content">{doc}</h2>
          {repoFull && docKey && (
            <p className="truncate text-[11px] text-muted">{repoFull} · {docKey}</p>
          )}
        </div>
        <span className="text-[11px] text-muted">Read-only evidence</span>
      </div>

      {error && (
        <div className="m-3 rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
          {error}
        </div>
      )}

      <div className="flex flex-1 items-center justify-center overflow-auto bg-base-300/40 p-6">
        {loading ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : url ? (
          <video
            src={url}
            controls
            className="max-h-full max-w-full rounded border border-hairline bg-base-100 object-contain shadow"
          />
        ) : !error ? (
          <div className="text-sm text-faint">No video to display.</div>
        ) : null}
      </div>
    </div>
  );
}
