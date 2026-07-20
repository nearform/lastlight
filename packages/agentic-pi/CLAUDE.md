# agentic-pi — the canonical agent guide

This is the **canonical, detailed guide** for the `agentic-pi` package —
codebase layout, hard rules, conventions, smoke commands, and known sharp edges.
Read it before non-trivial work. `AGENTS.md` in this directory is a thin pointer
back here; the full *user-facing* docs are in `README.md`.

> `agentic-pi` is published to npm independently and moved in from the standalone
> `nearform/agentic-pi` repo; it stays a self-contained leaf (no workspace deps).
> The monorepo consumes it via `workspace:*`; the sandbox images **vendor** it
> from the workspace (not npm). See the [root `CLAUDE.md`](../../CLAUDE.md).

## What this project is

A pre-configured, opinionated wrapper around
[earendil-works/pi](https://github.com/earendil-works/pi) that turns Pi into
a one-shot, JSONL-emitting coding-agent worker for workflow orchestrators
(target consumer: [lastlight](https://github.com/nearform/lastlight); designed to
swap in for opencode).

It is **not** a fork of Pi. It does not modify Pi. It composes Pi's SDK
(`@earendil-works/pi-coding-agent`) and adds extensions on top:

1. Two entry points with the same underlying behaviour:
   - A **CLI** (`agentic-pi run`) that reads stdin, emits JSONL on
     stdout, exits on `agent_end`.
   - A **library API** (`import { run } from "agentic-pi"`) that
     returns a fully-derived `RunResult` and **never** touches
     `process.stdout` / `process.stderr`.
2. A native GitHub-tool extension (~32 tools, profile-gated) that
   replaces the MCP server lastlight used to spawn separately.
3. An optional Gondolin micro-VM sandbox for `read`/`write`/`edit`/`bash`.

The flow is **sink-agnostic**: `runner.ts` drives Pi and emits events through an
`Emitter`/`EmitterSink` (`emitter.ts`). The CLI wires a `StdoutSink`; the library
wires a `CollectorSink`. This is what keeps `run()` silent on the process streams.

## What to read first

| If you're … | Read |
| --- | --- |
| Getting oriented end-to-end | `README.md` |
| Understanding why decisions are opinionated | `README.md` — "What this is opinionated about" |
| Calling agentic-pi from your own Node code | `README.md` — "Programmatic usage", then `src/run.ts` + `src/index.ts` |
| Building or modifying the CLI | `src/cli.ts`, `src/args.ts`, `src/runner.ts` |
| Touching the JSONL event stream | `src/emitter.ts`, `src/runner.ts` |
| Adding or modifying a GitHub tool | `src/extensions/github/tools.ts` (one defineTool per tool) |
| Understanding why we don't sandbox in Docker | `SPIKE-gondolin.md` |
| Changing sandbox behavior | `src/sandbox/{index,preflight,gondolin}.ts` |

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
  retry.ts                resolveRetrySettings() — flag > settings.json > our
                          bumped defaults (5 retries / 4s base) for transient-
                          error backoff. runner builds a SettingsManager and
                          applyOverrides({retry}) so Pi rides out per-minute
                          rate-limit windows (e.g. Fireworks TPM). Pure/testable.
  runner.ts               Drives Pi: createAgentSession → subscribe → prompt → agent_end.
                          Sink-agnostic — takes an EmitterSink + onWarn callback as deps.
  extensions/github/
    index.ts              loadGitHubExtension(profile) — entry. Returns {customTools, ...}.
    auth.ts               GitHub App JWT → installation token. Static-token fallback.
    client.ts             Octokit wrapper with retry/backoff (ported from mcp-github-app).
    credentials.ts        gitAuthEnv() — github.com-scoped http.extraheader (GIT_CONFIG_*), no on-disk file.
    profiles.ts           4 profile names → tool name allowlists.
    tools.ts              ~32 defineTool() registrations, github_ prefix.
  extensions/web-search/  Optional web_search / web_fetch via Tavily/Brave/Exa,
                          with SSRF-safe fetch + rate limiting.
  extensions/file-search/ Bundles FFF (@ff-labs/pi-fff), a Rust-backed fuzzy
                          file/content search, as the DEFAULT. Contributes no
                          customTools — a Pi-native resource (PI_FFF_MODE env).
  extensions/skills/
    index.ts              loadSkillsExtension() — normalizes --skill paths (tilde/
                          relative → absolute, drops missing). Skills are a Pi-native
                          RESOURCE, not customTools: fed into
                          DefaultResourceLoader.additionalSkillPaths / noSkills. Pi
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
AGENTS.md                 Thin pointer to this file (the cross-tool standard entry).
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

- **Mirror the shape of nearby code** rather than introducing a new pattern —
  consistency across agent sessions is valued over local optimization.

## Commands

```bash
npm install               # one-time
npm run build             # tsc → dist/
npm run check             # tsc --noEmit (type-check only)
npm run lint              # biome lint — the lint-only gate CI runs
npm run format            # biome format --write (rewrite to formatter style)
npm run fix               # biome check --write (safe lint fixes + format)
npm test                  # full suite — integration tests skip if env unset
npm run test:unit         # unit only (~170 ms, no API keys, no QEMU)
npm run test:integration  # integration only (needs OPENAI_API_KEY; sandbox needs QEMU too)
```

Run a single test file directly (the runner discovers `*.test.ts` via
`scripts/run-tests.mjs`; `node --test` doesn't find `.ts`):

```bash
npx tsx --test test/args.test.ts
```

Biome is the lint + format tool (`biome.json`). CI runs `npm run lint`
(**lint-only** — formatting is deliberately *not* enforced, so whitespace drift
never reds a PR; keep it tidy with `npm run format`). Biome is scoped to
`src|test/**/*.ts` + `scripts/**/*.mjs` and **never touches
`test/fixtures/*.jsonl`** (contract evidence). `noNonNullAssertion` and
`noExplicitAny` are relaxed (both deliberate here).

### Smoke commands (re-capture fixtures with these)

```bash
# Built-in tools only, no GitHub, no sandbox
echo "list files in src/" | node dist/cli.js run \
  --model openai/gpt-5.4-nano --thinking off --no-session

# GitHub tools (read profile)
echo "list open PRs on owner/repo" | node dist/cli.js run \
  --model openai/gpt-5.4-nano --thinking off --no-session --profile read

# Gondolin sandbox (requires QEMU on host; native only)
echo "create a file note.txt with 'hello' in it" | node dist/cli.js run \
  --model openai/gpt-5.4-nano --thinking off --no-session \
  --sandbox gondolin --cwd /tmp/scratch
```

Env vars typically needed when developing (mirror lastlight's `.env`):

```bash
OPENAI_API_KEY=…              # or ANTHROPIC_API_KEY / OPENROUTER_API_KEY
GITHUB_APP_ID=…
GITHUB_APP_PRIVATE_KEY_PATH=/abs/path/to.pem
GITHUB_APP_INSTALLATION_ID=…
# or, for low-trust fallback:
GITHUB_TOKEN=ghp_…
```

## CI and releases

Two GitHub Actions workflows ship with the package (they run in the monorepo's
`.github/workflows/`):

- **CI** runs on every push to `main` and every PR: lint (Biome), type-check,
  build, unit tests, integration tests (gated on the `OPENAI_API_KEY` secret —
  auto-skipped if absent).
- **`agentic-pi-npm.yml`** publishes to npm when a **GitHub Release is published**
  (`release: published`) — pushing a tag alone does NOT publish. It verifies the
  tag matches `package.json`, then `npm publish --provenance --access public` via
  npm's OIDC trusted-publisher flow (no `NPM_TOKEN`). agentic-pi also carries an
  `image-v*` VM-image release stream (`agentic-pi-image.yml`).

To release: bump `package.json`, commit, `git tag vX.Y.Z && git push origin main
vX.Y.Z`, then create the GitHub Release for that tag (`gh release create vX.Y.Z
--title vX.Y.Z --notes …`) — publishing the release is the "ship it" signal.

## How to contribute changes

1. **Read `README.md`** to understand the surface you're changing.
2. **Make the smallest change that compiles and re-captures a fixture** for
   affected smoke commands. Don't refactor adjacent code.
3. **Run `npm run lint` and `npm run build`** — both must be clean (`npm run fix`
   auto-resolves most nits).
4. **Re-run the smoke command for whatever you touched** and replace the matching
   fixture under `test/fixtures/`.
5. **Update `README.md` only if user-visible behavior changed** — it's the
   contract with the orchestrator (lastlight). Don't document internal refactors.
6. **Update this file only if the development workflow itself changed** — new
   build steps, layout, or hard rules. A new feature alone → the README is enough.

## Known sharp edges

- Pi v0.75.x has its own `node_modules/@earendil-works/pi-agent-core`
  nested inside `node_modules/@earendil-works/pi-coding-agent/node_modules/`.
  Don't import from there directly — go through pi-coding-agent's re-exports.
- Pi's typed model registry (`getModel("openai", "gpt-5.5")`) uses
  literal-string indexed keys. We pass dynamic strings, so `models.ts`
  casts via `as unknown as`. Don't try to make this strictly typed —
  it'd require enumerating every model id at compile time.
- The Gondolin guest image (~89 MB) downloads on first `VM.create` per
  user. Cached at `~/.cache/gondolin/`. Blow the cache away and the first
  run is slow again.
