#!/usr/bin/env node

/**
 * Last Light CLI — `lastlight`.
 *
 * A thin client for a running Last Light instance. It does NOT run agents
 * itself; it POSTs triggers and reads the instance's admin API over HTTP.
 *
 *   lastlight login [url]            Authenticate (browser) + save the token
 *   lastlight <github-url|ref>       Triage that issue (default — cheap)
 *   lastlight build <ref>            Run the FULL build cycle
 *   lastlight workflow list          Inspect recent workflow runs
 *   lastlight workflow retry <id>    Re-run a failed run from where it failed
 *   lastlight session log <id> -f    Tail a sandbox session live
 *   lastlight logs search "<text>"   Search execution errors / transcripts
 *
 * Auth + target resolution (`src/cli-config.ts`): `--url`/`--token` →
 * `LASTLIGHT_URL`/`LASTLIGHT_TOKEN` env → `~/.lastlight/config.json` (written
 * by `login`) → `http://localhost:8644`.
 */
import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import chalk from "chalk";
import {
  resolveTarget,
  saveConfig,
  clearConfig,
  loadConfig,
  tokenExpiry,
  tokenIsExpired,
  DEFAULT_URL,
} from "./cli-config.js";
import { table, age, colorStatus, checkmark, followSSE } from "./cli-format.js";
import { renderTimeline, renderMessage, renderRaw } from "./cli-timeline.js";

// ── arg parsing ────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set([
  "json", "follow", "f", "no-browser", "password", "help", "h", "full",
  "version", "v",
  // `server` lifecycle flags
  "no-core", "no-overlay", "no-build", "yes", "local",
  // `setup` mode selectors (skip the interactive client/server prompt)
  "client", "server",
  // `fork` — overwrite existing overlay assets
  "force",
  // `skills install` — skip the claude marketplace path, copy skill dirs directly
  "no-marketplace",
]);

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
      } else {
        // value flag: consume next arg if present and not another flag
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1 && a !== "-") {
      const short = a.slice(1);
      flags[short] = true; // -f
    } else {
      positionals.push(a);
    }
  }
  if (flags.f) flags.follow = true;
  if (flags.h) flags.help = true;
  if (flags.v) flags.version = true;
  return { positionals, flags };
}

const { positionals, flags } = parseArgs(process.argv.slice(2));
const JSON_OUT = flags.json === true;

function out(human: string, data?: unknown): void {
  if (JSON_OUT) {
    console.log(JSON.stringify(data ?? {}, null, 2));
  } else {
    console.log(human);
  }
}

function die(msg: string): never {
  console.error(chalk.red(msg));
  process.exit(1);
}

/**
 * This CLI's version, read from the bundled package.json. Resolves for both the
 * compiled (`dist/cli/cli.js` → `../..` = package root) and dev
 * (`src/cli/cli.ts` → repo root) layouts — same trick fork-cli/skills-install use.
 */
