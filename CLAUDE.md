# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **`AGENTS.md` is the canonical, detailed agent guide for this repo** — codebase layout, hard rules, conventions, smoke commands, and known sharp edges. Read it before non-trivial work. This file is the condensed orientation.

## What this project is

`agentic-pi` is an opinionated wrapper around [earendil-works/pi](https://github.com/earendil-works/pi) that turns Pi into a one-shot, JSONL-emitting coding-agent worker for workflow orchestrators (target consumer: [lastlight](https://github.com/cliftonc/lastlight); designed to swap in for opencode). It is **not** a fork of Pi — it composes Pi's SDK (`@earendil-works/pi-coding-agent`) and adds extensions on top.

Two entry points, same underlying behaviour:
- **CLI** (`agentic-pi run`): reads stdin, emits JSONL on stdout, exits on `agent_end`.
- **Library** (`import { run } from "agentic-pi"`): returns a `RunResult`, **never** touches `process.stdout`/`process.stderr`.

## Commands

```bash
npm install              # one-time
npm run build            # tsc → dist/
npm run check            # tsc --noEmit (type-check only)
npm test                 # full suite (integration auto-skips if env unset)
npm run test:unit        # unit only (~170ms, no API keys / QEMU)
npm run test:integration # needs OPENAI_API_KEY; sandbox tests need QEMU too
```

Run a single test file directly (the runner discovers `*.test.ts`; `node --test` doesn't find `.ts`):
```bash
npx tsx --test test/args.test.ts
```

Smoke a run end-to-end:
```bash
echo "list files in src/" | node dist/cli.js run \
  --model openai/gpt-5.4-nano --thinking off --no-session
```

## Architecture

The flow is **sink-agnostic**: `runner.ts` drives Pi and emits events through an `Emitter`/`EmitterSink` (`emitter.ts`). The CLI wires a `StdoutSink`; the library wires a `CollectorSink`. This is what keeps `run()` silent on the process streams.

- `runner.ts` — drives Pi: `createAgentSession` → `subscribe` → `prompt` → `agent_end`. Takes an `EmitterSink` + `onWarn` callback as deps. Catches at the boundary and emits `fatal_error` / `usage_snapshot_error` rather than throwing to `process.exit`.
- `cli.ts` / `run.ts` — the two entry points that wire different sinks into the runner.
- `args.ts` — flag parser; **source of truth for the CLI surface**.
- `models.ts` — `"provider/id"` string → `getModel(provider, id)` from pi-ai.

Extensions live in `src/extensions/`, each "safe by default" (skip with an enumerated reason rather than aborting the run):
- `github/` — ~31 native Pi tools (`github_` prefix, registered via `defineTool()`), gated by **profile** (`read` | `issues-write` | `review-write` | `repo-write`). Profile filtering happens at registration time — the LLM never sees disallowed tools. Auth mints a short-lived installation token from a GitHub App JWT.
- `web-search/` — optional `web_search` / `web_fetch` via Tavily/Brave/Exa providers, with SSRF-safe fetch + rate limiting.
- `file-search/` — bundles FFF (`@ff-labs/pi-fff`), a Rust-backed fuzzy file/content search, as the **default**. Unlike the others, it contributes no `customTools`; it's a full Pi extension loaded via Pi's resource loader (`PI_FFF_MODE` env).
- `skills/` — wires the [Agent Skills standard](https://agentskills.io) into the run. Pi discovers `SKILL.md` skills from default locations natively; this module only normalizes operator-mapped `--skill <path>` folders (e.g. `~/.claude/skills`) into `DefaultResourceLoader.additionalSkillPaths` / `noSkills`. Like file-search, it's a Pi-native resource — **not** `customTools`. Pi emits no skill event, so the runner synthesizes a **gated** `skills_status` JSONL event (suppressed on a default run with zero skills, to keep fixtures byte-identical).

`sandbox/` — optional Gondolin micro-VM that routes Pi's `read`/`write`/`edit`/`bash` through a sandbox. **Native-only** (QEMU required); `preflight.ts` refuses to run rather than silently hang. See `SPIKE-gondolin.md`.

## Critical constraints (see AGENTS.md "Hard rules" for the full list + rationale)

- **No MCP / no `mcp-github-app`.** Pi has no MCP support; GitHub tools are native `defineTool()` registrations. Don't reach for `@modelcontextprotocol/sdk`.
- **`test/fixtures/*.jsonl` are contract evidence.** Don't change the JSONL event shape without re-capturing the matching fixture in the same PR.
- **Pi is a black box via its public SDK names** (`createAgentSession`, `session.subscribe/prompt/getSessionStats`, `defineTool`, `getModel`, `createReadTool`, …). Don't deep-import Pi internals.
- **`run()` must never write to `process.stdout`/`process.stderr`.** Route output through the emitter or the `onWarn` callback. Enforced by `test/run.integration.test.ts` (runs in a child process, asserts empty streams).
- **The GitHub App PEM must never enter the sandbox VM.** The runner mints a token via `github.auth.getToken()` before the sandbox boots and passes only that string in. Don't add `GITHUB_APP_PRIVATE_KEY_PATH` to the sandbox env.
- **opencode-shaped flags are intentional compat shims**, not cruft: `--dangerously-skip-permissions` is a deliberate no-op; `--variant` aliases `--thinking`. Don't remove them — callers still pass them.

## Conventions

- TypeScript strict, ESM, `moduleResolution: "NodeNext"` → **relative imports must use `.js` extensions** in `.ts` source. Don't drop them.
- Comments explain *why* (a constraint, workaround, or upstream-issue reference), never restate the code.
- Status fields are enumerated strings, not booleans (e.g. `status: "configured" | "skipped"`). Prefer adding a state to flipping a bool.
- Mirror the shape of nearby code rather than introducing a new pattern — consistency across agent sessions is valued over local optimization.

## Releasing

Bump `package.json`, commit, `git tag vX.Y.Z && git push --tags`. `.github/workflows/publish.yml` verifies the tag matches `package.json` and publishes via npm OIDC trusted-publisher (no `NPM_TOKEN`). `ci.yml` runs type-check/build/tests on push + PR (integration gated on the `OPENAI_API_KEY` secret).
