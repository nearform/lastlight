/**
 * Projections + bounds for the GitHub read tools.
 *
 * Octokit hands back the REST payload verbatim, and that payload is written for
 * API clients, not for a model's context window: every object carries a dozen
 * `*_url` fields, a full `user` object per actor (~1 kB each), and — on pull
 * requests — a complete repository object under both `head` and `base`. On top
 * of that sit the genuinely large text fields: a Renovate changelog body, a
 * lockfile `patch`, a long review thread.
 *
 * Measured against real repos before this module existed:
 *
 * | call                          | raw      |
 * | ----------------------------- | -------- |
 * | listPullRequests (10 open)    | 468 kB   |
 * | listIssues (30)               | 254 kB   |
 * | listCommits (30)              | 142 kB   |
 * | getPullRequest (one Renovate) |  76 kB   |
 * | listPullRequestFiles (7)      |  26 kB   |
 *
 * An agent re-sends every one of those on each subsequent step of its loop, so
 * the cost is the payload times the number of turns that follow it. Three rules
 * bound it, and they are applied consistently so an agent learns one shape:
 *
 * 1. **Project.** Return the fields prompts actually branch on; drop URLs,
 *    nested actor and repo objects, and reaction counts.
 * 2. **Cap the prose, and say where you cut.** Bodies, review text, commit
 *    messages and patches are truncated with a notice that names the flag that
 *    lifts the cap — so the escape hatch is discovered at the moment it matters
 *    rather than costing system-prompt tokens on every run that doesn't need it.
 * 3. **Page, don't cut, the item count.** A long comment thread is not
 *    truncated silently — the list comes back in a {@link Page} that reports
 *    whether more exist and the page number to ask for next.
 */

/** Default cap on a single prose field (body, review text, commit message). */
export const MAX_BODY_CHARS = 4000;

/**
 * Default cap on one file's `patch` in a pull-request file list.
 *
 * Smaller than a body cap on purpose: a file list is a *survey*, and its whole
 * value is telling you which files to look at next. A lockfile patch alone runs
 * to tens of thousands of lines — 86% of a measured 7-file payload was `patch`.
 */
export const MAX_PATCH_CHARS = 2000;

/**
 * A bounded slice of a list endpoint.
 *
 * `has_more` is inferred from a full page coming back, which is how GitHub
 * signals "there may be more" without a count — so it can be a false positive
 * on an exact multiple of `per_page`. That is the safe direction to be wrong in:
 * it offers another fetch that returns empty, rather than hiding a comment.
 */
export interface Page<T> {
  items: T[];
  page: number;
  per_page: number;
  has_more: boolean;
  /** The `page` to request next, or null when this is the last slice. */
  next_page: number | null;
}

export function page<T>(items: T[], pageNum: number, perPage: number): Page<T> {
  const hasMore = items.length >= perPage;
  return {
    items,
    page: pageNum,
    per_page: perPage,
    has_more: hasMore,
    next_page: hasMore ? pageNum + 1 : null,
  };
}

/**
 * Truncate a prose field, naming the flag that returns it whole.
 *
 * `hatch` is the tool parameter an agent can set to lift the cap. Passing none
 * means there is no escape hatch for this field, and the notice says only that
 * it was cut — never invent a flag that the tool does not accept.
 */
export function capText(
  text: string | null | undefined,
  opts: { full?: boolean; max?: number; hatch?: string } = {},
): string | null {
  const { full = false, max = MAX_BODY_CHARS, hatch } = opts;
  if (!text) return text ?? null;
  if (full || text.length <= max) return text;
  const dropped = text.length - max;
  const how = hatch ? ` — re-call with ${hatch} for the rest` : "";
  return `${text.slice(0, max)}\n…[truncated ${dropped} chars${how}]`;
}

type Actor = { login?: string } | null | undefined;
const who = (u: Actor) => u?.login;

/**
 * Octokit types a label's `name` as optional (the issues endpoints can return
 * a bare string or a partial object), so names are filtered rather than mapped
 * — a label with no name is not a label.
 */
