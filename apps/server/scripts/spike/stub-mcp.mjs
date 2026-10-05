// Stub "lastlight" MCP server: one GitHub-shaped tool that records its calls.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync } from "node:fs";
import { z } from "zod";
const server = new McpServer({ name: "lastlight", version: "0.0.1" });
server.tool(
  "github_add_issue_comment",
  "Post a comment on the GitHub issue for this task.",
  { body: z.string() },
  async ({ body }) => {
    appendFileSync(process.env.STUB_LOG ?? "/tmp/acpx-spike/mcp-calls.log", JSON.stringify({ body }) + "\n");
    return { content: [{ type: "text", text: "comment posted (id 1)" }] };
  },
);
await server.connect(new StdioServerTransport());
