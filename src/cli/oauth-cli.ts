/**
 * `lastlight oauth <login|list|logout|status>` — HOST-LOCAL.
 *
 * Manages subscription-login credentials (ChatGPT Plus/Pro Codex, Claude
 * Pro/Max, GitHub Copilot) for the model provider pi-ai talks to. Unlike most
 * of the CLI (a thin HTTP client), this runs entirely on the host: the OAuth
 * flow needs a local browser + callback server, and it writes the credential
 * store (`auth.json`) to the same `$STATE_DIR` the running harness reads. So
 * run it on the machine that runs the agent, then restart the agent to pick up
 * a new login (`lastlight server restart agent`, or just re-run `npm run dev`).
 *
 * The store is a superset-compatible `auth.json` — the same JSON shape pi-ai's
 * own `npx @earendil-works/pi-ai login` writes — so either tool can produce it.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import chalk from "chalk";
import {
  getOAuthProvider,
  getOAuthProviders,
  loadAuthMap,
  resolveAuthFile,
  resolveOAuthApiKey,
  saveAuthMap,
  type AuthMap,
} from "../engine/oauth.js";

interface OAuthCliOpts {
  /** Explicit auth-file path (--auth-file). */
  authFile?: string;
  /** State dir override (--state-dir) used to locate auth.json. */
  stateDir?: string;
  json?: boolean;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const args = platform === "win32" ? ["", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: platform === "win32" });
    child.unref();
  } catch {
    /* best-effort — the URL is printed too */
  }
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((res) => rl.question(question, res));
}

function fileFor(opts: OAuthCliOpts): string {
  return resolveAuthFile(opts.authFile, opts.stateDir);
}

/** Human label for an expiry epoch-ms, or "no expiry". */
function expiryLabel(expires: unknown): string {
  if (typeof expires !== "number" || !Number.isFinite(expires)) return "unknown expiry";
  const deltaMs = expires - Date.now();
  if (deltaMs <= 0) return chalk.yellow("expired (auto-refreshes on next use)");
  const mins = Math.round(deltaMs / 60000);
  if (mins < 90) return `expires in ${mins}m`;
  return `expires in ${Math.round(mins / 60)}h`;
}

async function oauthList(opts: OAuthCliOpts): Promise<void> {
  const providers = getOAuthProviders();
  const map = loadAuthMap(opts.authFile, opts.stateDir);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          authFile: fileFor(opts),
          providers: providers.map((p) => ({ id: p.id, name: p.name, loggedIn: !!map[p.id] })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(chalk.bold("OAuth providers (subscription logins):\n"));
  for (const p of providers) {
    const status = map[p.id] ? chalk.green("● logged in") : chalk.dim("○ not logged in");
    console.log(`  ${chalk.cyan(p.id.padEnd(16))} ${p.name.padEnd(40)} ${status}`);
  }
  console.log(`\n${chalk.dim("Store: " + fileFor(opts))}`);
  console.log(chalk.dim("Log in with: lastlight oauth login <provider>"));
}

async function oauthStatus(opts: OAuthCliOpts): Promise<void> {
  const map = loadAuthMap(opts.authFile, opts.stateDir);
  const ids = Object.keys(map);
  if (opts.json) {
    console.log(
      JSON.stringify(
        { authFile: fileFor(opts), loggedIn: ids.map((id) => ({ id, expires: map[id]?.expires ?? null })) },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`${chalk.bold("Store:")} ${fileFor(opts)}`);
  if (ids.length === 0) {
    console.log(chalk.dim("No OAuth logins stored. Run: lastlight oauth login <provider>"));
    return;
  }
  for (const id of ids) {
    console.log(`  ${chalk.cyan(id.padEnd(16))} ${expiryLabel(map[id]?.expires)}`);
  }
}

async function oauthLogin(providerId: string | undefined, opts: OAuthCliOpts): Promise<void> {
  const providers = getOAuthProviders();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Interactive provider selection when none named.
    if (!providerId) {
      console.log(chalk.bold("Select a provider to log in:\n"));
      providers.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} ${chalk.dim(`(${p.id})`)}`));
      const choice = await ask(rl, `\nEnter number (1-${providers.length}): `);
      const idx = Number.parseInt(choice, 10) - 1;
      if (!(idx >= 0 && idx < providers.length)) {
        console.error(chalk.red("Invalid selection"));
        process.exit(1);
      }
      providerId = providers[idx].id;
    }

    const provider = getOAuthProvider(providerId);
    if (!provider) {
      console.error(chalk.red(`Unknown provider: ${providerId}`));
      console.error(chalk.dim(`Available: ${providers.map((p) => p.id).join(", ")}`));
      process.exit(1);
    }

    console.log(chalk.bold(`\nLogging in to ${provider.name}…\n`));
    const credentials = await provider.login({
      onAuth: (info) => {
        console.log(`Open this URL in your browser to authorize:\n\n  ${chalk.cyan(info.url)}\n`);
        if (info.instructions) console.log(chalk.dim(info.instructions) + "\n");
        openBrowser(info.url);
      },
      onDeviceCode: (info) => {
        console.log(`Open ${chalk.cyan(info.verificationUri)} and enter code: ${chalk.bold(info.userCode)}\n`);
        openBrowser(info.verificationUri);
      },
      onPrompt: async (p) =>
        (await ask(rl, `${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}: `)).trim(),
      onSelect: async (p) => {
        console.log(`\n${p.message}`);
        p.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}`));
        const choice = await ask(rl, `Enter number (1-${p.options.length}): `);
        const idx = Number.parseInt(choice, 10) - 1;
        return p.options[idx]?.id;
      },
      onProgress: (msg) => console.log(chalk.dim(msg)),
    });

    const map: AuthMap = loadAuthMap(opts.authFile, opts.stateDir);
    map[provider.id] = { type: "oauth", ...credentials };
    saveAuthMap(map, opts.authFile, opts.stateDir);
    console.log(chalk.green(`\n✓ Logged in to ${provider.name}.`));
    console.log(chalk.dim(`  Credentials saved to ${fileFor(opts)}`));
    console.log(
      chalk.dim(
        `  Point the model at it, e.g. LASTLIGHT_MODEL=${sampleModelFor(provider.id)} — ` +
          `then restart the agent.`,
      ),
    );
  } finally {
    rl.close();
  }
}

