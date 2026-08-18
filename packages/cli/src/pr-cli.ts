/**
 * `lastlight pr …` — pull-request actions on a running instance.
 *
 * Today there is exactly one: **`pr retry <owner/repo#N> [reason]`**, the third
 * of the three surfaces that un-stick an escalated pull request (the other two
 * are a `@<bot> retry` comment and taking `requires-human` off by hand — see
 * `apps/server/spec/05-router.md` → "Un-sticking an escalated PR"). All three
 * write the same record and re-arm the same budgets; this one is authorised by
 * the admin session rather than by a GitHub permission, and is the surface a
 * maintainer already at a terminal reaches for.
 *
 * A thin client, like every other command in this package: it POSTs to
 * `/admin/api/prs/:owner/:repo/:number/retry` and renders the answer. All of the
 * policy — the managed-repo allowlist, the hold label, the run lock, the fork
 * guard, the budgets — is decided on the server, at the same gate a webhook
 * crosses. The CLI never gains an edge to `lastlight-core`.
 *
 * Three answers, and each one is a real outcome rather than an error:
 *
 * | server | meaning | here |
 * |---|---|---|
 * | 200 `dispatched: true` | re-armed and running now | ✓, with the workflow name |
 * | 200 `dispatched: false` | recorded; the gate skipped for an unrelated reason (a red base branch), so the next event honours it | ✓, quieter, naming the reason |
 * | 409 | refused, nothing recorded — the hold label, a run already working the PR, or a PR we could not read | the reason, exit 1 |
 */

import chalk from "chalk";

/** The POST seam `cli.ts` injects. Never throws on a non-2xx: see the table above. */
export interface PrOpts {
  /** `--json` — print the server's answer verbatim. */
  json?: boolean;
  apiPost: (path: string, body: unknown) => Promise<{ status: number; data: any }>;
}

const USAGE = `Usage: lastlight pr retry <owner/repo#N> [reason]`;

/**
 * A **pull request** reference: `owner/repo#N`, or a `.../pull/N` URL.
 *
 * Deliberately narrower than the CLI's general `parseGitHubRef`, which treats a
 * bare `owner/repo#N` as an issue and happily accepts an `/issues/N` URL. A
 * retry is scoped to the fix family's budgets and means nothing on an issue, so
 * pasting an issue URL should say so here rather than 404 on the server.
 */
export function parsePrRef(input: string): { owner: string; repo: string; prNumber: number } | null {
  const url = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) return { owner: url[1], repo: url[2], prNumber: parseInt(url[3], 10) };
  const short = input.match(/^([^/\s]+)\/([^#/\s]+)#(\d+)$/);
  if (short) return { owner: short[1], repo: short[2], prNumber: parseInt(short[3], 10) };
  return null;
}

async function prRetry(args: string[], opts: PrOpts): Promise<number> {
  const [ref, ...rest] = args;
  if (!ref) throw new Error(USAGE);
  const parsed = parsePrRef(ref);
  if (!parsed) {
    throw new Error(
      `Not a pull-request reference: ${ref}\n${USAGE}\n` +
        `(An issue can't be retried — the retry moves a PR's fix budgets.)`,
    );
  }
  const { owner, repo, prNumber } = parsed;
  // Everything after the ref is the reason, so it can be typed without quoting.
  // Free text: the server sanitizes it before it is stored or replayed.
  const reason = rest.join(" ").trim();

  const { status, data } = await opts.apiPost(
    `/admin/api/prs/${owner}/${repo}/${prNumber}/retry`,
    reason ? { reason } : {},
  );

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return status >= 200 && status < 300 ? 0 : 1;
  }

  const target = `${owner}/${repo}#${prNumber}`;
  if (status === 409) {
    // The hold label, the run lock, or a PR we could not read. Nothing was
    // recorded, so the honest thing is a non-zero exit: the ask did not land.
    console.error(chalk.yellow(`✗ ${target}: ${data?.reason ?? data?.error ?? "refused"}`));
    return 1;
  }
  if (status < 200 || status >= 300) {
    throw new Error(`${target}: ${data?.error ?? `retry failed (${status})`}`);
  }

  if (data?.dispatched) {
    console.log(chalk.green(`✓ retrying ${data.workflow} on ${target}`));
    console.log(chalk.dim(`  ${data.reason} — watch: lastlight workflow list`));
  } else {
    console.log(chalk.green(`✓ recorded a retry on ${target}`));
    console.log(chalk.dim(`  Not run yet: ${data?.reason ?? "the gate skipped it"}`));
    console.log(chalk.dim(`  The ask is on the record — the next event will honour it.`));
  }
  if (data?.retry?.note) console.log(chalk.dim(`  note: ${data.retry.note}`));
  return 0;
}

export async function prCommand(args: string[], opts: PrOpts): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "retry":
      return prRetry(rest, opts);
    default:
      throw new Error(`Unknown "pr" subcommand: ${sub ?? "(none)"}\n${USAGE}`);
  }
}
