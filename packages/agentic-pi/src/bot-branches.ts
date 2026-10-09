/**
 * Branches a dependency-update bot (Dependabot, Renovate) owns. Once anyone
 * else commits to one, the bot abandons the PR on its next sync and
 * force-pushes its own tip back (issue #442) — so the `github_publish` /
 * `github_create_or_update_file` tools refuse to write to them, and
 * `lastlight-core` reads the same list to tell a bot-owned run from one that
 * pushes a fix.
 *
 * Kept dependency-free on purpose: core imports this module directly
 * (`agentic-pi/dist/bot-branches.js`), and the tool layer's pi imports must not
 * come along with it.
 *
 * The prefixes are the shipped defaults — `dependabot/[ecosystem]/…`,
 * `renovate/[package]-…`, and `renovate-bot/[package]-…`. Renovate supports a
 * configurable `branchPrefix`; repos that customise it (e.g. `deps/`) need to
 * extend this list.
 */
export type BotKind = "dependabot" | "renovate";

const BOT_BRANCH_PREFIXES = [
  { prefix: /^dependabot\//, kind: "dependabot" as const },
  { prefix: /^renovate\//, kind: "renovate" as const },
  { prefix: /^renovate-bot\//, kind: "renovate" as const },
] as const;

/** The bot that owns `branch`, or `null` for a branch no bot manages. */
export function botKindForBranch(branch: string): BotKind | null {
  for (const { prefix, kind } of BOT_BRANCH_PREFIXES) {
    if (prefix.test(branch)) return kind;
  }
  return null;
}

export function isBotOwnedBranch(branch: string): boolean {
  return botKindForBranch(branch) !== null;
}
