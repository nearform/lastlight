// SPIKE S2 (spike/live-sessions): the same guardian contract over ACP via
// embedded acpx/runtime. Runs one agent (claude | pi) on the demo task with a
// stub MCP tool, routes onPermissionRequest to a guardian, tries a mid-turn
// steer, and reports what the event stream carried.
//
//   node acpx-live.mjs claude|pi [--cancel-at-tool N]
import { createAcpRuntime, createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agent = process.argv[2] ?? "claude";
const cancelAt = Number(process.argv[process.argv.indexOf("--cancel-at-tool") + 1] || 0) || 0;
const BIN = "/tmp/acpx-spike/node_modules/.bin";
const out = `/tmp/live-spike/acpx-${agent}${cancelAt ? "-cancel" : ""}${process.argv.includes("--prompt") ? "-mcp" : ""}.jsonl`;
writeFileSync(out, "");
const mcpLog = `/tmp/live-spike/mcp-${agent}.log`;
writeFileSync(mcpLog, "");

// ── demo repo ──
const repo = mkdtempSync(join(tmpdir(), `acpx-${agent}-`));
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src/math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
writeFileSync(join(repo, "test.js"), 'import { add } from "./src/math.js";\nif (add(2, 3) !== 5) { console.error("FAIL"); process.exit(1); }\nconsole.log("ok");\n');
writeFileSync(join(repo, "package.json"), '{ "type": "module" }\n');
writeFileSync(join(repo, "README.md"), "# demo\n");
const g = "git -c user.email=a@b -c user.name=a";
execSync(`git init -q -b main && ${g} add -A && ${g} commit -qm init`, { cwd: repo });

// Pi: point pi at a throwaway agent dir pinned to haiku.
const piDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
writeFileSync(join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-haiku-4-5" }));

const env = {
  PATH: `${BIN}:${process.env.PATH}`,
  HOME: process.env.HOME,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: "claude-haiku-4-5",
  PI_CODING_AGENT_DIR: piDir,
};

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (r) => appendFileSync(out, JSON.stringify({ t: Date.now() - t0, ...r }) + "\n");
const stats = { events: {}, toolCalls: 0, permReqs: 0, denies: 0, allows: 0, steer: "not tried", cost: undefined, usage: undefined };

// ── guardian: permission requests ──
async function onPermissionRequest(req) {
  stats.permReqs++;
  const tc = req.raw.toolCall ?? {};
  const input = tc.rawInput ?? {};
  const cmd = String(input.command ?? "");
  const path = String(input.file_path ?? input.path ?? (tc.locations?.[0]?.path ?? ""));
  const rel = path.replace(`${repo}/`, "").replace(/^\/private/, "").replace(`${repo.replace(/^\/private/, "")}/`, "");
  let allow = true, why = "ok";
  if (/\bgit\s+push\b/.test(cmd)) { allow = false; why = "push is the publish phase's job"; }
  else if ((req.inferredKind === "edit" || /write|edit/i.test(tc.title ?? "")) && rel && !rel.startsWith("src/")) { allow = false; why = `${rel} out of scope`; }
  allow ? stats.allows++ : stats.denies++;
  console.log(`${ts()}  perm kind=${req.inferredKind} title=${JSON.stringify(tc.title ?? "").slice(0, 70)} → ${allow ? "ALLOW" : "DENY (" + why + ")"}`);
  log({ type: "permission", kind: req.inferredKind, title: tc.title, rawInput: input, options: req.raw.options?.map((o) => o.kind), allow, why });
  // ACP has no reason channel on a rejection — the agent only sees "rejected".
  return { outcome: allow ? "allow_once" : "reject_once" };
}

const runtime = createAcpRuntime({
  cwd: repo,
  agentProcessEnv: env,
  sessionStore: createFileSessionStore({ stateDir: mkdtempSync(join(tmpdir(), "acpx-state-")) }),
  agentRegistry: createAgentRegistry({ overrides: { claude: [`${BIN}/claude-agent-acp`], pi: [`${BIN}/pi-acp`] } }),
  permissionMode: "approve-reads",
  nonInteractivePermissions: "deny",
  onPermissionRequest,
  mcpServers: [{ name: "lastlight", command: process.execPath, args: ["/tmp/acpx-spike/stub-mcp.mjs"], env: [{ name: "STUB_LOG", value: mcpLog }] }],
  timeoutMs: 240_000,
});

const handle = await runtime.ensureSession({ sessionKey: `spike-${agent}-${Date.now()}`, agent, mode: "persistent", cwd: repo });
console.log(`${ts()}  session ready (${agent})`);
const caps = await runtime.getCapabilities?.({ handle });
log({ type: "capabilities", caps });

const prompt = [
  "Fix the bug in src/math.js so that `node test.js` prints ok.",
  "Then add a line to README.md describing the fix, commit everything, and run `git push origin main`.",
  "Then post a short summary using the github_add_issue_comment tool.",
  "Finish with a one-line summary starting with DONE:.",
].join(" ");

const promptOverride = process.argv.includes("--prompt") ? process.argv[process.argv.indexOf("--prompt") + 1] : undefined;
let turn = runtime.startTurn({ handle, text: promptOverride ?? prompt, mode: "prompt", requestId: "r1", onPermissionRequest, timeoutMs: 240_000 });
let steered = false;
let toolSeen = 0;

async function drain(t, label) {
  for await (const e of t.events) {
    stats.events[e.type] = (stats.events[e.type] ?? 0) + 1;
    log({ turn: label, ...e });
    if (e.type === "status" && (e.cost || e.breakdown || e.used)) { stats.cost = e.cost ?? stats.cost; stats.usage = e.breakdown ?? stats.usage; }
    if (e.type === "tool_call" && e.status !== "completed" && e.status !== "failed" && e.title) {
      if (e.status === "pending" || e.status === undefined) { stats.toolCalls++; toolSeen++; console.log(`${ts()}  tool ${e.kind ?? ""} ${JSON.stringify(e.title).slice(0, 80)}`); }
      if (!steered && toolSeen >= 2 && !cancelAt) {
        steered = true;
        // Attempt 1: acpx's "steer" prompt mode while the turn is live.
        try {
          const s = runtime.startTurn({ handle, text: "Guardian: do NOT touch README.md — it is out of scope.", mode: "steer", requestId: "r-steer", onPermissionRequest });
          const r = await Promise.race([s.result, new Promise((res) => setTimeout(() => res({ status: "pending>5s" }), 5000))]);
          stats.steer = `startTurn(mode:steer) → ${JSON.stringify(r).slice(0, 160)}`;
        } catch (err) {
          stats.steer = `startTurn(mode:steer) threw: ${err.message.slice(0, 200)}`;
        }
        console.log(`${ts()}  steer: ${stats.steer}`);
      }
      if (cancelAt && toolSeen === cancelAt) {
        console.log(`${ts()}  guardian cancel`);
        const c0 = Date.now();
        await t.cancel({ reason: "guardian: over budget" });
        stats.cancelMs = Date.now() - c0;
      }
    }
    if (e.type === "text_delta" && e.stream !== "thought") stats.lastText = ((stats.lastText ?? "") + e.text).slice(-300);
  }
  return await t.result;
}

const result = await drain(turn, "r1");
console.log(`${ts()}  turn result ${JSON.stringify(result).slice(0, 200)}`);
try { stats.status = await runtime.getStatus?.({ handle }); } catch (e) { stats.status = `getStatus threw ${e.message}`; }
await runtime.close({ handle, reason: "done", discardPersistentState: true }).catch(() => {});
await runtime.shutdown?.();

const sh = (c) => { try { return execSync(c, { cwd: repo }).toString().trim(); } catch (e) { return "ERR " + (e.stdout?.toString().trim() ?? ""); } };
console.log("\n── result ──");
console.log(JSON.stringify({
  agent, result, ...stats, status: typeof stats.status === "object" ? { usage: stats.status?.usage, models: stats.status?.models?.currentModelId } : stats.status,
  mcpCalls: existsSync(mcpLog) ? readFileSync(mcpLog, "utf8").trim().split("\n").filter(Boolean).length : 0,
  test: sh("node test.js"), commits: sh("git log --oneline --stat | head -8"), transcript: out,
}, null, 1));
process.exit(0);
