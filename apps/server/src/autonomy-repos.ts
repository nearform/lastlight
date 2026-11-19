import { getAutonomyConfig, getAutonomyRepos, setAutonomyReposOverride } from "./config/config.js";

/**
 * The autonomy allow-list (`autonomy.repos`: the repos the board shows and a
 * `ready-for-agent` label may start a build on), editable from Config →
 * Managed repos. Stored as one `harness_settings` row (key
 * {@link AUTONOMY_REPOS_SETTING_KEY}) once the dashboard changes it; until then
 * it is the YAML `autonomy.repos`. Same pattern as the repo approval state in
 * `managed-repos.ts`: the in-memory copy feeds the synchronous
 * `isAutonomousRepo()`.
 */
export interface AutonomyReposState {
  repos: string[];
}

export const AUTONOMY_REPOS_SETTING_KEY = "autonomy-repos";

let stored = false;
/**
 * Bumped by every write, so a timer refresh that read the row BEFORE a write
 * landed drops its (older) result instead of reverting the write in memory.
 */
let generation = 0;

function cache(state: AutonomyReposState | null): void {
  stored = state !== null;
  setAutonomyReposOverride(state ? state.repos : null);
}

/** Cache setter for a just-written row (or null = no row). */
export function setStoredAutonomyRepos(state: AutonomyReposState | null): void {
  generation++;
  cache(state);
}

/** The YAML `autonomy.repos`, ignoring any stored row. */
export function yamlAutonomyRepos(): string[] {
  return [...getAutonomyConfig().repos];
}

/** The autonomy list in effect, and whether it came from the stored row. */
export function getAutonomyReposState(): { state: AutonomyReposState; stored: boolean } {
  return { state: { repos: getAutonomyRepos() }, stored };
}

/**
 * Re-read the stored row into the in-memory copy. Called at boot and on a
 * timer; the process that made a change updates its copy directly.
 */
export async function refreshAutonomyRepos(
  db: { getSetting<T>(key: string): Promise<{ value: T } | null> },
): Promise<void> {
  const started = generation;
  const row = await db.getSetting<unknown>(AUTONOMY_REPOS_SETTING_KEY);
  if (started !== generation) return; // a write landed meanwhile; it is newer
  cache(row ? normalizeAutonomyRepos(row.value) : null);
}

/**
 * Parse a stored row. A row exists only because an operator chose something,
 * so a malformed one FAILS CLOSED: only its valid entries are autonomous,
 * never the YAML list.
 */
export function normalizeAutonomyRepos(raw: unknown): AutonomyReposState {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const list = Array.isArray(v?.repos) ? (v!.repos as unknown[]) : [];
  return { repos: list.filter((r): r is string => typeof r === "string" && !!r.trim()).map((r) => r.trim()) };
}

/** Test-only: forget the stored row. */
export function resetAutonomyReposForTests(): void {
  generation = 0;
  cache(null);
}
