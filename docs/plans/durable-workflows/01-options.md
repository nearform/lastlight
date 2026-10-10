# 01 — Options considered

Researched 2026-10-03; maturity notes are as of that date. Constraints:
single-host docker-compose, SQLite (libsql) default, embeddable in the Node 22
process, human gates that wait days, agent steps that run 30–40 minutes.

## Durable runtimes

| Candidate | Infra | SQLite | Embedded lib | Verdict |
|---|---|---|---|---|
| **OpenWorkflow** | none | yes (`node:sqlite`) + Postgres | yes | **Chosen for the spike.** Step checkpointing, signals with timeouts, sleeps, versions, child workflows, pluggable `Backend` interface. Apache-2.0. Young (0.10.x, single maintainer). |
| DBOS Transact TS | Postgres | no (TS SQLite PR open, dev-only) | yes | Best mature library — revisit if Postgres ever becomes the default. |
| Absurd | Postgres | no | yes (~1.4k LOC SDK) | Small and readable; Postgres-only, versioning unaddressed. Good design reference. |
| Inngest (self-host) | +1 container (single binary, SQLite) | yes | no (HTTP push into the app) | Mature; SSPL server; hour-long steps fight HTTP timeouts. |
| Restate | +1 stateful binary | own store | no | Excellent semantics; BSL server; another thing to back up. |
| Temporal | server + Postgres/MySQL | dev only | no | Gold standard for versioning; far too heavy here. |
| Trigger.dev v4 / Hatchet | Postgres + engine (+Redis) | no | no | Platforms, not libraries. |
| Vercel Workflow SDK | compiler transform; Postgres/Turso "worlds" | community Turso world | yes | Nice ergonomics; build-step friction in a pnpm monorepo; self-host second-class. |
| Effect `effect/workflow` | library | yes, open lock bugs | yes | Only sensible if we adopt Effect wholesale. |
| Mastra workflows | library + libSQL store | yes | yes | Snapshot suspend/resume, not durable execution; open cross-process resume bugs; pulls in the framework. Its JSON "dynamic workflows" are the one declarative TS option. |
| LangGraph.js / XState | library | yes / BYO | yes | State-graph runtimes, not durable executors (no durable timers). |

## Declarative dialects (keep YAML, but standard)

Serverless Workflow 1.0 (TS SDK parses/validates only — no runtime), AWS Step
Functions ASL (`aws-local-stepfunctions` is in-memory, not durable), Kestra /
Windmill / Conductor (JVM or server platforms), Arazzo (API-call sequencing,
not agent orchestration), Graphviz DOT as used by Fabro (rejected for
readability). Each of these would be a better-specified YAML with the same
fundamental problem: control flow, typed results and reuse want a programming
language.

## Why "own the interface, borrow the runtime"

The thing that must stay stable for 15 workflows and N overlays is the
*authoring API* (`ctx.agent`, `ctx.approval`, `reviewLoop`, …). The thing that
is commodity — and where we are least qualified to compete — is the replay
machinery. The `DurableStep` port is three methods (`run`, `waitForSignal`,
`sleep`), which every candidate above provides; swapping OpenWorkflow for DBOS
or a home-grown backend is an adapter, not a rewrite.

Sources: openworkflow.dev, github.com/openworkflowdev/openworkflow,
dbos.dev (TS SQLite PR #1288), github.com/earendil-works/absurd,
inngest.com self-hosting docs, docs.restate.dev, temporal.io worker versioning,
workflow-sdk.dev worlds, mastra.ai dynamic workflows, serverlessworkflow.io.

## How other SDLC factories do it (2026-10-10)

Checked against the repos and docs on 2026-10-10 for the design review
([`09-decisions.md`](09-decisions.md)). Star counts and releases are as of
that date.

| Project | Workflow format | Durability | Gates | Branching on agent output | Customisation |
|---|---|---|---|---|---|
| [Archon](https://github.com/coleam00/Archon) (23.7k★, MIT) | YAML DAG: `prompt`/`bash`/`loop`/`approval`/child `workflow` nodes, `depends_on`, `trigger_rule` | SQLite/Postgres run + node tables; resume skips completed nodes, started by hand | `approval:` nodes with an `on_reject` revise loop; CLI/web/Slack/GitHub | JSON Schema `output_format` + `when:` expressions; loop sentinels | Same-name file in `.archon/workflows/` shadows the bundled one |
| [Attractor](https://github.com/strongdm/attractor) spec (StrongDM, dormant since 2026-03) / [Fabro](https://github.com/fabro-sh/fabro) (1.7k★, Rust) | Graphviz DOT; node shape picks the handler | Checkpoint per node; Fabro also commits to `fabro/run/{id}` after every node | `wait.human` / hexagon nodes; labelled edges are the choices | Typed `{status, context_updates}` outcome; condition → preferred label → suggested next → weight; `max_visits` | Edit the `.dot`/`.fabro` file |
| [gh-aw](https://github.com/github/gh-aw) (5.4k★, MIT) | Markdown + frontmatter compiled to Actions | None of its own (one Actions job) | GitHub environment protection rules | None in-run; output becomes typed "safe outputs" | `gh aw add` copies into the repo |
| [Gas Town](https://github.com/gastownhall/gastown) (18.3k★) | TOML formulas → molecules | Opt-in per-step rows (default off after row bloat) | `gt escalate` | None — the agent walks the checklist | Formula overlays |
| [Open SWE](https://github.com/langchain-ai/open-swe) (10.9k★) | Dropped its fixed graph for one Deep Agent + subagents | LangGraph checkpoints | Approval before git push; Slack review | LLM-decided | Prompts, skills, MCP, middleware |
| OpenHands, Goose, SWE-agent, Spec Kit, BMAD; Devin, Cursor, Copilot, Codex, Factory | Single agent + instructions/recipes/playbooks/spec templates | Event log at most (OpenHands); mostly none | Confirmation policies; human runs each phase (Spec Kit/BMAD) | Not applicable | Instruction files, recipes, playbooks |

Code-first + durable runtimes (Temporal, Vercel Workflow, DBOS, Restate,
Cloudflare Workflows, Mastra, Inngest AgentKit) are where *platform builders*
sit — Replit runs its agent on Temporal — but no open-source SDLC factory found
exposes code-defined workflows to its users.

**What we take from them:**

- **Branch on a small typed outcome, never on prose** (Archon's
  `output_format`, Attractor's outcome record) → the `submit_result` tool
  (decision 6).
- **Snapshot the workspace per node** (Fabro's per-node commit) → per-step
  snapshot refs and `forkRun` (decision 11).
- **Approval gates are first-class, with a revise loop**, reachable from every
  surface → already true of `ctx.approval`.
- **Triggers stay declarative** → crons remain data (decision 13).

**Where we deliberately differ, and the counterargument we accept:**

- *Graphs can be drawn and reviewed before running.* Answered by extracting
  the graph from code, conditions included (decision 10).
- *Node-boundary resume needs no determinism rule.* Replay by step name keeps
  the rule to "unique, deterministic step names", enforced by lint plus a
  recorded-history replay test (decision 5).
- *Users can fork and diff a declarative file.* Overlay TS workflows are
  deferred until there is demand; dynamic workflows go through a data-only
  plan interpreter (decisions 2, 9).
- *A single capable agent may not need a workflow.* Last Light's value is the
  gates, reviewer loops and the pr-review evidence pipeline between agent
  sessions; `explore`/`answer` already run as single-agent workflows.
