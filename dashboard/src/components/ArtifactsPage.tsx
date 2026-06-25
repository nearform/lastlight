import { useCallback, useEffect, useRef, useState } from "react";
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
import { api } from "../api";
import {
  useUrlState,
  stringParser,
  stringSerializer,
} from "../hooks/useUrlState";

/**
 * Build-assets ("Artifacts") tab. Browses the server-mode handoff docs
 * (architect-plan.md, status.md, executor-summary.md, …) that live under
 * $STATE_DIR/build-assets/<owner>/<repo>/<issueKey>/*.md and lets an operator
 * edit + save them with a markdown editor.
 *
 * Deep-link params (set by server-mode PR links):
 *   ?tab=artifacts&repo=<owner>/<repo>&key=<issueKey>&doc=<file>
 * land directly on the selected doc.
 *
 * When no store is configured (repo mode) the list endpoints report empty and
 * the page degrades to a clear empty state rather than erroring.
 */
export function ArtifactsPage() {
  const [repo, setRepo] = useUrlState<string>("repo", "", stringParser, stringSerializer);
  const [key, setKey] = useUrlState<string>("key", "", stringParser, stringSerializer);
  const [doc, setDoc] = useUrlState<string>("doc", "", stringParser, stringSerializer);

  const [managedRepos, setManagedRepos] = useState<string[]>([]);
  const [repoInput, setRepoInput] = useState(repo);

  const [keys, setKeys] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);

  const [content, setContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const editorRef = useRef<MDXEditorMethods>(null);

  const dirty = content !== savedContent;

  // ── Populate the repo picker from the managed-repos config ───────────────
  useEffect(() => {
    let cancelled = false;
    api.config()
      .then((c) => {
        if (cancelled) return;
        const merged = c.merged as { managedRepos?: unknown };
        const repos = Array.isArray(merged.managedRepos)
          ? merged.managedRepos.filter((r): r is string => typeof r === "string")
          : [];
        setManagedRepos(repos);
      })
      .catch(() => { /* repo picker falls back to the text input */ });
    return () => { cancelled = true; };
  }, []);

  // ── Load keys whenever the repo changes ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!repo || !repo.includes("/")) {
      setKeys([]);
      return;
    }
    api.listArtifactKeys(repo)
      .then((res) => { if (!cancelled) setKeys(res.keys); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [repo]);

  // ── Load files whenever the key changes ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!repo || !repo.includes("/") || !key) {
      setFiles([]);
      return;
    }
    const [owner, name] = repo.split("/", 2);
    api.listArtifactFiles(owner, name, key)
      .then((res) => { if (!cancelled) setFiles(res.files); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [repo, key]);

  // ── Load the selected doc into the editor ────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!repo || !repo.includes("/") || !key || !doc) {
      setContent("");
      setSavedContent("");
      return;
    }
    const [owner, name] = repo.split("/", 2);
    setLoadingDoc(true);
    setSaveError(null);
    setSavedAt(null);
    api.getArtifact(owner, name, key, doc)
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
  }, [repo, key, doc]);

  const applyRepo = useCallback(() => {
    const next = repoInput.trim();
    setKey("");
    setDoc("");
    setRepo(next);
  }, [repoInput, setRepo, setKey, setDoc]);

  const handleRevert = useCallback(() => {
    setContent(savedContent);
    editorRef.current?.setMarkdown(savedContent);
    setSaveError(null);
  }, [savedContent]);

  const handleSave = useCallback(async () => {
    if (!repo || !repo.includes("/") || !key || !doc) return;
    const [owner, name] = repo.split("/", 2);
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveArtifact(owner, name, key, doc, content);
      setSavedContent(content);
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [repo, key, doc, content]);

  return (
    <div className="flex flex-1 overflow-hidden bg-base-100">
      {/* ── Left list pane ──────────────────────────────────────────────── */}
      <div className="w-72 shrink-0 border-r border-base-300 flex flex-col overflow-hidden">
        <div className="border-b border-base-300 px-3 py-3 space-y-2">
          <label className="text-xs font-semibold text-base-content/70">Repository</label>
          <div className="flex gap-1">
            <input
              type="text"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applyRepo(); }}
              placeholder="owner/repo"
              list="artifact-managed-repos"
              className="flex-1 min-w-0 rounded border border-base-300 bg-base-200 px-2 py-1 text-xs"
            />
            <datalist id="artifact-managed-repos">
              {managedRepos.map((r) => <option key={r} value={r} />)}
            </datalist>
            <button
              onClick={applyRepo}
              className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-content hover:bg-primary/90"
            >
              Go
            </button>
          </div>
          {managedRepos.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {managedRepos.map((r) => (
                <button
                  key={r}
                  onClick={() => { setRepoInput(r); setKey(""); setDoc(""); setRepo(r); }}
                  className={`rounded px-1.5 py-0.5 text-[11px] ${
                    r === repo
                      ? "bg-primary/20 text-primary"
                      : "bg-base-200 text-base-content/70 hover:bg-base-300"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-2 rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
              {error}
            </div>
          )}
          {repo && keys.length === 0 && !error ? (
            <div className="p-3 text-xs text-base-content/50">
              No build assets stored for this repo.
            </div>
          ) : (
            <ul className="py-1">
              {keys.map((k) => {
                const isOpen = k === key;
                return (
                  <li key={k}>
                    <button
                      onClick={() => { setDoc(""); setKey(isOpen ? "" : k); }}
                      className={`w-full text-left px-3 py-1.5 text-xs font-medium truncate ${
                        isOpen ? "bg-primary/10 text-primary" : "text-base-content/80 hover:bg-base-300/50"
                      }`}
                    >
                      {k}
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
          )}
        </div>
      </div>

      {/* ── Main editor pane ────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-base-300 px-4 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-base-content">
              {doc ? doc : "Artifacts"}
            </h2>
            {repo && key && (
              <p className="truncate text-[11px] text-base-content/50">{repo} · {key}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {dirty ? (
              <span className="text-[11px] text-warning">Unsaved changes</span>
            ) : savedAt ? (
              <span className="text-[11px] text-success">Saved</span>
            ) : null}
            {dirty && (
              <button
                onClick={handleRevert}
                disabled={saving}
                className="rounded border border-base-300 px-3 py-1 text-xs font-medium text-base-content/80 hover:bg-base-300 disabled:opacity-40"
              >
                Revert
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!doc || !dirty || saving}
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-content hover:bg-primary/90 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {saveError && (
          <div className="m-3 rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
            Save failed: {saveError}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {!doc ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-base-content/40">
              {repo
                ? "Select a build asset doc to view or edit."
                : "Enter a repository (owner/repo) to browse its build assets."}
            </div>
          ) : loadingDoc ? (
            <div className="p-6 text-sm text-base-content/50">Loading…</div>
          ) : (
            <MDXEditor
              ref={editorRef}
              key={`${repo}/${key}/${doc}`}
              markdown={content}
              onChange={(md) => setContent(md)}
              className="dark-theme"
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
          )}
        </div>
      </div>
    </div>
  );
}