function cliVersion(): string {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function target() {
  return resolveTarget({
    url: typeof flags.url === "string" ? flags.url : undefined,
    token: typeof flags.token === "string" ? flags.token : undefined,
  });
}

function authHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function handle(res: Response, path: string): Promise<any> {
  if (res.status === 401) {
    die("Not logged in or token expired — run: lastlight login");
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    die(`Request failed (${res.status}) on ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Server token TTL is 30 days; renew once a token is past its half-life so an
 * active user's session slides forward indefinitely and never lapses mid-use.
 */
const REFRESH_WHEN_UNDER_SECONDS = 60 * 60 * 24 * 15; // 15 days

let refreshChecked = false;

/**
 * Proactively swap a near-expiry (or grace-window-lapsed) saved token for a
 * fresh one before it dies. Only touches the file-persisted token — never an
 * env/flag-supplied one, which we don't own. Best-effort: a failed refresh
 * leaves the old token in place and the command proceeds (a real 401 is handled
 * downstream). Runs at most once per process.
 */
async function ensureFreshToken(): Promise<void> {
  if (refreshChecked) return;
  refreshChecked = true;
  if (typeof flags.token === "string" || process.env.LASTLIGHT_TOKEN) return;
  const saved = loadConfig();
  if (!saved?.token) return;
  const exp = tokenExpiry(saved.token);
  if (exp === null) return;
  const remaining = exp - Math.floor(Date.now() / 1000);
  if (remaining > REFRESH_WHEN_UNDER_SECONDS) return; // still comfortably fresh
  try {
    const res = await fetch(`${saved.url}/admin/api/token/refresh`, {
      method: "POST",
      headers: authHeaders(saved.token),
    });
    if (!res.ok) return; // expired beyond grace, or unreachable — leave it be
    const { token } = (await res.json()) as { token?: string };
    if (token) saveConfig({ url: saved.url, token });
  } catch {
    /* offline / unreachable — proceed with the existing token */
  }
}

async function apiGet(path: string): Promise<any> {
  await ensureFreshToken();
  const t = target();
  let res: Response;
  try {
    res = await fetch(`${t.url}${path}`, { headers: authHeaders(t.token) });
  } catch (e) {
    return die(`Cannot reach ${t.url} — is the server running? (${(e as Error).message})`);
  }
  return handle(res, path);
}

async function apiPost(path: string, body: unknown): Promise<any> {
  await ensureFreshToken();
  const t = target();
  let res: Response;
  try {
    res = await fetch(`${t.url}${path}`, {
      method: "POST",
      headers: authHeaders(t.token),
      body: JSON.stringify(body),
    });
  } catch (e) {
    return die(`Cannot reach ${t.url} — is the server running? (${(e as Error).message})`);
  }
  return handle(res, path);
}

function num(flag: string | boolean | undefined, fallback: number): number {
  const n = typeof flag === "string" ? parseInt(flag, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// ── help ───────────────────────────────────────────────────────────────────

const HELP = `
${chalk.bold("Last Light CLI")} ${chalk.dim("v" + cliVersion())}

${chalk.bold("Auth")}
  lastlight login [url]              Authenticate via browser, save the token
  lastlight logout                   Forget the saved instance + token
  lastlight status                   Show instance, token validity, server health

${chalk.bold("Chat")}
  lastlight chat [message]              Chat with the bot (REPL if no message)

${chalk.bold("Trigger")}
  lastlight <github-url|owner/repo#N>   Triage that issue (default — cheap)
  lastlight build <ref>                 Run the FULL build cycle (architect→PR)
  lastlight triage <owner/repo[#N]>     Triage a repo (scan) or one issue
  lastlight review <owner/repo[#N]>     Review a repo's PRs (scan) or one PR
  lastlight verify <owner/repo#N> [-- "<claim>"]   Test a claim → CONFIRMED/REFUTED
  lastlight qa-test <owner/repo#N> [-- "<steps>"]  Drive a flow → step pass/fail
  lastlight health <owner/repo>         Weekly health report
  lastlight security <owner/repo>       Security review

${chalk.bold("Debug")} (read the running instance instead of SSH)
  lastlight workflow list [--status s] [--workflow name] [--limit n]
  lastlight workflow log <id> [--follow]
  lastlight workflow retry <id>                (re-run a failed run from the phase that failed)
  lastlight session list [--limit n]
  lastlight session log <id> [--follow] [--since n] [--full]   (--full = raw, unformatted dump)
  lastlight logs search "<text>" [--scope errors|messages|all] [--limit n]
  lastlight server list                          (the lastlight-* containers)
  lastlight server logs [service|container] [--tail n] [--since 10m] [--follow]
  lastlight approvals list
  lastlight approvals approve <id> [--reason "..."]
  lastlight approvals reject <id> [--reason "..."]
  lastlight stats [--daily n | --hourly n]

${chalk.bold("Server")} (host-local — run on the server; manages the docker stack)
  lastlight server setup             Scaffold/adopt the working dir; create or clone the overlay (+ gh repo)
  lastlight server build             Build the docker images from source (run before the first start)
  lastlight server start [service]   docker compose up -d
  lastlight server stop [service]    Stop one service, or the whole stack (down)
  lastlight server restart [service] Restart a service (default: agent)
  lastlight server update            Pull core + overlay, fetch prebuilt images, recreate, restart sidecars
                                     [--no-core] [--no-overlay] [--no-build] [--local] [--yes]
                                     ${chalk.dim("(pulls prebuilt images from GHCR by default; --local builds from source)")}
  lastlight server status            Compose state + core/overlay version drift
  ${chalk.dim("Working dir resolves from --home, then LASTLIGHT_HOME, then ~/.lastlight, then ~/lastlight.")}

${chalk.bold("Fork")} (host-local — copy built-in assets into the deployment overlay)
  lastlight fork                     List forkable workflows + agent-context (marks what's forked)
  lastlight fork all                 Copy every workflow + prompts + skills + agent-context
  lastlight fork <workflow>          Copy a workflow + its prompts + skills into instance/
  lastlight fork agent-context       Copy soul.md / rules.md / security.md into instance/
  lastlight fork agent-context <f>   Copy a single agent-context file (e.g. soul.md)
                                     [--home dir] [--force to overwrite existing]
                                     Reads built-ins bundled with the CLI — no checkout needed.

${chalk.bold("Skills")} (host-local — install the Last Light Claude Code skills)
  lastlight skills install           Install the skills into a local Claude Code
                                     [--scope user|project] [--no-marketplace]
  lastlight skills list              List bundled skills + where they're installed
  lastlight skills uninstall         Remove the installed skills [--scope user|project]

${chalk.bold("OAuth")} (host-local — subscription logins for the model provider)
  lastlight oauth list               List OAuth providers + which are logged in
  lastlight oauth login [provider]   Log in via ChatGPT/Codex, Claude Pro, or Copilot
  lastlight oauth status             Show the credential store + token expiry
  lastlight oauth test <provider>    Verify a stored login still refreshes
  lastlight oauth logout [provider]  Remove one (or all) stored logins
                                     Writes auth.json under $STATE_DIR; restart the agent after.

${chalk.bold("Other")}
  lastlight setup                    First-run wizard — asks client (login) or server (stack)
                                     [--client | --server to skip the prompt]
  lastlight version                  Print the CLI version (also --version / -v)

${chalk.dim("Global flags: --json (machine output), --url <u>, --token <t>.")}
${chalk.dim("Target resolves from --url/--token, then LASTLIGHT_URL/LASTLIGHT_TOKEN, then ~/.lastlight, then " + DEFAULT_URL + ".")}
`;

// ── browser-handoff login ────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const args = platform === "win32" ? ["", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: platform === "win32" });
    child.unref();
  } catch {
    /* best-effort — we also print the URL */
  }
}

async function cmdLogin(): Promise<void> {
  const saved = loadConfig();
  let url = positionals[1]; // positionals[0] is the "login" command itself
  if (!url) {
    const answer = await p.text({
      message: "Last Light instance URL",
      placeholder: saved?.url ?? "https://lastlight.example.com",
      initialValue: saved?.url ?? "",
      validate: (v) => (v && /^https?:\/\//.test(v) ? undefined : "Enter a URL starting with http(s)://"),
    });
    if (p.isCancel(answer)) { p.cancel("Login cancelled."); process.exit(1); }
    url = answer;
  }
  url = url.replace(/\/+$/, "");

  // Password fallback: headless / no browser.
  if (flags.password === true || flags["no-browser"] === true) {
    const pw = await p.password({ message: `Admin password for ${url}` });
    if (p.isCancel(pw)) { p.cancel("Login cancelled."); process.exit(1); }
    const res = await fetch(`${url}/admin/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) die(`Login failed (${res.status}).`);
    const { token } = (await res.json()) as { token: string };
    saveConfig({ url, token });
    console.log(chalk.green(`✓ Logged in to ${url}`) + chalk.dim(" (token valid ~30 days)"));
    return;
  }

  // Browser handoff: spin up a loopback listener, open the dashboard with a
  // cli_callback pointing back here, and wait for the dashboard to redirect the
  // token to /callback once the user authenticates (any method).
  const state = crypto.randomBytes(16).toString("hex");
  const token = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const gotState = reqUrl.searchParams.get("state");
      const gotToken = reqUrl.searchParams.get("token");
      // `Connection: close` so the browser's keep-alive socket doesn't keep
      // Node's event loop alive after server.close() — otherwise login hangs.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      if (gotState !== state || !gotToken) {
        res.end("<html><body><h2>Login failed</h2><p>Invalid state — you can close this tab.</p></body></html>");
        server.close();
        reject(new Error("state mismatch or missing token"));
        return;
      }
      res.end("<html><body><h2>✓ Logged in</h2><p>You can close this tab and return to the terminal.</p></body></html>");
      server.close();
      resolve(gotToken);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const callback = `http://127.0.0.1:${port}/callback`;
      const loginUrl = `${url}/admin/?cli_callback=${encodeURIComponent(callback)}&cli_state=${state}`;
      console.log(`Opening browser to authenticate…`);
      console.log(chalk.dim(`  If it doesn't open, visit:\n  ${loginUrl}`));
      openBrowser(loginUrl);
    });
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for browser login (2 min)"));
    }, 120_000).unref();
  });

  // Defend against a stale dashboard handing back an already-dead token: refuse
  // to persist it rather than saving a credential that 401s on first use.
  if (tokenIsExpired(token)) {
    die(
      "The dashboard handed back an already-expired token (its dashboard build may be stale). " +
        "Try `lastlight login <url> --password`, or update the instance.",
    );
  }

  saveConfig({ url, token });
  console.log(chalk.green(`✓ Logged in to ${url}`) + chalk.dim(" (token valid ~30 days)"));
  // The loopback server's keep-alive socket can keep the event loop alive even
  // after server.close(); exit explicitly now that the token is saved.
  process.exit(0);
}

