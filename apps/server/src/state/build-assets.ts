/**
 * Server-side store for build handoff docs ("server mode").
 *
 * In the default "repo" mode the per-phase docs (architect-plan.md, status.md,
 * executor-summary.md, reviewer-verdict.md, …) are committed into the target
 * repo under `.lastlight/<issueKey>/` and ride the working branch. In "server"
 * mode they live here instead — on the Last Light host, never committed — and
 * are staged into each sandbox phase from outside the repo (the same way skills
 * are) and harvested back after the phase runs.
 *
 * Layout mirrors the rest of `$STATE_DIR` (agent-sessions/projects, sandboxes):
 *
 *   <root>/<owner>/<repo>/<issueKey>/<file>.md
 *
 * `root` defaults to `$STATE_DIR/build-assets` (override `BUILD_ASSETS_DIR`).
 * Every path segment is validated to stay inside `root` — the admin API serves
 * these by name, so traversal must be impossible.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { join, resolve, sep } from "path";

/** Identity of one run's doc set within the store. */
export interface BuildAssetRef {
  owner: string;
  repo: string;
  issueKey: string;
}

/** One repo that has stored artifacts, for the admin "repos" list. */
export interface ArtifactRepoEntry {
  owner: string;
  repo: string;
  /** `owner/repo`, the form the dashboard passes back as `?repo=`. */
  slug: string;
  /** Number of run keys (issue dirs) stored under the repo. */
  keyCount: number;
  /** ISO time of the repo dir's newest structural change (issue added). */
  updatedAt: string;
}

/** One run key (issue dir) within a repo, for the admin per-repo list. */
export interface ArtifactKeyEntry {
  key: string;
  /** Number of doc files stored for the run. */
  fileCount: number;
  /** ISO time the run's doc set was last written/harvested. */
  updatedAt: string;
}

/** Free-text / paging options shared by both admin listing methods. */
interface ListOpts {
  q?: string;
  limit?: number;
  offset?: number;
}

/** Internal scan rows carry a numeric mtime so we can sort before formatting. */
interface RepoScanRow {
  owner: string;
  repo: string;
  slug: string;
  keyCount: number;
  mtimeMs: number;
}
interface KeyScanRow {
  key: string;
  fileCount: number;
  mtimeMs: number;
}

/**
 * How long a directory scan stays cached. The admin listing endpoints are
 * hit repeatedly as an operator searches-as-they-types and pages, so a short
 * TTL keeps a 1000-repo tree from being re-walked on every keystroke while
 * staying fresh enough that a just-harvested run shows up promptly (writes
 * also invalidate explicitly — see {@link BuildAssetStore.invalidate}).
 */
const CACHE_TTL_MS = 5_000;

/**
 * Derive the stable per-run key used both as the store sub-path and (with a
 * `.lastlight/` prefix) as the in-repo `issueDir`. Issue-scoped runs share a
 * key by issue number; non-issue runs (explore, health, …) get a run-scoped
 * key so concurrent sessions never overlap. Mirrors the derivation that lived
 * inline in `src/workflows/simple.ts`.
 */
export function buildAssetIssueKey(
  workflowName: string,
  issueNumber: number | undefined,
  workflowId: string,
): string {
  return issueNumber !== undefined
    ? `issue-${issueNumber}`
    : `${workflowName}-${workflowId.slice(0, 8)}`;
}

/**
 * A single path segment (owner / repo / issueKey / filename) is safe when it is
 * non-empty, carries no path separators, and is not a `.`/`..` traversal token.
 * GitHub owners/repos and our own issueKeys/filenames all satisfy this; anything
 * else is rejected rather than sanitized so a bad input fails loudly.
 */
function assertSafeSegment(segment: string, label: string): void {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new Error(`Unsafe build-asset ${label}: ${JSON.stringify(segment)}`);
  }
}

