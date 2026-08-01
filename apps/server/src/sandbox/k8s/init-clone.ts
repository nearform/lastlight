import type { V1Container } from "@kubernetes/client-node";

export interface CloneSpec {
  owner: string;
  repo: string;
  branch: string;
  cwd: string; // workspace mount root; repo checkout lands at <cwd>/<repo>
  runAsUser: number;
  /**
   * PR base branch. When set (and distinct from `branch`), the script fetches it
   * and deepens both refs to a shared merge-base so `git diff origin/<base>...HEAD`
   * works — for both the fresh clone and the reuse-refresh path. Skipped for a
   * `recreateFromBase` run.
   */
  baseBranch?: string;
  /**
   * Owning workflow run id, stamped into a `<cwd>/.lastlight-run` marker so a
   * reused PVC can tell "next phase of the same run" (preserve the checkout —
   * the architect's plan.md survives) from "a fresh run reusing this PR's dir"
   * (refresh to the new head). Undefined ⇒ always preserve (the safe direction).
   */
  runId?: string;
  /**
   * Recreate the checkout from the default branch on a different-run reuse
   * instead of refreshing the (possibly stale) feature branch: discard the
   * leftover checkout and re-clone the default, cutting `branch` locally off it
   * (issue #153, `build`). A same-run reuse still preserves.
   */
  recreateFromBase?: boolean;
}

// A fixed script — untrusted values (owner/repo/branch/cwd/base/runId) arrive as
// positional args ($1..$7), NEVER interpolated into shell text, so a branch name
// containing shell metacharacters cannot break out. `--` before the URL/dir
// positionals blocks flag-smuggling on a value starting with `-`.
//
// Existing checkout (reused PVC): compare the `.lastlight-run` marker to decide.
// Same run (or no run id) → preserve, exactly as before. A different run → refresh
// the head (fetch + reset --hard + `clean -fdx -e node_modules`, keeping the deps
// tree warm) or, for a recreate-from-base run, discard and re-clone the default.
// The head refresh is best-effort: a failed fetch preserves the existing checkout
// rather than leaving a half-reset tree (mirrors the host `refreshExistingClone`).
// `ensure_base` fetches + deepens `origin/<base>` for the three-dot PR diff on
// both the fresh-clone and refresh paths (mirrors the host `ensureBaseAvailable`).
//
// `reset_scratch` is this backend's half of `resetVerifyScript` /
// `resetPrNotesJournal` (`engine/executors/shared.ts`), which the host backends
// call from `prePopulateWorkspace`. The harness has no filesystem access to the
// PVC, so the init container is the only place that can do it. Same rule: every
// path that starts a NEW run clears both, and the same-run preserve path does
// not. Purely about a stale gate surviving between attempts — both files live
// under `.git/`, which git never walks, so neither can be committed into the PR
// on this backend or any other. `git clean -fdx` cannot reach them either,
// which is why this runs after the refresh rather than relying on it.
const CLONE_SCRIPT = [
  "set -eu",
  'owner="$1"; repo="$2"; branch="$3"; ws="$4"; base="$5"; run_id="$6"; recreate="$7"',
  'repo_dir="$ws/$repo"',
  'marker="$ws/.lastlight-run"',
  'url="https://github.com/$owner/$repo.git"',
  "reset_scratch() {",
  '  rm -f "$repo_dir/.git/lastlight-verify.sh" "$repo_dir/.git/lastlight-notes" || true',
  "}",
  "ensure_base() {",
  '  [ -n "$base" ] && [ "$base" != "$branch" ] && [ -z "$recreate" ] || return 0',
  '  dest="+refs/heads/$base:refs/remotes/origin/$base"',
  "  for depth in 50 500; do",
  '    git -C "$repo_dir" fetch --depth "$depth" -- "$url" "$dest" || true',
  '    git -C "$repo_dir" fetch --depth "$depth" -- "$url" "$branch" || true',
  '    git -C "$repo_dir" merge-base "origin/$base" HEAD >/dev/null 2>&1 && return 0',
  "  done",
  '  git -C "$repo_dir" fetch --unshallow -- "$url" "$dest" || true',
  '  git -C "$repo_dir" fetch --unshallow -- "$url" "$branch" || true',
  "  return 0",
  "}",
  'stamp() { [ -n "$run_id" ] && printf %s "$run_id" > "$marker" 2>/dev/null || true; }',
  'if [ -d "$repo_dir/.git" ]; then',
  '  last_run="$(cat "$marker" 2>/dev/null || true)"',
  '  if [ -z "$run_id" ] || [ "$last_run" = "$run_id" ]; then',
  '    echo "[clone] existing checkout (same run) — preserving"; exit 0',
  "  fi",
  '  if [ -z "$recreate" ]; then',
  // Before the fetch, not after it: a failed refresh takes the `else` branch
  // below and preserves the checkout, and that is exactly the case that must
  // not inherit a superseded diagnosis's gate (mirrors the host, which calls
  // the two resets outside `refreshExistingClone`'s try/catch).
  "    reset_scratch",
  '    if git -C "$repo_dir" fetch --depth 50 -- "$url" "$branch" \\',
  '      && git -C "$repo_dir" checkout -B "$branch" FETCH_HEAD \\',
  '      && git -C "$repo_dir" reset --hard FETCH_HEAD \\',
  '      && git -C "$repo_dir" clean -fdx -e node_modules; then',
  '      git -C "$repo_dir" remote set-url origin "$url" || true',
  "      ensure_base; stamp",
  '      echo "[clone] refreshed reused workspace -> $branch"',
  "    else",
  '      echo "[clone] refresh fetch failed — preserving existing checkout"',
  "    fi",
  "    exit 0",
  "  fi",
  '  echo "[clone] recreate-from-base — discarding stale checkout"',
  '  rm -rf "$repo_dir"',
  "fi",
  'if [ -n "$recreate" ]; then',
  '  git clone --depth 50 -- "$url" "$repo_dir"',
  '  git -C "$repo_dir" checkout -B "$branch"',
  '  git -C "$repo_dir" remote set-url origin "$url"',
  'elif git clone --branch "$branch" --depth 50 -- "$url" "$repo_dir"; then',
  '  git -C "$repo_dir" remote set-url origin "$url"',
  "else",
  '  echo "[clone] branch not on remote — cloning default and cutting $branch"',
  '  git clone --depth 50 -- "$url" "$repo_dir"',
  '  git -C "$repo_dir" checkout -B "$branch"',
  '  git -C "$repo_dir" remote set-url origin "$url"',
  "fi",
  // A no-op after a fresh clone — kept so "every path that starts a new run
  // clears the scratch files" holds on this backend too, without a reader
  // having to work out which paths can have inherited one.
  "reset_scratch",
  "ensure_base",
  "stamp",
].join("\n");

