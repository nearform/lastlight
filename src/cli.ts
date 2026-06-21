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
 *   lastlight session log <id> -f    Tail a sandbox session live
 *   lastlight logs search "<text>"   Search execution errors / transcripts
 *
 * Auth + target resolution (`src/cli-config.ts`): `--url`/`--token` →
 * `LASTLIGHT_URL`/`LASTLIGHT_TOKEN` env → `~/.lastlight/config.json` (written
 * by `login`) → `http://localhost:8644`.
 */
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import chalk from "chalk";
import {
  resolveTarget,
  saveConfig,
  clearConfig,
  loadConfig,
  DEFAULT_URL,
} from "./cli-config.js";
import { table, age, colorStatus, checkmark, followSSE } from "./cli-format.js";

// ── arg parsing ────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(["json", "follow", "f", "no-browser", "password", "help", "h"]);

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

async function apiGet(path: string): Promise<any> {
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
${chalk.bold("Last Light CLI")}

${chalk.bold("Auth")}
  lastlight login [url]              Authenticate via browser, save the token
  lastlight logout                   Forget the saved instance + token
  lastlight status                   Show instance, token validity, server health

${chalk.bold("Trigger")}
  lastlight <github-url|owner/repo#N>   Triage that issue (default — cheap)
  lastlight build <ref>                 Run the FULL build cycle (architect→PR)
  lastlight triage <owner/repo[#N]>     Triage a repo (scan) or one issue
  lastlight review <owner/repo[#N]>     Review a repo's PRs (scan) or one PR
  lastlight health <owner/repo>         Weekly health report
  lastlight security <owner/repo>       Security review

${chalk.bold("Debug")} (read the running instance instead of SSH)
  lastlight workflow list [--status s] [--workflow name] [--limit n]
  lastlight workflow log <id> [--follow]
  lastlight session list [--limit n]
  lastlight session log <id> [--follow] [--since n]
  lastlight logs search "<text>" [--scope errors|messages|all] [--limit n]
  lastlight approvals list
  lastlight approvals approve <id> [--reason "..."]
  lastlight approvals reject <id> [--reason "..."]
  lastlight stats [--daily n | --hourly n]

${chalk.bold("Other")}
  lastlight setup                    Interactive first-run setup wizard

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
    console.log(chalk.green(`✓ Logged in to ${url}`) + chalk.dim(" (token valid ~7 days)"));
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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

  saveConfig({ url, token });
  console.log(chalk.green(`✓ Logged in to ${url}`) + chalk.dim(" (token valid ~7 days)"));
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

async function cmdWorkflow(): Promise<void> {
  const sub = positionals[1];
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
    const id = positionals[2];
    if (!id) die("Usage: lastlight workflow log <id> [--follow]");
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
  die("Usage: lastlight workflow list|log");
}

// ── debug: sessions ───────────────────────────────────────────────────────────

async function followSession(id: string): Promise<void> {
  const t = target();
  await followSSE(`${t.url}/admin/api/sessions/${id}/stream`, t.token, (data) => {
    try {
      const msg = JSON.parse(data);
      printMessage(msg);
    } catch {
      console.log(data);
    }
  });
}

function printMessage(msg: any): void {
  const role = msg.role ?? msg.type ?? "?";
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
  const tag = role === "assistant" ? chalk.cyan("assistant")
    : role === "user" ? chalk.green("user")
    : role === "tool" ? chalk.magenta(`tool${msg.tool_name ? ":" + msg.tool_name : ""}`)
    : chalk.dim(role);
  console.log(`${tag} ${content.slice(0, 2000)}`);
}

async function cmdSession(): Promise<void> {
  const sub = positionals[1];
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
    const id = positionals[2];
    if (!id) die("Usage: lastlight session log <id> [--follow] [--since n]");
    const since = num(flags.since, -1);
    const data = await apiGet(`/admin/api/sessions/${id}/messages?since=${since}`);
    if (JSON_OUT && !flags.follow) return out("", data);
    if (!JSON_OUT) for (const m of data.messages as any[]) printMessage(m);
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
    const id = positionals[2];
    if (!id) die(`Usage: lastlight approvals ${sub} <id> [--reason "..."]`);
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
  };
  const skill = skillMap[name];
  const repoLevelOnly = name === "health" || name === "security";
  if (!target) die(`Usage: lastlight ${name} <owner/repo>${repoLevelOnly ? "" : " | <owner/repo#N>"}`);
  const parsed = repoLevelOnly ? null : parseGitHubRef(target);
  let context: Record<string, unknown>;
  if (parsed) {
    context = { repo: `${parsed.owner}/${parsed.repo}`, issueNumber: parsed.number, sender: "cli" };
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

// ── dispatch ─────────────────────────────────────────────────────────────────

async function main() {
  const cmd = positionals[0];

  if (!cmd || flags.help) {
    console.log(HELP);
    process.exit(cmd ? 0 : 0);
  }

  switch (cmd) {
    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup();
      return;
    }
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
    case "stats": return cmdStats();
    case "build": return cmdBuild();
    case "triage":
    case "review":
    case "health":
    case "security": return cmdSkill(cmd);
    default: return cmdDefaultRef(cmd);
  }
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err?.message || err);
  process.exit(1);
});