// ── status ───────────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const t = target();
  const saved = loadConfig();
  let health: unknown = null;
  let healthOk = false;
  try {
    const res = await fetch(`${t.url}/health`);
    healthOk = res.ok;
    health = res.ok ? await res.json() : null;
  } catch {
    healthOk = false;
  }
  let authMethods: unknown = null;
  try {
    const res = await fetch(`${t.url}/admin/api/auth-required`);
    if (res.ok) authMethods = await res.json();
  } catch { /* ignore */ }

  // Probe token validity against an authed endpoint.
  let tokenValid: boolean | null = null;
  if (t.token) {
    try {
      const res = await fetch(`${t.url}/admin/api/stats`, { headers: authHeaders(t.token) });
      tokenValid = res.status !== 401;
    } catch { tokenValid = null; }
  }

  if (JSON_OUT) {
    out("", { url: t.url, tokenPresent: Boolean(t.token), tokenValid, healthOk, health, authMethods, savedAt: saved?.savedAt });
    return;
  }
  console.log(`${chalk.bold("Instance")}   ${t.url}`);
  console.log(`${chalk.bold("Server")}     ${healthOk ? chalk.green("healthy") : chalk.red("unreachable")}`);
  console.log(`${chalk.bold("Token")}      ${
    !t.token ? chalk.yellow("none — run: lastlight login")
    : tokenValid === false ? chalk.red("expired/invalid — run: lastlight login")
    : tokenValid === true ? chalk.green("valid")
    : chalk.dim("present (unverified)")
  }`);
  if (saved?.savedAt) console.log(`${chalk.bold("Saved")}      ${age(saved.savedAt)}`);
  if (authMethods && typeof authMethods === "object") {
    const m = authMethods as { required?: boolean; slackOAuth?: boolean; githubOAuth?: boolean };
    const methods = [m.required ? "password" : null, m.slackOAuth ? "slack" : null, m.githubOAuth ? "github" : null].filter(Boolean);
    console.log(`${chalk.bold("Auth")}       ${m.required ? methods.join(", ") : chalk.dim("disabled")}`);
  }
}