/** True when `child` resolves to a path inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

export class BuildAssetStore {
  readonly root: string;

  /** Cached repo index (single entry) + per-repo key lists, keyed `owner/repo`. */
  private repoIndexCache: { at: number; rows: RepoScanRow[] } | null = null;
  private readonly keyListCache = new Map<string, { at: number; rows: KeyScanRow[] }>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute directory for a run's doc set. Validates every segment. */
  dirFor(ref: BuildAssetRef): string {
    assertSafeSegment(ref.owner, "owner");
    assertSafeSegment(ref.repo, "repo");
    assertSafeSegment(ref.issueKey, "issueKey");
    const dir = join(this.root, ref.owner, ref.repo, ref.issueKey);
    if (!isInside(this.root, dir)) {
      throw new Error(`build-asset dir escapes store root: ${dir}`);
    }
    return dir;
  }

  /** Absolute path for one doc file, with traversal validation on the name. */
  fileFor(ref: BuildAssetRef, file: string): string {
    assertSafeSegment(file, "filename");
    const path = join(this.dirFor(ref), file);
    if (!isInside(this.root, path)) {
      throw new Error(`build-asset file escapes store root: ${path}`);
    }
    return path;
  }

  /** Read one doc, or undefined when it does not exist. */
  read(ref: BuildAssetRef, file: string): string | undefined {
    const path = this.fileFor(ref, file);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf-8");
  }

  /**
   * Read one doc as raw bytes, or undefined when it does not exist. Same
   * traversal validation as {@link read}, but no text decoding — the admin
   * API uses this to serve binary artifacts (e.g. PNG screenshot evidence)
   * intact, since `read()`'s utf-8 decode corrupts binary content.
   */
  readBuffer(ref: BuildAssetRef, file: string): Buffer | undefined {
    const path = this.fileFor(ref, file);
    if (!existsSync(path)) return undefined;
    return readFileSync(path);
  }

  /** Write (create or overwrite) one doc, creating the run dir as needed. */
  write(ref: BuildAssetRef, file: string, content: string): void {
    const path = this.fileFor(ref, file);
    mkdirSync(this.dirFor(ref), { recursive: true });
    writeFileSync(path, content);
    this.invalidate(ref.owner, ref.repo);
  }

  /** List the `<owner>/<repo>` run keys present in the store (issueKeys). */
  listKeys(owner: string, repo: string): string[] {
    assertSafeSegment(owner, "owner");
    assertSafeSegment(repo, "repo");
    const dir = join(this.root, owner, repo);
    if (!isInside(this.root, dir) || !existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  /** List the doc filenames stored for one run. */
  listFiles(ref: BuildAssetRef): string[] {
    const dir = this.dirFor(ref);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  }

  /**
   * Stage the run's stored docs into `localDir` (created fresh) so a sandbox
   * phase reads prior-phase context. A no-op-with-empty-dir when nothing is
   * stored yet — the first phase starts from a clean slate, identical to repo
   * mode's empty `.lastlight/<issueKey>/`.
   */
  stageInto(ref: BuildAssetRef, localDir: string): void {
    mkdirSync(localDir, { recursive: true });
    const src = this.dirFor(ref);
    if (!existsSync(src)) return;
    cpSync(src, localDir, { recursive: true });
  }

  /**
   * Harvest docs written by a phase back into the store, replacing the stored
   * set with whatever the phase left in `localDir`. Last-harvest-wins; the
   * runner is sequential per workspace so there is no concurrent writer.
   */
  harvestFrom(ref: BuildAssetRef, localDir: string): void {
    if (!existsSync(localDir) || !statSync(localDir).isDirectory()) return;
    const dest = this.dirFor(ref);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(localDir, dest, { recursive: true });
    this.invalidate(ref.owner, ref.repo);
  }

  // ── Admin listing (async, cached) ──────────────────────────────────────────
  // The dashboard's Artifacts tab drives these. Unlike the sync hot-path
  // methods above they walk the tree with `fs/promises` (so a large store never
  // blocks the event loop) and cache the raw scan for {@link CACHE_TTL_MS}, then
  // filter/sort/paginate the cached rows per request — search-as-you-type and
  // "load more" reuse a single walk.

  /**
   * List the repos that have stored artifacts, newest structural change first.
   * `q` is a case-insensitive substring match on `owner/repo`. Recency is the
   * repo dir's mtime (bumps when a run dir is added/removed) — deliberately an
   * O(repos) walk, never O(issues), so 1000 repos stay cheap.
   */
  async listRepos(opts: ListOpts = {}): Promise<{ repos: ArtifactRepoEntry[]; total: number }> {
    const rows = await this.scanRepoIndex();
    const { q, limit = 50, offset = 0 } = opts;
    const filtered = q
      ? rows.filter((r) => r.slug.toLowerCase().includes(q.toLowerCase()))
      : rows;
    const sorted = [...filtered].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const page = sorted.slice(offset, offset + limit).map((r) => ({
      owner: r.owner,
      repo: r.repo,
      slug: r.slug,
      keyCount: r.keyCount,
      updatedAt: new Date(r.mtimeMs).toISOString(),
    }));
    return { repos: page, total: sorted.length };
  }

  /**
   * List the run keys stored for one repo, newest first, with per-run mtime so
   * the dashboard can show each run's age and filter by a `sinceMs` window.
   * `q` matches the key substring. This scan is bounded to a single repo.
   */
  async listKeysDetailed(
    owner: string,
    repo: string,
    opts: ListOpts & { sinceMs?: number } = {},
  ): Promise<{ keys: ArtifactKeyEntry[]; total: number }> {
    const rows = await this.scanKeyList(owner, repo);
    const { q, sinceMs, limit = 50, offset = 0 } = opts;
    let filtered = rows;
    if (q) filtered = filtered.filter((r) => r.key.toLowerCase().includes(q.toLowerCase()));
    if (sinceMs !== undefined) filtered = filtered.filter((r) => r.mtimeMs >= sinceMs);
    const sorted = [...filtered].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const page = sorted.slice(offset, offset + limit).map((r) => ({
      key: r.key,
      fileCount: r.fileCount,
      updatedAt: new Date(r.mtimeMs).toISOString(),
    }));
    return { keys: page, total: sorted.length };
  }

  /** Drop cached scans touched by a write. Both a write and its TTL keep the
   * admin views fresh; this is the belt to the TTL's braces. */
  private invalidate(owner?: string, repo?: string): void {
    this.repoIndexCache = null;
    if (owner && repo) this.keyListCache.delete(`${owner}/${repo}`);
    else this.keyListCache.clear();
  }

  private async scanRepoIndex(): Promise<RepoScanRow[]> {
    const now = Date.now();
    if (this.repoIndexCache && now - this.repoIndexCache.at < CACHE_TTL_MS) {
      return this.repoIndexCache.rows;
    }
    const rows = await this.readRepoIndex();
    this.repoIndexCache = { at: now, rows };
    return rows;
  }

  private async readRepoIndex(): Promise<RepoScanRow[]> {
    const rows: RepoScanRow[] = [];
    let owners;
    try {
      owners = await readdir(this.root, { withFileTypes: true });
    } catch {
      return rows; // store root not created yet — no artifacts
    }
    for (const ownerEnt of owners) {
      if (!ownerEnt.isDirectory()) continue;
      const owner = ownerEnt.name;
      const ownerDir = join(this.root, owner);
      let repoEnts;
      try {
        repoEnts = await readdir(ownerDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const repoEnt of repoEnts) {
        if (!repoEnt.isDirectory()) continue;
        const repo = repoEnt.name;
        const repoDir = join(ownerDir, repo);
        let keyCount = 0;
        try {
          for (const keyEnt of await readdir(repoDir, { withFileTypes: true })) {
            if (keyEnt.isDirectory()) keyCount++;
          }
        } catch {
          continue;
        }
        if (keyCount === 0) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = (await stat(repoDir)).mtimeMs;
        } catch {
          /* keep 0 */
        }
        rows.push({ owner, repo, slug: `${owner}/${repo}`, keyCount, mtimeMs });
      }
    }
    return rows;
  }

  private async scanKeyList(owner: string, repo: string): Promise<KeyScanRow[]> {
    assertSafeSegment(owner, "owner");
    assertSafeSegment(repo, "repo");
    const dir = join(this.root, owner, repo);
    if (!isInside(this.root, dir)) {
      throw new Error(`build-asset dir escapes store root: ${dir}`);
    }
    const cacheKey = `${owner}/${repo}`;
    const now = Date.now();
    const cached = this.keyListCache.get(cacheKey);
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.rows;

    const rows: KeyScanRow[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      this.keyListCache.set(cacheKey, { at: now, rows });
      return rows;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const keyDir = join(dir, ent.name);
      let mtimeMs = 0;
      let fileCount = 0;
      try {
        mtimeMs = (await stat(keyDir)).mtimeMs;
        for (const f of await readdir(keyDir, { withFileTypes: true })) {
          if (f.isFile()) fileCount++;
        }
      } catch {
        /* keep defaults */
      }
      rows.push({ key: ent.name, fileCount, mtimeMs });
    }
    this.keyListCache.set(cacheKey, { at: now, rows });
    return rows;
  }
}