/**
 * Minimal clone init (locked decision #2): clone the branch shallow-ish; if the
 * branch isn't on the remote yet (build-style first run), clone the default
 * branch and cut the branch locally.
 *
 * Reuse (a per-(repo,PR) PVC already holds a checkout) is marker-gated, mirroring
 * the host `prePopulateWorkspace`: the same run preserves the checkout (a later
 * phase reads what an earlier one wrote), a different run refreshes the head
 * (`git fetch` + `reset --hard` + `clean -fdx -e node_modules`) or, for a
 * recreate-from-base run, re-clones the default branch. For PR-diff workflows the
 * base branch is fetched + deepened to a shared merge-base on both the fresh and
 * refresh paths so `git diff origin/<base>...HEAD` resolves.
 *
 * Every new-run path also clears the harness's two scratch files
 * (`.git/lastlight-verify.sh`, `.git/lastlight-notes`) — this backend's half of
 * `resetVerifyScript` / `resetPrNotesJournal`, which the harness cannot do
 * itself because it has no filesystem access to the PVC.
 *
 * Auth is the github.com-scoped `http.extraheader` delivered as `GIT_CONFIG_*`
 * env from the creds Secret (agentGitIdentityEnv) — no token in any URL.
 *
 * owner/repo/branch/cwd/base/runId are NOT validated upstream (branch is the PR
 * head ref, attacker-named for external pr-review/pr-fix PRs) — so they're passed
 * as positional args to a fixed script rather than interpolated into shell text.
 * `sh -c CLONE_SCRIPT sh <owner> <repo> <branch> <cwd> <base> <runId> <recreate>`
 * binds argv to `$1`..`$7` at exec time, immune to quote-breaking regardless of
 * characters.
 */
export function buildCloneInitContainer(image: string, spec: CloneSpec): V1Container {
  return {
    name: "clone",
    image,
    command: ["sh", "-c", CLONE_SCRIPT],
    args: [
      "sh",
      spec.owner,
      spec.repo,
      spec.branch,
      spec.cwd,
      spec.baseBranch ?? "",
      spec.runId ?? "",
      spec.recreateFromBase ? "1" : "",
    ],
    workingDir: spec.cwd,
    // Populated in the pod builder to share the creds Secret (GIT_CONFIG_* extraheader).
    envFrom: [],
    volumeMounts: [{ name: "workspace", mountPath: spec.cwd }],
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
  };
}
