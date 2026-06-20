# agentic-pi — agent-facing guide

You are working inside the **agentic-pi** repo. This document is the
project's "agent personality" — it is auto-loaded by Pi (and by agentic-pi
itself) as part of the system prompt when an agent runs in this directory.
The full user-facing docs are in `README.md`; this file is the
condensed orientation you need to be useful immediately.

## What this project is

A pre-configured, opinionated wrapper around
[earendil-works/pi](https://github.com/earendil-works/pi) that turns Pi into
a one-shot, JSONL-emitting coding-agent worker for workflow orchestrators
(target consumer: [lastlight](https://github.com/cliftonc/lastlight)).

It is **not** a fork of Pi. It does not modify Pi. It composes Pi's SDK
(`@earendil-works/pi-coding-agent`) with three extras:

1. Two entry points with the same underlying behaviour:
   - A **CLI** (`agentic-pi run`) that reads stdin, emits JSONL on
     stdout, exits on `agent_end`.
   - A **library API** (`import { run } from "agentic-pi"`) that
     returns a fully-derived `RunResult` and never touches
     `process.stdout` / `process.stderr`.
2. A native GitHub-tool extension (~31 tools, profile-gated) that
   replaces the MCP server lastlight used to spawn separately.
3. An optional Gondolin micro-VM sandbox for `read`/`write`/`edit`/`bash`.

## What to read first

| If you're … | Read |
| --- | --- |
| Getting oriented end-to-end | `README.md` |
| Understanding why decisions are opinionated | `README.md` — "What this is opinionated about" section |
| Calling agentic-pi from your own Node code | `README.md` — "Programmatic usage" section, then `src/run.ts` and `src/index.ts` |
| Building or modifying the CLI | `src/cli.ts`, `src/args.ts`, `src/runner.ts` |
| Touching the JSONL event stream | `src/emitter.ts`, `src/runner.ts` |
| Adding or modifying a GitHub tool | `src/extensions/github/tools.ts` (one defineTool per tool) |
| Understanding why we don't sandbox in Docker | `SPIKE-gondolin.md` |
| Changing sandbox behavior | `src/sandbox/{index,preflight,gondolin}.ts` |
| Looking for the original plan | `/Users/clifton/.claude/plans/i-have-a-project-quiet-fairy.md` |

## Codebase layout

```
src/
  cli.ts                  CLI entry. Parses argv, reads stdin, calls runOnce with a StdoutSink.
  index.ts                Public library API: run, RunResult, sinks, types.
  run.ts                  Programmatic entry: run() — builds CollectorSink, returns RunResult.
  args.ts                 Flag parser. Source of truth for the CLI surface.
  stdin.ts                Stdin slurp.
  emitter.ts              Sink abstraction (Stdout/Collector/Tee) + Emitter.
                          The runner emits through this; CLI and run() wire different sinks.
  models.ts               "provider/id" → getModel(provider, id) from pi-ai.
  runner.ts               Drives Pi: createAgentSession → subscribe → prompt → agent_end.
                          Sink-agnostic — takes an EmitterSink + onWarn callback as deps.
  extensions/github/
    index.ts              loadGitHubExtension(profile) — entry. Returns {customTools, ...}.
    auth.ts               GitHub App JWT → installation token. Static-token fallback.
    client.ts             Octokit wrapper with retry/backoff (ported from mcp-github-app).
    credentials.ts        git credential-store file writer (mode 600, regex-validated).
    profiles.ts           4 profile names → tool name allowlists.
    tools.ts              ~31 defineTool() registrations, github_ prefix.
  extensions/skills/
    index.ts              loadSkillsExtension() — normalizes --skill paths (tilde/
                          relative → absolute, drops missing). Skills are a Pi-native
                          RESOURCE, not customTools: the runner feeds the result into
                          DefaultResourceLoader.additionalSkillPaths / noSkills (same
                          channel file-search uses for additionalExtensionPaths). Pi
                          discovers default-location skills on its own.
                          buildSkillsStatusEvent() synthesizes a gated `skills_status`
                          JSONL event (Pi emits none) — suppressed on a default run
                          with zero skills so fixtures stay byte-identical.
  sandbox/
    index.ts              buildSandbox(backend) dispatcher. Returns ok|err.
    preflight.ts          QEMU + accelerator detection. Returns structured result.
    gondolin.ts           VM.create lifecycle + tool overrides for read/write/edit/bash.
  telemetry/
    index.ts              createTelemetry(deps) → TelemetryHandle. No-op + no SDK
                          import when disabled; dynamic-imports sdk.ts when enabled.
    config.ts             resolveTelemetryConfig() (enablement precedence) + redact().
    sdk.ts                OTEL SDK construction (providers/exporters/propagator).
                          Diagnostics routed to onWarn — never the console.
    mapper.ts             Pi event stream → span tree (session/turn/tool/llm) + metrics.
    semconv.ts            Centralized gen_ai.* / agentic_pi.* attribute + metric names.

test/fixtures/            Golden JSONL streams from real runs. Treat as contract evidence.
docker/                   Reserved for future container image work. Currently empty.

README.md                 User docs.
AGENTS.md                 This file. Agent-facing orientation.
SPIKE-gondolin.md         Spike write-up: why sandbox is native-only.
```

## Hard rules — non-negotiable

1. **No `mcp-github-app` re-introduction.** Pi has no MCP support and we
   deliberately don't add it. GitHub tools are native Pi tools registered
   via `defineTool()`. If you find yourself reaching for `@modelcontextprotocol/sdk`,
   stop and check with the user first.

2. **Don't touch the JSONL event shape without a fixture update.**
   `test/fixtures/*.jsonl` are contract evidence. If you change emit
   behavior, capture a new fixture in the same shape (run the smoke
   commands at the bottom of this file) and replace the old one in the
   same PR.

3. **Pi SDK names (`createAgentSession`, `session.subscribe`,
   `session.prompt`, `session.getSessionStats`, `defineTool`,
   `getModel`, `createReadTool` and friends) are the public contract
   with Pi.** If you need a Pi internal that's not in
   `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`,
   either find a public alternative or open a discussion — don't reach
   into Pi internals via deep-path imports.

4. **The CLI accepts opencode-shaped flags for caller-side compatibility.**
   `--dangerously-skip-permissions` is a deliberate no-op. `--variant` is
   an alias for `--thinking`. Do not "clean these up" — lastlight (and
   any other opencode-shaped caller) still passes them. Removing them
   would break the swap-in promise.

5. **Profile is registration-time, not runtime.** The GitHub profile gate
   removes tools from the customTools list before `createAgentSession`
   runs. The LLM never sees disallowed tools in its system prompt. Don't
   add runtime "is this allowed?" checks — they're strictly weaker.

6. **The Gondolin sandbox is native-only.** Do not pretend it works in
   Docker. See `SPIKE-gondolin.md` for the empirical evidence. The
   preflight check exists *specifically* to refuse to run rather than
   inherit upstream issue #51's silent-hang failure mode. Do not remove
   it or downgrade it to a warning.

7. **The library path (`run()`) must never write to `process.stdout` or
   `process.stderr`.** A consumer importing agentic-pi from their own
   Node code controls all I/O. The CLI is the one place we touch those
   streams — by wiring `StdoutSink` and an `onWarn` callback into
   `runOnce`. If you find yourself adding a `console.log` or
   `process.stderr.write` *inside* the runner, sandbox, or extensions,
   route it through the emitter or the warn callback instead. The
   contract test `test/run.integration.test.ts` enforces this by running
   `run()` in a child process and asserting empty stdout/stderr.

8. **The GitHub App PEM must never enter the sandbox VM.** Only minted
   installation tokens cross the host→guest boundary. The runner mints
   the token via `github.auth.getToken()` *before* the sandbox boots
   and passes only the resulting string to `buildSandbox({ env })`. If
   you find yourself adding `GITHUB_APP_PRIVATE_KEY_PATH` or similar to
   the `sandboxEnv` composition in `runner.ts`, stop — that path leaks
   long-lived credentials into a short-lived sandbox, which defeats
   the whole point. Use the existing `auth` exposed on
   `GitHubExtensionResult` instead.

## Style and conventions

- **TypeScript, strict mode.** ESM. `moduleResolution: "NodeNext"`, so
  relative imports must use `.js` extensions even though the source is
  `.ts` (TypeScript resolves `./foo.js` → `./foo.ts` at compile time).
  Don't drop the extensions.

- **No comments that restate the code.** Comments earn their place by
  explaining *why* — typically a constraint, a workaround, or a
  reference to an external doc / upstream issue. If removing the comment
  would not confuse a future reader, don't write it.

- **Errors surface explicitly to the JSONL stream.** Catch at the runner
  boundary and emit `fatal_error` / `usage_snapshot_error` / etc. Never
  let a throw propagate to `process.exit(1)` without a stream record.

- **Status fields are enumerated strings, not booleans.** See
  `GitHubExtensionResult.status` (`"configured" | "skipped"`),
  `extension_status.reason` (`"no-profile" | "no-credentials" | ...`),
  `PreflightStatus`. Adding new states is cheap; refactoring booleans
  to strings later is not.

## Commands

```bash
# Install (one-time)
npm install

# Build (TypeScript → dist/)
npm run build

# Run with built-in tools only, no GitHub, no sandbox
echo "list files in src/" | node dist/cli.js run \
  --model openai/gpt-5.4-nano --thinking off --no-session

# Run with GitHub tools (read profile)
echo "list open PRs on owner/repo" | node dist/cli.js run \
  --model openai/gpt-5.4-nano --thinking off --no-session \
  --profile read

# Run with Gondolin sandbox (requires QEMU on host; native only)
echo "create a file note.txt with 'hello' in it" | node dist/cli.js run \
  --model openai/gpt-5.4-nano --thinking off --no-session \
  --sandbox gondolin --cwd /tmp/scratch

# Tests
npm test                  # full suite — integration tests skip if env not set
npm run test:unit         # unit only (~170 ms, no API keys, no QEMU)
npm run test:integration  # integration only (needs OPENAI_API_KEY; sandbox needs QEMU too)

# Type-check only
npx tsc --noEmit
```

Tests live in `test/` as `*.test.ts` files; integration tests use
`*.integration.test.ts` so the runner can include / exclude them. Discovery
is via `scripts/run-tests.mjs` (a tiny walker — Node's `node --test`
discovery doesn't pick up `.ts` files automatically).

## CI and releases

Two GitHub Actions workflows ship with the repo:

- `.github/workflows/ci.yml` runs on every push to `main` and every PR:
  type-check, build, unit tests, integration tests (gated on the
  `OPENAI_API_KEY` secret — auto-skipped if absent).
- `.github/workflows/publish.yml` runs on `v*.*.*` tag pushes. It
  verifies the tag matches `package.json`, then runs `npm publish
  --provenance --access public` via npm's OIDC trusted-publisher flow
  (no `NPM_TOKEN` needed in the repo).

To release: bump `package.json`, commit, `git tag vX.Y.Z && git push
--tags`. Workflow does the rest.

Env vars typically needed (mirror lastlight's `.env` when developing):

```bash
OPENAI_API_KEY=…              # or ANTHROPIC_API_KEY / OPENROUTER_API_KEY
GITHUB_APP_ID=…
GITHUB_APP_PRIVATE_KEY_PATH=/abs/path/to.pem
GITHUB_APP_INSTALLATION_ID=…
# or, for low-trust fallback:
GITHUB_TOKEN=ghp_…
```

## How to contribute changes

1. **Read `README.md`** to understand the surface you're changing.
2. **Make the smallest change that compiles and re-captures a fixture**
   for affected smoke commands. Don't refactor adjacent code.
3. **Run `npm run build`** — must be clean.
4. **Re-run the smoke command for whatever you touched.** If you changed
   GitHub-tool wiring, run the `--profile read` smoke; if you touched
   the sandbox, run the `--sandbox gondolin` smoke. Replace the matching
   fixture under `test/fixtures/`.
5. **Update the README only if user-visible behavior changed.** The
   README is the contract with the orchestrator (lastlight). Don't
   document internal refactors there.
6. **Update AGENTS.md (this file) only if the development workflow itself
   changed** — new build steps, new layout, new hard rules. If you only
   added a feature, the README is enough.

## Known sharp edges

- Pi v0.75.x has its own `node_modules/@earendil-works/pi-agent-core`
  nested inside `node_modules/@earendil-works/pi-coding-agent/node_modules/`.
  Don't import from there directly — go through pi-coding-agent's re-exports.
- `@types/jsonwebtoken` got pinned to dependencies (not devDependencies)
  by an earlier `npm install`. It's harmless but if you do a clean
  package.json pass it should move to devDependencies.
- Pi's typed model registry (`getModel("openai", "gpt-5.5")`) uses
  literal-string indexed keys. We pass dynamic strings, so `models.ts`
  casts via `as unknown as`. Don't try to make this strictly typed —
  it'd require enumerating every model id at compile time.
- The Gondolin guest image (~89 MB) downloads on first VM.create per
  user. Cached at `~/.cache/gondolin/`. If you blow that cache away,
  the first run is slow again.

## Why these conventions

Most of this exists because the project is being driven from a single
plan doc (`/Users/clifton/.claude/plans/i-have-a-project-quiet-fairy.md`)
across multiple agent sessions. Consistency between sessions is more
valuable than local optimization. When in doubt, mirror the existing
shape of nearby code rather than introducing a new pattern.
