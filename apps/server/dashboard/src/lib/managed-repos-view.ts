import type { ManagedRepos } from "../api";

/**
 * Config → Managed repos: what the pane asks before it sends a write. The
 * server enforces the same rule (a removal that would empty the approved list
 * with approval off is refused 409 `would-empty`), so these only decide which
 * question to put to the operator first.
 */

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The N in "all N repos the App can see". */
export function followAppCount(data: ManagedRepos): number {
  return data.installation.length;
}

/** Removing these repos empties the approved list while approval is off. */
export function removeNeedsChoice(data: ManagedRepos, removing: string[]): boolean {
  if (data.requireApproval) return false;
  return data.approved.length > 0 && data.approved.every((a) => removing.some((r) => same(a, r)));
}

/**
 * "all N repos the App can see" — or, before the App's repo list has been
 * discovered (N would read 0), "every repo the App can see".
 */
export function followAppPhrase(data: ManagedRepos): string {
  return data.refreshedAt === null
    ? "every repo the App can see"
    : `all ${followAppCount(data)} repos the App can see`;
}

/** The confirm text for flipping the switch, or null when it needs none. */
export function toggleConfirmText(data: ManagedRepos, enable: boolean): string | null {
  if (data.approved.length > 0) return null;
  if (enable) return "Nothing will get work until you approve repos.";
  return data.refreshedAt === null
    ? "The bot will work on every repo the App can see (not discovered yet), and future repos."
    : `The bot will work on ${followAppPhrase(data)}, and future repos.`;
}

/** The Not approved section: hidden only when there is nothing to approve and approval is off. */
export function showGapSection(data: ManagedRepos): boolean {
  return data.requireApproval || data.gap === null || data.gap.length > 0;
}