// ── debug: workflows ──────────────────────────────────────────────────────────

/** Interactive picker over the recent workflow runs (used when `log` has no id). */
async function pickWorkflowRun(): Promise<string> {
  if (!process.stdout.isTTY || JSON_OUT) die("Usage: lastlight workflow log <id> [--follow]");
  const data = await apiGet(`/admin/api/workflow-runs?limit=${num(flags.limit, 20)}`);
  const runs = data.workflowRuns as any[];
  if (runs.length === 0) die("No workflow runs found.");
  const choice = await p.select({
    message: "Select a workflow run",
    options: runs.map((r) => ({
      value: r.id as string,
      label: `${r.workflowName}  ${r.status}`,
      hint: `${r.repo ?? ""} · ${age(r.startedAt)} · ${String(r.id).slice(0, 8)}`,
    })),
  });
  if (p.isCancel(choice)) { p.cancel("Cancelled."); process.exit(1); }
  return choice as string;
}

async function cmdWorkflow(): Promise<void> {
  const sub = positionals[1] ?? "list";
  if (sub === "list") {
    const params = new URLSearchParams();
    params.set("limit", String(num(flags.limit, 20)));
    if (typeof flags.status === "string") params.set("status", flags.status);
    if (typeof flags.workflow === "string") params.set("workflow", flags.workflow);
    const data = await apiGet(`/admin/api/workflow-runs?${params}`);
    if (JSON_OUT) return out("", data);
    const rows = (data.workflowRuns as any[]).map((r) => ({
      id: r.id,
      workflow: r.workflowName,
      status: colorStatus(r.status),
      phase: r.currentPhase ?? "",
      repo: r.repo ?? "",
      started: age(r.startedAt),
    }));
    console.log(table(rows, [
      { key: "id", header: "ID" },
      { key: "workflow", header: "WORKFLOW" },
      { key: "status", header: "STATUS" },
      { key: "phase", header: "PHASE" },
      { key: "repo", header: "REPO" },
      { key: "started", header: "STARTED" },
    ]));
    console.log(chalk.dim(`\n${data.total} total. Detail: lastlight workflow log <id>`));
    return;
  }
  if (sub === "log") {
    const id = positionals[2] ?? (await pickWorkflowRun());
    const [runData, execData] = await Promise.all([
      apiGet(`/admin/api/workflow-runs/${id}`),
      apiGet(`/admin/api/workflow-runs/${id}/executions`),
    ]);
    const run = runData.workflowRun;
    const execs = execData.executions as any[];
    if (JSON_OUT) return out("", { workflowRun: run, executions: execs });
    console.log(`${chalk.bold(run.workflowName)} ${chalk.dim(run.id)}`);
    console.log(`status ${colorStatus(run.status)}   phase ${run.currentPhase}   repo ${run.repo ?? "-"}   started ${age(run.startedAt)}`);
    console.log("");
    const rows = execs.map((e) => ({
      ok: checkmark(e.success),
      phase: (e.skill ?? "").replace(`${run.workflowName}:`, ""),
      dur: e.durationMs ? `${Math.round(e.durationMs / 1000)}s` : "",
      session: e.sessionId ?? "",
      error: e.error ? chalk.red(String(e.error).slice(0, 60)) : "",
    }));
    console.log(table(rows, [
      { key: "ok", header: "" },
      { key: "phase", header: "PHASE" },
      { key: "dur", header: "DUR" },
      { key: "session", header: "SESSION" },
      { key: "error", header: "ERROR" },
    ]));
    if (flags.follow) {
      const last = [...execs].reverse().find((e) => e.sessionId);
      if (!last) { console.log(chalk.dim("\n(no session to follow yet)")); return; }
      console.log(chalk.dim(`\nFollowing session ${last.sessionId} … (Ctrl-C to stop)\n`));
      await followSession(last.sessionId);
    }
    return;
  }
  if (sub === "retry") {
    const id = positionals[2];
    if (!id) die("Usage: lastlight workflow retry <id>");
    // Resumes a FAILED run from the phase that failed, keeping the same
    // context. The server rejects any non-failed run with a 400.
    const data = await apiPost(`/admin/api/workflow-runs/${id}/retry`, {});
    out(chalk.green(`✓ retrying ${id}`), data);
    return;
  }
  die("Usage: lastlight workflow list|log|retry");
}

// ── debug: sessions ───────────────────────────────────────────────────────────

async function followSession(id: string): Promise<void> {
  const t = target();
  await followSSE(`${t.url}/admin/api/sessions/${id}/stream`, t.token, (data) => {
    try {
      const lines = renderMessage(JSON.parse(data));
      if (lines.length) console.log(lines.join("\n"));
    } catch {
      console.log(data);
    }
  });
}

/** Interactive picker over the recent sessions (used when `log` has no id). */
async function pickSession(): Promise<string> {
  if (!process.stdout.isTTY || JSON_OUT) die("Usage: lastlight session log <id> [--follow] [--since n]");
  const data = await apiGet(`/admin/api/sessions?limit=${num(flags.limit, 30)}`);
  const sessions = data.sessions as any[];
  if (sessions.length === 0) die("No sessions found.");
  const choice = await p.select({
    message: "Select a session",
    options: sessions.map((s) => ({
      value: s.id as string,
      label: `${s.sessionType ?? "agent"}${s.live ? " ●" : ""}`,
      hint: `${s.message_count ?? 0} msgs · ${age(s.last_message_at ?? s.started_at)} · ${s.id}`,
    })),
  });
  if (p.isCancel(choice)) { p.cancel("Cancelled."); process.exit(1); }
  return choice as string;
}

