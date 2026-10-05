/**
 * `agentic-pi mcp-github` — the GitHub tools over stdio MCP, for non-Pi
 * runtimes (SPIKE — spike/live-sessions).
 *
 * The Pi path never uses MCP: Pi gets these same tools natively via
 * `customTools`. ACP runtimes (Claude Code, Codex, OpenCode) can only take
 * extra tools over MCP, so the ACP runner points them at this subcommand.
 *
 * It is a generic adapter over Pi `ToolDefinition`s — `parameters` is TypeBox,
 * i.e. JSON Schema already, and the GitHub tools never touch the extension
 * context — so the tool code is shared, not forked. Profile gating happens at
 * registration exactly as on the Pi path (hard rule 5): disallowed tools are
 * never listed.
 *
 * Only `process.stdout` is the MCP transport here; diagnostics go to stderr.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { isGitAccessProfile, loadGitHubExtension } from "./extensions/github/index.js";

/** MCP server name — ACP agents surface tools as `mcp__<server>__<tool>`. */
export const MCP_SERVER_NAME = "lastlight";

export function createToolServer(tools: ToolDefinition<any>[]): Server {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const server = new Server({ name: MCP_SERVER_NAME, version: "0.0.0-spike" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as { type: "object"; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = byName.get(req.params.name);
    if (!tool) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
    try {
      const res = await tool.execute(
        String(extra.requestId),
        (req.params.arguments ?? {}) as never,
        extra.signal,
        undefined,
        {} as never,
      );
      const content = (res.content ?? []).map((c) =>
        c.type === "text" ? { type: "text" as const, text: c.text } : { type: "text" as const, text: JSON.stringify(c) },
      );
      return { content, isError: (res as { isError?: boolean }).isError === true };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  });
  return server;
}

/** CLI entry: `agentic-pi mcp-github --profile <p> [--github-api-url <url>]`. */
export async function mcpGithubMain(argv: string[]): Promise<number> {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const profile = get("--profile");
  if (profile !== undefined && !isGitAccessProfile(profile)) {
    process.stderr.write(`agentic-pi mcp-github: bad --profile '${profile}'\n`);
    return 2;
  }
  const github = loadGitHubExtension(profile, { baseUrl: get("--github-api-url") ?? process.env.GITHUB_API_URL });
  if (github.status !== "configured") {
    process.stderr.write(`agentic-pi mcp-github: github tools disabled (${github.reason}) ${github.message ?? ""}\n`);
  }
  const server = createToolServer(github.customTools);
  await server.connect(new StdioServerTransport());
  // Stay alive until the client closes stdin.
  await new Promise<void>((resolve) => process.stdin.on("close", resolve));
  return 0;
}
