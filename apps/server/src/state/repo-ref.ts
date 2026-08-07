/**
 * The ONE rule for how a repository is identified in the database (issue #279).
 *
 * **Storage is `owner` + a BARE `repo`.** Every repo-bearing table follows it —
 * `workflow_runs`, `executions`, `feedback_anchors`, `feedback_signals` — and so
 * does `GitSandboxAccess`, so a row read back is directly usable as Octokit's
 * `(owner, repo)` pair with no splitting anywhere. `repo` stays a single
 * path-safe segment because `workflowScopedTaskId` and `prNotesRepoDir` derive
 * filesystem paths from it.
 *
 * Everything a *user* sees speaks the qualified `owner/repo` instead —
 * `getManagedRepos()`, `EventEnvelope.repo`, `PrState.repo`, the artifact-store
 * slugs, `/me/repos`, the dashboard. That join is the only place the two
 * vocabularies meet, and this module is the only place it is expressed.
 *
 * It used to be expressed in six places that disagreed about which source wins
 * (`distinctRepos`, `repoMatchClause`, `QUALIFIED_REPO_SQL`, two helpers in
 * `admin/routes.ts`, and the dashboard's `runRepoPath`). #278 shipped a filter
 * built on one reading and it compared `lastlight` against `{nearform/lastlight}`
 * — a non-null non-match, which **hides** rows rather than showing them.
 *
 * Pure, dependency-free, and deliberately in `state/` beside the stores that
 * enforce it.
 */

/**
 * Split a possibly-qualified repo into the stored shape.
 *
 * The de-qualifier, applied at the write choke points (`createRun`,
 * `recordStart`) and again on read-back, so a caller that hands us
 * `"nearform/lastlight"` — a test fixture, an eval harness, a row written by an
 * older process before the backfill ran — cannot reintroduce the drift this
 * module exists to end.
 *
 * An explicit `owner` wins over the one embedded in `repo`: the column was
 * populated from `context.owner` by the authoritative dispatch-time split,
 * while a qualified `repo` is the legacy shape. Empty strings normalize to
 * `undefined` so callers can use a plain truthiness check.
 */
export function normalizeRepoRef(
  owner: string | null | undefined,
  repo: string | null | undefined,
): { owner?: string; repo?: string } {
  const rawRepo = repo?.trim() || undefined;
  const rawOwner = owner?.trim() || undefined;
  if (!rawRepo) return { owner: rawOwner, repo: undefined };

  // First slash, matching the SQL backfill's `instr(repo, '/')`. A GitHub repo
  // name cannot contain a slash, so anything past the first one is malformed
  // input rather than a shape we need to support.
  const slash = rawRepo.indexOf("/");
  if (slash <= 0) return { owner: rawOwner, repo: rawRepo };
  return {
    owner: rawOwner ?? (rawRepo.slice(0, slash) || undefined),
    repo: rawRepo.slice(slash + 1) || undefined,
  };
}

/**
 * Compose the qualified `owner/repo` a user-facing surface speaks.
 *
 * The inverse of {@link normalizeRepoRef}, and the only recomposition in the
 * codebase. Two degenerate cases, both deliberate:
 *
 * - An already-qualified `repo` (a row predating the backfill) is returned
 *   as-is rather than double-qualified — `dispatcher.ts` used to join
 *   unconditionally and produced `acme/acme/widgets`, which the dispatch split
 *   then read as the repo `acme`, a different real repository.
 * - No owner returns the BARE name. Ambiguous, but it is a name somebody can
 *   read; for a SQL *filter*, where a bare name would match nothing in a
 *   qualified allow-list and therefore hide the row, use
 *   {@link qualifiedRepoSql} with `"null"` instead.
 */
export function qualifyRepo(
  owner: string | null | undefined,
  repo: string | null | undefined,
): string | undefined {
  const rawRepo = repo?.trim() || undefined;
  if (!rawRepo) return undefined;
  if (rawRepo.includes("/")) return rawRepo;
  const rawOwner = owner?.trim() || undefined;
  return rawOwner ? `${rawOwner}/${rawRepo}` : rawRepo;
}

/**
 * {@link qualifyRepo} as a SQL expression, so the two cannot drift.
 *
 * `unqualifiable` is what to answer for a row with a repo but no owner — the
 * only rows the backfill cannot fix, because nothing on them records the
 * account. **The caller must choose, because the two answers are opposites:**
 *
 * - `"bare"` — the repo name alone. For grouping and display (`distinctRepos`),
 *   where showing an under-specified name beats dropping the row.
 * - `"null"` — SQL NULL. For anything a consumer treats as "no repo, always
 *   visible" (the per-repo visibility scope, issue #169). A bare name there
 *   matches nothing in a qualified allow-list and so silently HIDES the row,
 *   which is exactly the #278 bug.
 *
 * Column names are interpolated, so pass literals — never user input.
 */
export function qualifiedRepoSql(
  ownerCol: string,
  repoCol: string,
  unqualifiable: "bare" | "null",
): string {
  const fallback = unqualifiable === "bare" ? repoCol : "NULL";
  return `CASE
    WHEN ${repoCol} IS NULL OR ${repoCol} = '' THEN NULL
    WHEN instr(${repoCol}, '/') > 0 THEN ${repoCol}
    WHEN ${ownerCol} IS NOT NULL AND ${ownerCol} <> '' THEN ${ownerCol} || '/' || ${repoCol}
    ELSE ${fallback}
  END`;
}