async function cmdSession(): Promise<void> {
  const sub = positionals[1] ?? "list";
  if (sub === "list") {
    const data = await apiGet(`/admin/api/sessions?limit=${num(flags.limit, 30)}`);
    if (JSON_OUT) return out("", data);
    const rows = (data.sessions as any[]).map((s) => ({
      id: s.id,
      type: s.sessionType ?? "",
      model: s.model ?? "",
      msgs: String(s.message_count ?? 0),
      live: s.live ? chalk.green("●") : "",
      last: age(s.last_message_at ?? s.started_at),
    }));
    console.log(table(rows, [
      { key: "id", header: "ID" },
      { key: "type", header: "TYPE" },
      { key: "model", header: "MODEL" },
      { key: "msgs", header: "MSGS" },
      { key: "live", header: "LIVE" },
      { key: "last", header: "LAST" },
    ]));
    console.log(chalk.dim(`\n${data.liveCount ?? 0} live. Detail: lastlight session log <id>`));
    return;
  }
  if (sub === "log") {
    const id = positionals[2] ?? (await pickSession());
    const since = num(flags.since, -1);
    const data = await apiGet(`/admin/api/sessions/${id}/messages?since=${since}`);
    if (JSON_OUT && !flags.follow) return out("", data);
    if (!JSON_OUT) {
      const lines = flags.full === true
        ? renderRaw(data.messages as any[])
        : renderTimeline(data.messages as any[]);
      if (lines.length) console.log(lines.join("\n"));
    }
    if (flags.follow) {
      console.log(chalk.dim(`\nFollowing ${id} … (Ctrl-C to stop)\n`));
      await followSession(id);
    }
    return;
  }
  die("Usage: lastlight session list|log");
}

// ── debug: logs search ────────────────────────────────────────────────────────

async function cmdLogsSearch(query: string | undefined): Promise<void> {
  if (!query) die('Usage: lastlight logs search "<text>" [--scope errors|messages|all]');
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("scope", typeof flags.scope === "string" ? flags.scope : "errors");
  params.set("limit", String(num(flags.limit, 50)));
  const data = await apiGet(`/admin/api/log-search?${params}`);
  if (JSON_OUT) return out("", data);
  const results = data.results as any[];
  if (results.length === 0) { console.log(chalk.dim("(no matches)")); return; }
  for (const r of results) {
    if (r.source === "error") {
      console.log(`${checkmark(r.success)} ${chalk.dim(age(r.startedAt))} ${chalk.bold(r.skill)} ${r.repo ?? ""} ${chalk.dim(r.sessionId ?? "")}`);
      console.log(`   ${chalk.red(String(r.snippet).slice(0, 200))}`);
    } else {
      console.log(`${chalk.magenta("msg")} ${chalk.dim(r.sessionId)}#${r.messageIndex} ${chalk.dim(r.role ?? "")}`);
      console.log(`   ${String(r.snippet).slice(0, 200)}`);
    }
  }
}

// ── debug: approvals + stats ────────────────────────────────────────────────

/** Interactive picker over pending approvals (used when approve/reject has no id). */
async function pickApproval(): Promise<string> {
  if (!process.stdout.isTTY || JSON_OUT) die("Usage: lastlight approvals approve|reject <id> [--reason \"...\"]");
  const data = await apiGet(`/admin/api/approvals`);
  const approvals = data.approvals as any[];
  if (approvals.length === 0) die("No pending approvals.");
  const choice = await p.select({
    message: "Select an approval",
    options: approvals.map((a) => ({
      value: a.id as string,
      label: `${a.gate}  ${String(a.summary ?? "").slice(0, 50)}`,
      hint: `${a.workflowRunId} · ${age(a.createdAt)}`,
    })),
  });
  if (p.isCancel(choice)) { p.cancel("Cancelled."); process.exit(1); }
  return choice as string;
}

async function cmdApprovals(): Promise<void> {
  const sub = positionals[1] ?? "list";
  if (sub === "list") {
    const data = await apiGet(`/admin/api/approvals`);
    if (JSON_OUT) return out("", data);
    const rows = (data.approvals as any[]).map((a) => ({
      id: a.id,
      gate: a.gate,
      kind: a.kind,
      run: a.workflowRunId,
      summary: String(a.summary ?? "").slice(0, 50),
      age: age(a.createdAt),
    }));
    console.log(table(rows, [
      { key: "id", header: "ID" },
      { key: "gate", header: "GATE" },
      { key: "kind", header: "KIND" },
      { key: "run", header: "RUN" },
      { key: "summary", header: "SUMMARY" },
      { key: "age", header: "AGE" },
    ]));
    return;
  }
  if (sub === "approve" || sub === "reject") {
    const id = positionals[2] ?? (await pickApproval());
    const decision = sub === "approve" ? "approved" : "rejected";
    const data = await apiPost(`/admin/api/approvals/${id}/respond`, {
      decision,
      reason: typeof flags.reason === "string" ? flags.reason : undefined,
    });
    out(chalk.green(`✓ ${decision} ${id}`), data);
    return;
  }
  die("Usage: lastlight approvals list|approve|reject");
}

