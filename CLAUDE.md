# Last Light — monorepo orientation

This is the **`nearform/lastlight` monorepo**: a pnpm + Turborepo workspace
holding the Last Light GitHub-maintenance agent, its CLI, its docs site, and its
eval harness. It was consolidated from three sibling repos
(`lastlight`, `lastlight-www`, `lastlight-evals`) — see
[`docs/plans/monorepo-migration/`](docs/plans/monorepo-migration/) for the
migration plan and locked decisions.

> **The full day-to-day dev guide lives in
> [`apps/server/CLAUDE.md`](apps/server/CLAUDE.md)** (it moved there with core in
> Phase 2). Read that for runtime, architecture, commands, env vars, and
> deployment. Use this file only to find your way around the workspace.

## Workspace map

```
lastlight/                     # repo root — private orchestration package (lastlight-monorepo)
├── pnpm-workspace.yaml  turbo.json  tsconfig.base.json  pnpm-lock.yaml  .nvmrc (22)
├── instance/                  # deployment overlay — stays at repo root (prod hosts + auto-deploy)
├── docs/                      # cross-cutting docs (migration plan, RELEASING.md)
├── .github/workflows/         # ci / publish / deploy-www / deploy-evals
├── apps/
│   ├── server/                # lastlight-core — the harness + server + Docker stack + ./evals barrel
│   │   ├── CLAUDE.md          # ← the full dev guide
│   │   ├── src/ config/ workflows/ skills/ agent-context/ deploy/ spec/ sandbox/ tests/
│   │   ├── Dockerfile  sandbox*.Dockerfile  docker-compose.yml  docker-bake.hcl
│   │   └── dashboard/         # @lastlight/dashboard — admin SPA (nested, private)
│   ├── www/                   # lastlight-www (Astro) → lastlight.dev (private)
│   └── evals/                 # lastlight-evals → evals.lastlight.dev (its own CLAUDE.md)
│       └── dashboard/         # @lastlight/evals-dashboard — nested, private
└── packages/
    ├── cli/                   # published "lastlight" — the lean global bin + host-local server cmds
    ├── shared/                # lastlight-shared — light modules used by cli + core
    ├── workflow-engine/       # lastlight-workflow-engine — core/ ports/ test-support/
    └── agentic-pi/            # published "agentic-pi" — the coding-agent harness core runs in the sandbox
```

## Published packages (six)

`lastlight` (cli), `lastlight-core`, `lastlight-workflow-engine`,
`lastlight-shared`, `lastlight-evals`, and `agentic-pi` — all unscoped (the
`@lastlight` npm scope is held by an unrelated account). Everything else is
`private: true` (root, `lastlight-www`, both dashboards). Publishing is
**automated**: a GitHub Release fires `publish.yml`, which builds the GHCR images
then publishes the six npm packages via OIDC trusted publishing (no secret).
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
dashboard) via `workspace:*`. Invariants: **no edge from
`shared`/`workflow-engine` back to `core`** (dep-cruiser gate, runs in
`typecheck`); **the cli never gains an edge to `core`**. Turbo `^build` orders
builds; there are no TS project references.

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
  architecture, env, deployment).
- [`apps/server/spec/`](apps/server/spec/) — the rebuild-grade specification.
- [`apps/evals/CLAUDE.md`](apps/evals/CLAUDE.md) — the eval harness guide.
- [`docs/RELEASING.md`](docs/RELEASING.md) — the manual publish + deploy runbook.
- [`docs/plans/monorepo-migration/`](docs/plans/monorepo-migration/) — the
  migration plan.
