#!/usr/bin/env node
// Ad-hoc smoke for the agentic-pi web-search extension wiring.
// Reads .env, calls `run()` twice with webSearch:true and webSearch:false,
// prints the extension_status for each so we can see "configured" vs "skipped".
//
// Usage: node scripts/web-search-smoke.mjs

import { readFileSync } from "fs";
import { resolve } from "path";
import { run } from "agentic-pi";

// Light .env loader (we don't want to pull dotenv just for this).
try {
  const txt = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[1].startsWith("#")) continue;
    const k = m[1];
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
} catch {}

const haveKey =
  !!process.env.TAVILY_API_KEY ||
  !!process.env.BRAVE_SEARCH_API_KEY ||
  !!process.env.EXA_API_KEY;

console.log("=== web-search-smoke ===");
console.log("TAVILY_API_KEY present:", !!process.env.TAVILY_API_KEY);
console.log("BRAVE_SEARCH_API_KEY present:", !!process.env.BRAVE_SEARCH_API_KEY);
console.log("EXA_API_KEY present:", !!process.env.EXA_API_KEY);
if (!haveKey) {
  console.error("No web search provider key set — aborting.");
  process.exit(2);
}

const model =
  process.env.LASTLIGHT_MODEL ||
  process.env.OPENCODE_MODEL ||
  "anthropic/claude-haiku-5-5";

async function trial(label, webSearch) {
  console.log(`\n--- trial: ${label} (webSearch=${webSearch}) ---`);
  const records = [];
  const result = await run({
    model,
    prompt:
      webSearch
        ? "Use the web_search tool to find one recent headline about TypeScript, then stop. Reply with just the headline."
        : "Say the word PONG and stop.",
    sandbox: "none",
    noSession: true,
    webSearch,
    onEvent: (r) => records.push(r),
    onWarn: (m) => console.warn("[warn]", m),
  });

  console.log("  ok:", result.ok, " agentEnded:", result.agentEnded);
  console.log("  webSearch:", JSON.stringify(result.webSearch));
  console.log(
    "  finalText (first 200 chars):",
    JSON.stringify((result.finalText || "").slice(0, 200)),
  );
  const toolCalls = records
    .filter((r) => r.type === "tool_execution_start")
    .map((r) => r.toolName);
  console.log("  tool calls:", toolCalls);
  return result;
}

try {
  await trial("opt-in", true);
  await trial("opt-out", false);
  console.log("\n=== smoke complete ===");
} catch (err) {
  console.error("smoke failed:", err);
  process.exit(1);
}
