# Last Light — monorepo orientation

This is the **`nearform/lastlight` monorepo**: a pnpm + Turborepo workspace
holding the Last Light GitHub-maintenance agent, its CLI, its docs site, and its
eval harness. It was consolidated from three sibling repos
(`lastlight`, `lastlight-www`, `lastlight-evals`) — see
[`docs/plans/monorepo-migration/`](docs/plans/monorepo-migration/) for the
migration plan and locked decisions.

> **The full day-to-day dev guide lives in
> [`apps/server/CLAUDE.md`](apps/server/CLAUDE.md)** (with `lastlight-core`). Read
> that for runtime, architecture, commands, env vars, and deployment. Use this
> file only to find your way around the workspace; each package has its own
> `CLAUDE.md` for local detail.

## Workspace map

```
lastlight/                     # repo root — private orchestration package (lastlight-monorepo)
├── pnpm-workspace.yaml  turbo.json  tsconfig.base.json  pnpm-lock.yaml  .nvmrc (22)
├── instance/                  # deployment overlay — gitignored, host-only (present on prod hosts, never in the tree)
├── docs/                      # cross-cutting docs (migration plan, RELEASING.md)
├── .github/workflows/         # ci / publish / deploy-www / deploy-evals
├── apps/
│   ├── server/                # lastlight-core — the harness + server + Docker stack + ./evals barrel
│   │   ├── CLAUDE.md          # ← the full dev guide
│   │   ├── src/ config/ workflows/ skills/ agent-context/ deploy/ spec/ sandbox/ tests/
│   │   ├── Dockerfile  sandbox*.Dockerfile  docker-compose.yml  docker-bake.hcl
│   │   └── dashboard/         # @lastlight/dashboard — admin SPA (nested, private; CLAUDE.md)
│   ├── www/                   # lastlight-www (Astro) → lastlight.dev (private; CLAUDE.md)
│   └── evals/                 # lastlight-evals → evals.lastlight.dev (its own CLAUDE.md)
│       └── dashboard/         # @lastlight/evals-dashboard — nested, private (CLAUDE.md)
└── packages/                  # each package has its own CLAUDE.md
    ├── cli/                   # published "lastlight" — the lean global bin + host-local server cmds
    ├── code-facts/            # published "lastlight-code-facts" — deterministic PR analysis (bin: lastlight-facts)
    ├── shared/                # lastlight-shared — light modules used by cli + core
    ├── workflow-engine/       # lastlight-workflow-engine — core/ ports/ test-support/
    └── agentic-pi/            # published "agentic-pi" — the coding-agent harness core runs in the sandbox
```

## Published packages (seven)

`lastlight` (cli), `lastlight-core`, `lastlight-workflow-engine`,
`lastlight-shared`, `lastlight-code-facts`, `lastlight-evals`, and `agentic-pi`
— all unscoped (the `@lastlight` npm scope is held by an unrelated account).
Everything else is `private: true` (root, `lastlight-www`, both dashboards).
Publishing is **automated**: a GitHub Release fires `publish.yml`, which builds
the GHCR images then publishes **six** of them via OIDC trusted publishing (no
secret) — every one except `agentic-pi`, which has its own stream (below).
`agentic-pi` moved in from the standalone `nearform/agentic-pi` repo but stays a
public npm package (published independently via `agentic-pi-npm.yml`); it also
carries its own `image-v*` VM-image release stream (`agentic-pi-image.yml`). The
sandbox images no longer install it from npm — they **vendor** it from the
workspace (a `pnpm deploy` bundle built in `sandbox*.Dockerfile`), so the
sandbox's whole dependency tree is exactly what the lockfile resolved and CI
tested. The npm publish is for external consumers only, fully decoupled from what
the sandbox runs. See [`docs/RELEASING.md`](docs/RELEASING.md).

## Dependency graph (workspace edges)