/** A representative model spec for the freshly-logged-in provider (docs hint only). */
function sampleModelFor(id: string): string {
  switch (id) {
    case "openai-codex":
      return "openai-codex/gpt-5.4";
    case "anthropic":
      return "anthropic/claude-sonnet-4-6";
    case "github-copilot":
      return "github-copilot/gpt-4o";
    default:
      return `${id}/<model>`;
  }
}

async function oauthLogout(providerId: string | undefined, opts: OAuthCliOpts): Promise<void> {
  const map = loadAuthMap(opts.authFile, opts.stateDir);
  if (!providerId) {
    const n = Object.keys(map).length;
    saveAuthMap({}, opts.authFile, opts.stateDir);
    console.log(chalk.green(`✓ Cleared all ${n} OAuth login(s) from ${fileFor(opts)}`));
    return;
  }
  if (!map[providerId]) {
    console.log(chalk.yellow(`No stored login for '${providerId}'.`));
    return;
  }
  delete map[providerId];
  saveAuthMap(map, opts.authFile, opts.stateDir);
  console.log(chalk.green(`✓ Logged out of '${providerId}'.`));
}

/** Verify a stored login still works by forcing a token resolve/refresh. */
async function oauthTest(providerId: string | undefined, opts: OAuthCliOpts): Promise<void> {
  if (!providerId) {
    console.error(chalk.red("Usage: lastlight oauth test <provider>"));
    process.exit(1);
  }
  try {
    const res = await resolveOAuthApiKey(providerId, opts.authFile, opts.stateDir);
    if (!res) {
      console.log(chalk.yellow(`Not logged in to '${providerId}'. Run: lastlight oauth login ${providerId}`));
      process.exit(1);
    }
    console.log(chalk.green(`✓ '${providerId}' token is valid (refreshed if needed).`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`✗ Token refresh failed for '${providerId}': ${msg}`));
    console.error(chalk.dim(`  Re-run: lastlight oauth login ${providerId}`));
    process.exit(1);
  }
}

/** Entry point invoked by cli.ts: `args` = positionals after "oauth". */
export async function oauth(args: string[], opts: OAuthCliOpts): Promise<void> {
  const sub = args[0];
  const target = args[1];
  switch (sub) {
    case undefined:
    case "list":
      return oauthList(opts);
    case "status":
      return oauthStatus(opts);
    case "login":
      return oauthLogin(target, opts);
    case "logout":
      return oauthLogout(target, opts);
    case "test":
      return oauthTest(target, opts);
    default:
      console.error(chalk.red(`Unknown oauth subcommand: ${sub}`));
      console.error(chalk.dim("Usage: lastlight oauth <login|list|status|logout|test> [provider]"));
      process.exit(1);
  }
}