type Labelled = { labels?: Array<{ name?: string } | string> };
const labelNames = (x: Labelled): string[] =>
  (x.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((n): n is string => Boolean(n));

// ── Pull requests ───────────────────────────────────────────────────

/**
 * The fields shared by a PR list entry and a single PR read.
 *
 * Deliberately no `body`: listing is for *finding* a PR, and the title plus
 * labels are the whole signal for that. `getPullRequest` adds the body back.
 */
export function summarizePullRequest(p: {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  head: { ref: string };
  base: { ref: string };
  user?: Actor;
  labels?: Array<{ name?: string }>;
}) {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft,
    html_url: p.html_url,
    author: who(p.user),
    head: p.head.ref,
    base: p.base.ref,
    labels: labelNames(p),
    created_at: p.created_at,
    updated_at: p.updated_at,
    merged_at: p.merged_at ?? null,
  };
}

/**
 * One changed file.
 *
 * `patch` is **omitted unless asked for**. Both prompts that touch this tool say
 * so in prose already — the dependency-merge prompt calls the file list its
 * primary signal and forbids reading lockfile diffs, and the review skill tells
 * the agent to read the diff from its local checkout instead — but the raw tool
 * handed the patch over unbidden, so neither instruction could hold. Omitting it
 * by default is what makes them true.
 */
export function summarizeFile(
  f: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    previous_filename?: string;
    patch?: string;
  },
  opts: { includePatch?: boolean; fullPatch?: boolean } = {},
) {
  const base = {
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
  };
  if (!opts.includePatch) return base;
  return {
    ...base,
    patch: capText(f.patch, {
      full: opts.fullPatch,
      max: MAX_PATCH_CHARS,
      hatch: "full_patch: true",
    }),
  };
}

export function summarizeReview(
  r: {
    id: number;
    state: string;
    body?: string | null;
    submitted_at?: string | null;
    commit_id?: string | null;
    user?: Actor;
  },
  full = false,
) {
  return {
    id: r.id,
    author: who(r.user),
    state: r.state,
    // WHICH HEAD this review addressed. The tool exists to answer "have I
    // already reviewed this PR?", and without the SHA that question can only be
    // answered at PR granularity — an APPROVE of a three-commits-stale head is
    // indistinguishable from an APPROVE of the tree in front of you. Observed
    // 2026-08-22: handed its own prior APPROVE of an earlier head, the reviewer
    // replied "a last-light[bot] review already exists on the current head SHA"
    // — naming a SHA it had never been told — and submitted nothing.
    commit_id: r.commit_id ?? null,
    submitted_at: r.submitted_at ?? null,
    body: capText(r.body, { full, hatch: "full_bodies: true" }),
  };
}

export function summarizeReviewComment(
  c: {
    id: number;
    path: string;
    line?: number | null;
    original_line?: number | null;
    body?: string | null;
    created_at: string;
    in_reply_to_id?: number;
    user?: Actor;
  },
  full = false,
) {
  return {
    id: c.id,
    author: who(c.user),
    path: c.path,
    line: c.line ?? c.original_line ?? null,
    created_at: c.created_at,
    ...(c.in_reply_to_id ? { in_reply_to_id: c.in_reply_to_id } : {}),
    body: capText(c.body, { full, hatch: "full_bodies: true" }),
  };
}

// ── Issues ──────────────────────────────────────────────────────────

/**
 * An issue list entry — no body, same reasoning as the PR list.
 *
 * `is_pull_request` survives because GitHub's issues endpoint returns PRs too,
 * and an agent asked to triage issues needs to tell them apart.
 */
export function summarizeIssue(i: {
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  user?: Actor;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string }> | null;
  pull_request?: unknown;
}) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    html_url: i.html_url,
    author: who(i.user),
    labels: labelNames(i),
    assignees: (i.assignees ?? []).map((a) => a.login).filter((l): l is string => Boolean(l)),
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
    is_pull_request: Boolean(i.pull_request),
  };
}