`lastlight-workflow-engine` ← `lastlight-shared` ← {`lastlight` (cli),
`lastlight-core`} ← `lastlight-evals`. `agentic-pi` is a second leaf (no
workspace deps) consumed by `lastlight-core` + `lastlight-evals` (and the private
dashboard) via `workspace:*`. `lastlight-code-facts` is a **third leaf** (ts-morph
+ ast-grep, no workspace deps) consumed by the **CLI** — it ships there rather
than only in the sandbox image because the eval harness runs `--sandbox none` on
the host and can never see `/opt/lastlight/`. Invariants: **no edge from
`shared`/`workflow-engine` back to `core`** (`scripts/lint-import-boundaries.mjs`,
runs in `typecheck`); **the cli never gains an edge to `core`**. That script
replaced dependency-cruiser when the workspace moved to TypeScript 7 — dep-cruiser
refuses to parse TS >= 7 and *exits 0 anyway*, so the gate went green while seeing
nothing. Turbo `^build` orders
builds; there are no TS project references. Those invariants are why some logic
lives in `shared` rather than where you'd first look — e.g. the per-repository
`.lastlight/` config schema + bounds + merge
(`packages/shared/src/repo-config-schema.ts`, issue #180): core needs it at
runtime and the CLI needs it offline for `lastlight repo config validate`, and
`shared` is the only package both can reach.

## Logging — use the logger, never `console.*`

All operational output is **structured JSON** (one line per event, to stderr,
with an explicit `level`) so a log sink can filter by level instead of guessing.
Never write `console.log`/`warn`/`error` in runtime code — reach for the logger:

- **`lastlight-core` (`apps/server`)**: `import { logger } from "…/logging/logger.js"`,
  then `const log = logger("component")` at module scope and
  `log.info("message", { field, err })`. Component = the subsystem
  (`"router"`, `"dispatch"`, `"pr-state"`, …). Pass an `Error` as `err` — a
  serializer expands it; don't string-interpolate it into the message.
- **`lastlight-workflow-engine` and `lastlight-shared` (pino-free — the CLI
  depends on them)**: never import the pino logger. Use the injected
  `LoggerPort` — `const log = deps.ports.logger ?? noopLogger` (engine), or take
  a `log: LoggerPort = noopLogger` parameter and have core pass `logger("…")`
  (see `validateAssets`, `resolveTemplatedNumber`).
- **`lastlight` (cli)**: stays pino-free; `console.*` for user-facing terminal
  output is correct there.

Levels: `debug` (per-turn / high-volume), `info`, `warn`, `error`, `fatal`.
`LOG_LEVEL` / `LOG_FORMAT` env vars tune verbosity and pretty-printing.

## Commands (from the repo root)

```bash
pnpm install                       # one lockfile for the whole workspace
pnpm turbo run typecheck test build   # the CI gate — turbo skips untouched packages
pnpm dev                           # → pnpm --filter lastlight-core dev
pnpm --filter <pkg> <script>       # run a script in one package
```

Node is pinned to 22 (`.nvmrc`, `engines.node >= 22.12`). Per-package commands
(`npm run dev` etc.) referenced in `apps/server/CLAUDE.md` become
`pnpm --filter lastlight-core <script>` at the workspace level.

## Where the docs are

- [`apps/server/CLAUDE.md`](apps/server/CLAUDE.md) — the full dev guide (runtime,
  architecture, env, deployment) for `lastlight-core`.
- [`apps/server/src/workflows/CLAUDE.md`](apps/server/src/workflows/CLAUDE.md) —
  the workflow runner internals.
- [`apps/server/src/state/CLAUDE.md`](apps/server/src/state/CLAUDE.md) — the
  state layer: how to change the schema and migrate it on **both** dialects
  (SQLite + Postgres). Read before touching `src/state/schema/`.
- [`apps/server/spec/`](apps/server/spec/) — the rebuild-grade specification.
- [`apps/evals/CLAUDE.md`](apps/evals/CLAUDE.md) — the eval harness guide.
- [`packages/cli/CLAUDE.md`](packages/cli/CLAUDE.md) — the `lastlight` CLI
  (command catalogue + host-local `server` lifecycle / deploy flow).
- [`packages/workflow-engine/CLAUDE.md`](packages/workflow-engine/CLAUDE.md) — the
  runtime-agnostic workflow engine (scheduler + ports).
- [`packages/shared/CLAUDE.md`](packages/shared/CLAUDE.md) — the light modules
  shared by cli + core (provider registry, overlay/config helpers).
- [`packages/code-facts/CLAUDE.md`](packages/code-facts/CLAUDE.md) — the
  deterministic PR-analysis layer (`lastlight facts` / `lastlight-facts`), its
  fail-loud envelope, and `toolchain.json`.
- [`packages/agentic-pi/CLAUDE.md`](packages/agentic-pi/CLAUDE.md) — the
  coding-agent harness (its `AGENTS.md` is a pointer here).
- [`apps/www/CLAUDE.md`](apps/www/CLAUDE.md) and the two dashboard guides
  ([server](apps/server/dashboard/CLAUDE.md), [evals](apps/evals/dashboard/CLAUDE.md)).
- [`docs/RELEASING.md`](docs/RELEASING.md) — the automated publish + deploy runbook.
- [`docs/plans/monorepo-migration/`](docs/plans/monorepo-migration/) — the
  migration plan.
- `AGENTS.md` files across the repo are thin pointers to the co-located
  `CLAUDE.md` (the single source of truth); never duplicate content into them.
