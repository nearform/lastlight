/**
 * `lastlight activity` — the audit stream, read-only (issue #206).
 *
 * A thin admin-API client over `GET /admin/api/activity`. Lives in its own
 * module, and takes its fetch as an injected seam, for the same reason
 * `pr-cli.ts` does: `cli.ts` runs `main()` on import, so anything defined there
 * cannot be unit-tested.
 */

import chalk from "chalk";
import { table, age } from "./cli-format.js";

/** The GET seam `cli.ts` injects. */
export interface ActivityOpts {
  /** `--json` — print the server's answer verbatim. */
  json?: boolean;
  apiGet: (path: string) => Promise<any>;
}

const USAGE = `Usage: lastlight activity [--actor <login>] [--action <verb>] [--target <type:id>] [--since <iso>] [--limit N]`;

/** Colour by outcome, not by status — this stream has its own vocabulary. */
function colorOutcome(outcome: string): string {
  switch (outcome) {
    case "ok":
      return chalk.green(outcome);
    case "denied":
      return chalk.yellow(outcome);
    case "error":
      return chalk.red(outcome);
    default:
      return outcome;
  }
}

/**
 * `workflow_run` + `4f3a…` → `workflow_run:4f3a…`, truncated to stay in a
 * terminal column. A run id is a uuid and only its head is ever recognisable.
 */
function renderTarget(type?: string, id?: string): string {
  if (!type && !id) return "";
  if (!id) return type!;
  const short = id.length > 28 ? `${id.slice(0, 26)}…` : id;
  return type ? `${type}:${short}` : short;
}

export async function activityCommand(argv: string[], opts: ActivityOpts): Promise<number> {
  if (argv[0] === "help" || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }

  const params = new URLSearchParams();
  const flagValue = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  for (const name of ["actor", "action", "target", "since", "limit", "offset"]) {
    const value = flagValue(name);
    if (value) params.set(name, value);
  }
  if (!params.has("limit")) params.set("limit", "30");

  const data = await opts.apiGet(`/admin/api/activity?${params}`);
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }

  const users = (data.users ?? {}) as Record<string, { name?: string }>;
  const rows = (data.activity as any[]).map((a) => ({
    when: age(a.createdAt),
    // The real name when `users` knows one, else the bare login. A null actor
    // is a password session or an auth-disabled instance, not a missing row —
    // so it renders as a dim marker rather than an empty cell.
    actor: a.actorLogin
      ? (users[a.actorLogin]?.name ?? a.actorLogin)
      : chalk.dim("(no login)"),
    type: a.actorType ?? "",
    action: a.action,
    target: renderTarget(a.targetType, a.targetId),
    outcome: colorOutcome(a.outcome),
  }));

  console.log(
    table(rows, [
      { key: "when", header: "WHEN" },
      { key: "actor", header: "ACTOR" },
      { key: "type", header: "VIA" },
      { key: "action", header: "ACTION" },
      { key: "target", header: "TARGET" },
      { key: "outcome", header: "OUTCOME" },
    ]),
  );
  console.log(chalk.dim(`\n${data.total} total. Filter: lastlight activity --actor <login>`));
  return 0;
}