async function cmdStats(): Promise<void> {
  if (flags.daily !== undefined) {
    const data = await apiGet(`/admin/api/stats/daily?days=${num(flags.daily, 30)}`);
    if (JSON_OUT) return out("", data);
    const rows = (data.daily as any[]).map((d) => ({
      date: d.date,
      execs: String(d.executions),
      ok: String(d.successes),
      fail: String(d.failures),
      tokens: String(d.totalTokens ?? 0),
      cost: `$${(d.costUsd ?? 0).toFixed(2)}`,
    }));
    console.log(table(rows, [
      { key: "date", header: "DATE" }, { key: "execs", header: "EXECS" },
      { key: "ok", header: "OK" }, { key: "fail", header: "FAIL" },
      { key: "tokens", header: "TOKENS" }, { key: "cost", header: "COST" },
    ]));
    return;
  }
  if (flags.hourly !== undefined) {
    const data = await apiGet(`/admin/api/stats/hourly?hours=${num(flags.hourly, 24)}`);
    return out("", data);
  }
  const data = await apiGet(`/admin/api/stats`);
  if (JSON_OUT) return out("", data);
  console.log(`${chalk.bold("Total executions")}  ${data.total_executions}`);
  console.log(`${chalk.bold("Today")}             ${data.today_count}`);
  console.log(`${chalk.bold("Running")}           ${data.running}`);
  const bySkill = data.by_skill as Record<string, { count: number; success: number; fail: number }>;
  const rows = Object.entries(bySkill).map(([skill, v]) => ({
    skill, count: String(v.count), ok: chalk.green(String(v.success)), fail: v.fail ? chalk.red(String(v.fail)) : "0",
  }));
  console.log("");
  console.log(table(rows, [
    { key: "skill", header: "SKILL" }, { key: "count", header: "RUNS" },
    { key: "ok", header: "OK" }, { key: "fail", header: "FAIL" },
  ]));
}

// ── debug: server logs ────────────────────────────────────────────────────────

/** Interactive picker over the lastlight-* containers (used when `logs` has no
 *  container). Returns undefined when non-interactive so the server defaults to
 *  the agent. */
async function pickServerContainer(): Promise<string | undefined> {
  if (!process.stdout.isTTY || JSON_OUT) return undefined;
  const data = await apiGet(`/admin/api/server/containers`);
  const containers = data.containers as any[];
  if (containers.length === 0) return undefined;
  const choice = await p.select({
    message: "Select a container",
    options: containers.map((c) => ({
      value: c.name as string,
      label: c.service as string,
      hint: `${c.status} · ${c.name}`,
    })),
  });
  if (p.isCancel(choice)) { p.cancel("Cancelled."); process.exit(1); }
  return choice as string;
}

async function cmdServer(): Promise<void> {
  const sub = positionals[1];
  if (!sub || sub === "list" || sub === "containers") {
    const data = await apiGet(`/admin/api/server/containers`);
    if (JSON_OUT) return out("", data);
    const rows = (data.containers as any[]).map((c) => ({
      service: c.service,
      name: c.name,
      status: c.status,
      image: c.image,
    }));
    console.log(table(rows, [
      { key: "service", header: "SERVICE" },
      { key: "name", header: "CONTAINER" },
      { key: "status", header: "STATUS" },
      { key: "image", header: "IMAGE" },
    ]));
    console.log(chalk.dim(`\nLogs: lastlight server logs [service|container] [--tail n] [--since 10m] [--follow]`));
    return;
  }
  if (sub === "logs") {
    // optional; if omitted, prompt (or default to the agent server-side)
    const container = positionals[2] ?? (await pickServerContainer());
    const tail = num(flags.tail, 200);
    if (flags.follow) {
      const t = target();
      const u = new URL(`${t.url}/admin/api/server/logs/stream`);
      if (container) u.searchParams.set("container", container);
      u.searchParams.set("tail", String(tail));
      console.log(chalk.dim(`Following ${container ?? "agent"} logs … (Ctrl-C to stop)\n`));
      await followSSE(u.toString(), t.token, (line) => {
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === "object" && "error" in obj) { die(String(obj.error)); }
        } catch { /* normal log line */ }
        console.log(line);
      });
      return;
    }
    const params = new URLSearchParams();
    if (container) params.set("container", container);
    params.set("tail", String(tail));
    if (typeof flags.since === "string") params.set("since", flags.since);
    const data = await apiGet(`/admin/api/server/logs?${params}`);
    if (JSON_OUT) return out("", data);
    for (const line of data.lines as string[]) console.log(line);
    return;
  }

  // ── host-local lifecycle (run on the server, not over HTTP) ──────────────
  // setup | start | stop | restart | update | status operate on the working
  // directory (checkout + overlay) via git + docker compose. See cli-server.ts.
  if (sub === "setup" || sub === "build" || sub === "start" || sub === "stop" || sub === "restart" || sub === "update" || sub === "status") {
    const home = typeof flags.home === "string" ? flags.home : undefined;
    const yes = flags.yes === true;
    const service = positionals[2];
    const srv = await import("./cli-server.js");
    switch (sub) {
      case "setup":   return srv.serverSetup({ home, yes, local: flags.local === true });
      case "build":   return srv.serverBuild({ home });
      case "start":   return srv.serverStart(service, { home });
      case "stop":    return srv.serverStop(service, { home });
      case "restart": return srv.serverRestart(service, { home });
      case "update":  return srv.serverUpdate({
        home, yes,
        core: !flags["no-core"],
        overlay: !flags["no-overlay"],
        build: !flags["no-build"],
        local: flags.local === true,
      });
      case "status": {
        const res = await srv.serverStatus({ home });
        if (JSON_OUT) out("", res);
        return;
      }
    }
  }

  die(
    "Usage:\n" +
      "  lastlight server list|logs [service|container] [--tail n] [--since dur] [--follow]\n" +
      "  lastlight server setup|build|start|stop|restart|update|status [service] [--home dir]\n" +
      "    update flags: --no-core --no-overlay --no-build --local --yes\n" +
      "    (update pulls prebuilt images from GHCR by default; --local builds from source)",
  );
}

