import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { api, ArtifactLockedError, type ArtifactMetadata, type ArtifactLock } from "../api";
import { useTheme } from "../hooks/useTheme";
import { Markdown } from "./timeline/Markdown";

interface ArtifactEditorProps {
  /** GitHub owner. */
  owner: string;
  /** Bare repository name. */
  repo: string;
  /** issueKey (build-asset run key). */
  docKey: string;
  /** Doc filename, e.g. architect-plan.md. Empty → placeholder. */
  doc: string;
}

/**
 * The build-asset markdown editor — load / edit / revert / save for one
 * server-mode handoff doc, with an MDXEditor and a header toolbar. Extracted
 * from ArtifactsPage so the focused approval view can reuse the exact same
 * editing surface. Renders the right-hand "editor pane" (header + body);
 * callers supply whatever surrounds it (a list pane, an approval footer, …).
 */
export function ArtifactEditor({ owner, repo, docKey, doc }: ArtifactEditorProps) {
  const [content, setContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [metadata, setMetadata] = useState<ArtifactMetadata | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);

  const editorRef = useRef<MDXEditorMethods>(null);
  const { isDark } = useTheme();
  const ready = !!owner && !!repo && !!docKey && !!doc;
  const canEdit = !!(metadata && metadata.editable) && !metadataLoading;
  const dirty = canEdit && content !== savedContent;
  const repoFull = owner && repo ? `${owner}/${repo}` : "";

  const statusLabel = useMemo(() => {
    if (!ready) return null;
    if (metadataLoading) {
      return <span className="text-[11px] text-base-content/50">Checking approval…</span>;
    }
    if (canEdit) {
      if (dirty) return <span className="text-[11px] text-warning">Unsaved changes</span>;
      if (savedAt) return <span className="text-[11px] text-success">Saved</span>;
      return null;
    }
    if (metadata?.lock) {
      return <span className="text-[11px] text-base-content/60">Read-only</span>;
    }
    return null;
  }, [ready, metadataLoading, canEdit, dirty, savedAt, metadata]);

  const showEditor = canEdit && !loadingDoc;
  const lockDescription = useMemo(
    () => (metadata?.lock ? describeLock(metadata.lock, doc) : null),
    [metadata, doc],
  );

  // ── Match the portaled toolbar popups to the active theme ────────────────
  // MDXEditor's BlockTypeSelect (and other Radix selects) render their dropdown
  // into a portal on document.body — outside the editor's own theme root. The
  // `.dark-theme` class defines only CSS variables consumed by MDXEditor, so
  // scoping it to <body> while a dark-theme editor is mounted recolors the
  // portaled popups without affecting the rest of the app. In the light
  // (neaform) theme we leave it off so MDXEditor uses its default light styling.
  useEffect(() => {
    if (!isDark) return;
    document.body.classList.add("dark-theme");
    return () => { document.body.classList.remove("dark-theme"); };
  }, [isDark]);

  // ── Load the selected doc into the editor ────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!ready) {
      setContent("");
      setSavedContent("");
      return;
    }
    setLoadingDoc(true);
    setError(null);
    setSaveError(null);
    setSavedAt(null);
    api.getArtifact(owner, repo, docKey, doc)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setSavedContent(text);
        editorRef.current?.setMarkdown(text);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoadingDoc(false); });
    return () => { cancelled = true; };
  }, [owner, repo, docKey, doc, ready]);

  useEffect(() => {
    let cancelled = false;
    if (!ready) {
      setMetadata(null);
      setMetadataError(null);
      setMetadataLoading(false);
      return;
    }
    setMetadataLoading(true);
    setMetadataError(null);
    setMetadata(null);
    api.artifactMetadata(owner, repo, docKey, doc)
      .then((meta) => {
        if (!cancelled) setMetadata(meta);
      })
      .catch((err) => {
        if (!cancelled) {
          setMetadataError(err instanceof Error ? err.message : String(err));
          setMetadata(null);
        }
      })
      .finally(() => {
        if (!cancelled) setMetadataLoading(false);
      });
    return () => { cancelled = true; };
  }, [owner, repo, docKey, doc, ready]);

  const handleRevert = useCallback(() => {
    if (!canEdit) return;
    setContent(savedContent);
    editorRef.current?.setMarkdown(savedContent);
    setSaveError(null);
  }, [canEdit, savedContent]);

  const handleSave = useCallback(async () => {
    if (!ready || !canEdit) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveArtifact(owner, repo, docKey, doc, content);
      setSavedContent(content);
      setSavedAt(Date.now());
      setMetadata((prev) => (prev ? { ...prev, editable: true, lock: null } : prev));
    } catch (err) {
      if (err instanceof ArtifactLockedError) {
        setSaveError(describeLock(err.lock, doc));
        setMetadata({ editable: false, lock: err.lock });
      } else {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }, [owner, repo, docKey, doc, content, ready, canEdit]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-base-300 px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-base-content">
            {doc ? doc : "Artifacts"}
          </h2>
          {repoFull && docKey && (
            <p className="truncate text-[11px] text-base-content/50">{repoFull} · {docKey}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {statusLabel}
          {canEdit && dirty && (
            <button
              onClick={handleRevert}
              disabled={saving}
              className="rounded border border-base-300 px-3 py-1 text-xs font-medium text-base-content/80 hover:bg-base-300 disabled:opacity-40"
            >
              Revert
            </button>
          )}
          {canEdit && (
            <button
              onClick={handleSave}
              disabled={!ready || !dirty || saving || metadataLoading}
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-content hover:bg-primary/90 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>

      {(error || saveError || metadataError) && (
        <div className="m-3 space-y-1 rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
          {error && <p>Failed to load document: {error}</p>}
          {metadataError && <p>Metadata error: {metadataError}</p>}
          {saveError && <p>Save failed: {saveError}</p>}
        </div>
      )}

      {metadata?.lock && lockDescription && (
        <div className="mx-3 rounded border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <p className="font-semibold">Document locked</p>
          <p className="mt-1 text-warning/90">{lockDescription}</p>
          {metadata.lock.approval && (
            <div className="mt-2 space-y-1 text-[11px] text-warning/80">
              <p>
                Latest approval ({metadata.lock.approval.status})
                {metadata.lock.approval.gate ? ` · ${metadata.lock.approval.gate}` : ""}
              </p>
              {metadata.lock.approval.respondedBy && (
                <p>
                  Responded by {metadata.lock.approval.respondedBy}
                  {metadata.lock.approval.respondedAt ?
                    ` on ${formatTimestamp(metadata.lock.approval.respondedAt)}` : ""}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {!doc ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-base-content/40">
            {repoFull
              ? "Select a build asset doc to view or edit."
              : "Enter a repository (owner/repo) to browse its build assets."}
          </div>
        ) : loadingDoc ? (
          <div className="p-6 text-sm text-base-content/50">Loading…</div>
        ) : showEditor ? (
          <MDXEditor
            ref={editorRef}
            key={`${owner}/${repo}/${docKey}/${doc}`}
            markdown={content}
            onChange={(md) => setContent(md)}
            className={isDark ? "dark-theme" : undefined}
            contentEditableClassName="ll-prose ll-prose-editor"
            plugins={[
              headingsPlugin(),
              listsPlugin(),
              quotePlugin(),
              thematicBreakPlugin(),
              linkPlugin(),
              markdownShortcutPlugin(),
              toolbarPlugin({
                toolbarContents: () => (
                  <>
                    <UndoRedo />
                    <BoldItalicUnderlineToggles />
                    <BlockTypeSelect />
                    <ListsToggle />
                    <CreateLink />
                  </>
                ),
              }),
            ]}
          />
        ) : (
          <div className="h-full overflow-auto p-4">
            <Markdown source={content} className="ll-prose-editor" />
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  } catch {
    return iso;
  }
}

function describeLock(lock: ArtifactLock, doc: string): string {
  const target = doc ? `“${doc}”` : "this document";
  switch (lock.reason) {
    case "no_matching_approval":
      return lock.message ?? `No pending approval references ${target}.`;
    case "unverified_owner":
      return lock.message ?? `Could not verify the owner, repo, or issue for the latest approval on ${target}.`;
    case "approval_resolved": {
      const responderText = lock.approval?.respondedBy ? ` by ${lock.approval.respondedBy}` : "";
      return `Editing is disabled because the latest approval for ${target} was already approved${responderText}.`;
    }
    case "approval_rejected": {
      const responderText = lock.approval?.respondedBy ? ` by ${lock.approval.respondedBy}` : "";
      return `Editing is disabled because the latest approval for ${target} was rejected${responderText}.`;
    }
    default:
      return lock.message ?? `Editing is disabled for ${target}.`;
  }
}
