# 05 — Extracting the GitHub tools to an MCP server

> **2026-10-05: applies,** with the MCP server shipped as `agentic-pi
> mcp-github` (no bridge package). agentic-pi hard rule 1 becomes "the Pi path
> never uses MCP". Prompts are not forked per runtime; a generated
> system-prompt line maps `github_*` to the prefixed names ([README](README.md)
> decision 14).

## Constraints

- **agentic-pi is a leaf** with no workspace deps and its own npm stream.
- `shared` / `workflow-engine` never import core, and can't reach agentic-pi.
- The CLI never imports core.
- **agentic-pi stays MCP-free** (its hard rule 1).
- **Profile gating is registration-time** (its hard rule 5): the model never
  sees a tool it isn't allowed.

So the shared tool module **must physically live in agentic-pi**. It is the
only place both agentic-pi and the bridge can reach without breaking a rule.

## Refactor inside agentic-pi

`extensions/github/tools.ts` already funnels every tool through one local
helper (`tools.ts:316-330`):

```ts
const tool = (name, description, parameters, handler) =>
  defineTool({ name, label: name, description, parameters,
    async execute(_id, params) { return safeRun(() => handler(params), auth.canRefresh); } });
```

Handlers are Pi-free, and the TypeBox schemas are already JSON Schema. The
split:

- **`extensions/github/core.ts`**: `buildGitHubToolSpecs(auth, {baseUrl, cwd})`
  returns `{name, description, parameters: TSchema, handler}[]`. `safeRun` and
  the JSON result shapes are unchanged. Imports TypeBox + Octokit only.
- **`tools.ts`** becomes the thin Pi adapter that wraps each spec with
  `defineTool`. `PROFILE_TOOLS` gating stays where it is.
- **`exports` map** in `package.json`: `.`, `./github-core`, `./command-policy`,
  `./gate-timeout`, **plus the existing `./dist/providers.js` deep path** that
  `apps/server/src/config/provider-registry.ts:29` imports. Adding an `exports`
  map without it would break core.

agentic-pi's JSONL fixtures must stay byte-identical; that is the regression
test for the refactor.

## The MCP server (in the bridge)

`lastlight-agent-bridge mcp-github --profile P --cwd DIR [--api-base-url URL]`:

- uses the low-level MCP `Server` with raw JSON Schema `inputSchema`, so
  TypeBox passes straight through;
- registers **only** `PROFILE_TOOLS[profile]`, keeping gating at registration;
- `chdir`s to `--cwd`, because tools resolve `process.cwd()` /
  `LASTLIGHT_WORKSPACE` (`tools.ts:~350,~485`);
- passes `--api-base-url` to Octokit, which is the evals fake-github seam;
- takes the already-minted `GITHUB_TOKEN` from env. **The App PEM never enters
  the sandbox** (agentic-pi hard rule 8 holds unchanged).

## Tool names in prompts

43 prompt, skill and agent-context files name `github_*` tools literally.
Through MCP, Claude sees `mcp__lastlight__github_add_issue_comment`, and
OpenCode sees its own prefix **[UNVERIFIED]**. Mitigations, cheapest first:

1. A one-line runtime preamble the bridge prepends: "tools named `github_X` in
   these instructions are exposed as `<prefix>github_X`".
2. Claude tool aliases, if supported **[UNVERIFIED]**.
3. Measure it: P3 counts tool-not-found errors per arm. If drift is real,
   template the tool names in prompts per runtime.

Consumers canonicalize names back (see [`02`](02-agent-event-schema.md)).

## Rejected alternatives

- **A new `lastlight-github-tools` package that agentic-pi depends on.** It
  breaks the leaf rule and couples agentic-pi's independent npm stream.
- **Put it in `shared`.** agentic-pi can't reach it.
- **Duplicate the tools.** 36 tools × drift.
- **Give non-Pi agents `gh` + a token only.** No profile gating, and the
  prompts' tool names don't exist.