// ── chat ──────────────────────────────────────────────────────────────────────

async function sendChat(message: string, thread: string, user: string): Promise<void> {
  const data = await apiPost(`/api/chat`, { message, thread, user });
  if (JSON_OUT) return out("", data);
  console.log(`${chalk.cyan("assistant")} ${data.text ?? ""}`);
  if (data.turns || data.costUsd) {
    const cost = data.costUsd ? `, $${Number(data.costUsd).toFixed(4)}` : "";
    console.log(chalk.dim(`  (${data.turns ?? "?"} turns${cost})`));
  }
}

async function cmdChat(): Promise<void> {
  const user = typeof flags.user === "string" ? flags.user : "cli";
  const thread = crypto.randomUUID();
  const oneShot = positionals.slice(1).join(" ").trim();
  if (oneShot) {
    await sendChat(oneShot, thread, user);
    return;
  }
  // Interactive REPL — one stable thread for the whole session.
  const t = target();
  console.log(chalk.dim(`Chatting with ${t.url}  ·  thread ${thread.slice(0, 8)}  ·  type 'exit' to quit`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  try {
    for (;;) {
      const line = (await ask(chalk.green("› "))).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      try {
        await sendChat(line, thread, user);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
      }
    }
  } finally {
    rl.close();
  }
}

// ── trigger commands (unchanged contract) ─────────────────────────────────────

function parseGitHubRef(input: string) {
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[4], 10), type: urlMatch[3] === "pull" ? "pr" : "issue" };
  }
  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], number: parseInt(shortMatch[3], 10), type: "issue" };
  }
  return null;
}

async function cmdBuild(): Promise<void> {
  const ref = positionals[1];
  if (!ref) die("Usage: lastlight build <github-url> | <owner/repo#N>");
  const parsed = parseGitHubRef(ref);
  if (!parsed) die(`Could not parse GitHub reference: ${ref}`);
  const { owner, repo, number } = parsed;
  if (!JSON_OUT) console.log(`Triggering BUILD cycle for ${owner}/${repo}#${number}…`);
  const data = await apiPost(`/api/build`, { owner, repo, issueNumber: number });
  out(`Accepted: ${JSON.stringify(data)}`, data);
}

async function cmdSkill(name: string): Promise<void> {
  const target = positionals[1];
  const skillMap: Record<string, string> = {
    triage: "issue-triage", review: "pr-review", health: "repo-health", security: "security-review",
    verify: "verify", "qa-test": "qa-test", demo: "demo",
  };
  const skill = skillMap[name];
  const repoLevelOnly = name === "health" || name === "security";
  // verify / qa-test / demo take a free-text argument after the target (claim,
  // steps, or demo notes) — accept it either as trailing positionals or as a
  // quoted `-- "<text>"` (the arg parser folds the latter into flags[""]).
  const takesClaim = name === "verify" || name === "qa-test" || name === "demo";
  const claim = takesClaim
    ? (positionals.slice(2).join(" ") || (typeof flags[""] === "string" ? flags[""] : "")).trim()
    : "";
  if (!target) {
    die(`Usage: lastlight ${name} <owner/repo${repoLevelOnly ? "" : "#N"}>${takesClaim ? ` [-- "<claim or steps>"]` : ""}`);
  }
  const parsed = repoLevelOnly ? null : parseGitHubRef(target);
  let context: Record<string, unknown>;
  if (parsed) {
    context = { repo: `${parsed.owner}/${parsed.repo}`, issueNumber: parsed.number, sender: "cli" };
    if (claim) context.commentBody = claim;
    if (!JSON_OUT) console.log(`Triggering ${name} on ${parsed.owner}/${parsed.repo}#${parsed.number}…`);
  } else {
    context = { repos: [target], mode: "scan" };
    if (!JSON_OUT) console.log(`Triggering ${name} scan on ${target}…`);
  }
  const data = await apiPost(`/api/run`, { skill, context });
  out(`Accepted: ${JSON.stringify(data)}`, data);
}

async function cmdDefaultRef(ref: string): Promise<void> {
  const parsed = parseGitHubRef(ref);
  if (!parsed) {
    die(`Unknown command or reference: ${ref}\nRun \`lastlight --help\` for usage, or build with: lastlight build ${ref}`);
  }
  const { owner, repo, number, type } = parsed;
  const isPr = type === "pr";
  const skill = isPr ? "pr-review" : "issue-triage";
  if (!JSON_OUT) {
    console.log(`Triggering ${isPr ? "PR review" : "issue triage"} for ${owner}/${repo}#${number}…`);
    console.log(chalk.dim(`(For a full build cycle: lastlight build ${owner}/${repo}#${number})`));
  }
  const data = await apiPost(`/api/run`, {
    skill,
    context: { repo: `${owner}/${repo}`, ...(isPr ? { prNumber: number } : { issueNumber: number }), sender: "cli" },
  });
  out(`Accepted: ${JSON.stringify(data)}`, data);
}