export function summarizeComment(
  c: { id: number; body?: string | null; created_at: string; updated_at: string; user?: Actor },
  full = false,
) {
  return {
    id: c.id,
    author: who(c.user),
    created_at: c.created_at,
    updated_at: c.updated_at,
    body: capText(c.body, { full, hatch: "full_bodies: true" }),
  };
}

// ── Repository ──────────────────────────────────────────────────────

export function summarizeRepository(r: {
  name: string;
  full_name: string;
  description?: string | null;
  private: boolean;
  fork: boolean;
  archived?: boolean;
  default_branch: string;
  language?: string | null;
  topics?: string[];
  stargazers_count?: number;
  open_issues_count?: number;
  html_url: string;
  pushed_at?: string | null;
}) {
  return {
    name: r.name,
    full_name: r.full_name,
    description: r.description ?? null,
    private: r.private,
    fork: r.fork,
    archived: Boolean(r.archived),
    default_branch: r.default_branch,
    language: r.language ?? null,
    topics: r.topics ?? [],
    stargazers_count: r.stargazers_count,
    open_issues_count: r.open_issues_count,
    html_url: r.html_url,
    pushed_at: r.pushed_at ?? null,
  };
}

export function summarizeBranch(b: { name: string; commit: { sha: string }; protected?: boolean }) {
  return { name: b.name, sha: b.commit.sha, protected: Boolean(b.protected) };
}

export function summarizeLabel(l: { name: string; color: string; description?: string | null }) {
  return { name: l.name, color: l.color, description: l.description ?? null };
}

// ── Commits ─────────────────────────────────────────────────────────

/**
 * A commit. The `commit.message` is capped rather than reduced to its subject
 * line: a squash-merge body carries the change's real rationale, which is often
 * the only account of *why* — but a release commit can also carry a whole
 * changelog, hence the cap.
 */
export function summarizeCommit(
  c: {
    sha: string;
    commit: { message: string; author?: { name?: string; date?: string } | null };
    author?: Actor;
    html_url: string;
  },
  full = false,
) {
  return {
    sha: c.sha,
    message: capText(c.commit.message, { full, hatch: "full_messages: true" }),
    author: who(c.author) ?? c.commit.author?.name,
    date: c.commit.author?.date ?? null,
    html_url: c.html_url,
  };
}

// ── Search ──────────────────────────────────────────────────────────

/**
 * Search results carry `total_count`, which is a real number from the API
 * rather than the inferred `has_more` of a plain list — so it is worth keeping
 * alongside the page.
 */
export function searchPage<T>(
  raw: { total_count: number; incomplete_results?: boolean; items: unknown[] },
  items: T[],
  pageNum: number,
  perPage: number,
) {
  return {
    total_count: raw.total_count,
    incomplete_results: Boolean(raw.incomplete_results),
    ...page(items, pageNum, perPage),
  };
}

export function summarizeCodeHit(c: {
  path: string;
  repository?: { full_name: string };
  html_url: string;
}) {
  return { path: c.path, repository: c.repository?.full_name, html_url: c.html_url };
}

export function summarizeRepoHit(r: {
  full_name: string;
  description?: string | null;
  language?: string | null;
  stargazers_count?: number;
  default_branch?: string;
  html_url: string;
}) {
  return {
    full_name: r.full_name,
    description: r.description ?? null,
    language: r.language ?? null,
    stargazers_count: r.stargazers_count,
    default_branch: r.default_branch,
    html_url: r.html_url,
  };
}

/**
 * A search-issues hit. The endpoint returns issues AND pull requests; the
 * `repository_url` tail is the only place the owning repo appears on a hit, so
 * it is parsed out rather than dropped.
 */
export function summarizeIssueHit(i: {
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  repository_url?: string;
  user?: Actor;
  labels?: Array<{ name?: string } | string>;
  pull_request?: unknown;
}) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    repository: i.repository_url?.split("/repos/")[1],
    author: who(i.user),
    labels: labelNames(i),
    html_url: i.html_url,
    created_at: i.created_at,
    updated_at: i.updated_at,
    is_pull_request: Boolean(i.pull_request),
  };
}