// ── setup (client vs server) ───────────────────────────────────────────────

/**
 * `lastlight setup` — onboarding. First choice: is this machine a **client**
 * (the CLI just talks to a remote instance → login) or a **server** (it runs
 * the agent + docker stack → the full config wizard)? `--client` / `--server`
 * skip the prompt for non-interactive use.
 */
async function cmdSetup(): Promise<void> {
  let mode: "client" | "server" | undefined =
    flags.client === true ? "client" : flags.server === true ? "server" : undefined;
  if (!mode) {
    if (!process.stdin.isTTY) {
      die("setup must run interactively, or pass --client / --server.");
    }
    const choice = await p.select({
      message: "What are you setting up on this machine?",
      options: [
        { value: "client", label: "Client", hint: "this CLI talks to a remote Last Light instance" },
        { value: "server", label: "Server", hint: "this machine runs the agent + docker stack" },
      ],
    });
    if (p.isCancel(choice)) { p.cancel("Cancelled."); process.exit(1); }
    mode = choice as "client" | "server";
  }
  if (mode === "client") return cmdLogin();
  // Server: the full first-run config wizard (secrets, keys, managed repos).
  const { runSetup } = await import("./setup.js");
  await runSetup();
}

// ── fork (host-local) ──────────────────────────────────────────────────────

/**
 * `lastlight fork [target]` — copy a built-in workflow (plus its prompts +
 * skills) or the agent-context files (soul.md and friends) into the deployment
 * overlay so they can be edited per-deployment. Host-local: operates on files
 * in the working dir (resolved via --home / LASTLIGHT_HOME / serverHome), not
 * over HTTP. See src/fork-cli.ts.
 */
async function cmdFork(): Promise<void> {
  const home = typeof flags.home === "string" ? flags.home : undefined;
  const { fork } = await import("./fork-cli.js");
  await fork(positionals.slice(1), { home, force: flags.force === true });
}

// ── skills (host-local) ──────────────────────────────────────────────────────

/**
 * `lastlight skills <install|list|uninstall>` — install the Last Light Claude
 * Code skills into a local Claude Code instance. Operates on local files (and
 * shells out to the `claude` CLI when present), not over HTTP. See
 * src/skills-install.ts.
 */
async function cmdSkills(): Promise<void> {
  const scope = flags.scope === "project" ? "project" : "user";
  const { skills } = await import("./skills-install.js");
  await skills(positionals.slice(1), {
    scope,
    noMarketplace: flags["no-marketplace"] === true,
  });
}

// ── oauth (host-local) ─────────────────────────────────────────────────────

/**
 * `lastlight oauth <login|list|status|logout|test>` — manage subscription
 * logins (Codex / Claude Pro / Copilot). Host-local: runs the browser OAuth
 * flow and writes auth.json under $STATE_DIR where the harness reads it. See
 * src/cli/oauth-cli.ts.
 */
async function cmdOAuth(): Promise<void> {
  const { oauth } = await import("./oauth-cli.js");
  await oauth(positionals.slice(1), {
    authFile: typeof flags["auth-file"] === "string" ? flags["auth-file"] : undefined,
    stateDir: typeof flags["state-dir"] === "string" ? flags["state-dir"] : undefined,
    json: flags.json === true,
  });
}

// ── dispatch ─────────────────────────────────────────────────────────────────

async function main() {
  const cmd = positionals[0];

  // `--version` / `-v` / `lastlight version` → print just the version and exit.
  if (flags.version || cmd === "version") {
    out(cliVersion(), { version: cliVersion() });
    process.exit(0);
  }

  if (!cmd || flags.help) {
    console.log(HELP);
    process.exit(0);
  }

  switch (cmd) {
    case "setup": return cmdSetup();
    case "login": return cmdLogin();
    case "logout": clearConfig(); console.log(chalk.green("✓ Logged out (cleared ~/.lastlight/config.json)")); return;
    case "status":
    case "whoami": return cmdStatus();
    case "workflow":
    case "workflows": return cmdWorkflow();
    case "session":
    case "sessions": return cmdSession();
    case "logs":
    case "log": {
      // `logs search <q>` or legacy `log search <q>`
      if (positionals[1] === "search") return cmdLogsSearch(positionals[2]);
      die('Usage: lastlight logs search "<text>"');
      return;
    }
    case "approvals": return cmdApprovals();
    case "fork": return cmdFork();
    case "skills": return cmdSkills();
    case "oauth":
    case "auth": return cmdOAuth();
    case "server": return cmdServer();
    case "stats": return cmdStats();
    case "chat": return cmdChat();
    case "build": return cmdBuild();
    case "triage":
    case "review":
    case "health":
    case "security":
    case "verify":
    case "qa-test":
    case "demo": return cmdSkill(cmd);
    default: return cmdDefaultRef(cmd);
  }
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err?.message || err);
  process.exit(1);
});
