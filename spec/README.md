---
title: "Last Light — Specification"
order: -1
description: "An implementation-grade reference for Last Light. Detailed enough to rebuild the system in another tech stack from scratch."
---

# Last Light — Specification

This directory is the canonical architectural specification for Last Light.

It is the third surface of the project's documentation:

| Surface | Audience | Question it answers |
|---|---|---|
| [`lastlight.dev`](https://lastlight.dev) / `/how-it-works` | Anyone evaluating the project | *Should I use this?* |
| `/docs` on the website | Operators running their own deploy | *How do I run this?* |
| This `/spec` directory | Engineers building or rebuilding the system | *How would I rebuild this from scratch?* |

## How to read this spec

The spec is twelve files. Read them in order if you are new; treat them as a
reference once you know the shape.

| # | File | What it covers |
|---|---|---|
| 00 | `00-overview.md` | Visual architecture, glossary, rebuild checklist |
| 01 | `01-harness.md` | Entry, boot, lifecycle, supervisor |
| 02 | `02-configuration.md` | Env vars, config schema, model/variant overrides, secrets |
| 03 | `03-integrations.md` | Event sources: GitHub App, Slack, CLI, cron, dashboard |
| 04 | `04-event-model.md` | `EventEnvelope` schema + normalization contract |
| 05 | `05-router.md` | Deterministic routing + LLM build-intent classifier |
| 06 | `06-workflow-engine.md` | YAML schema, runner, DAG, loops, approval gates, resume |
| 07 | `07-phases-and-prompts.md` | Phase types, template engine, prompt catalogue |
| 08 | `08-skills.md` | `SKILL.md` format and the `agent-context/` persona layer |
| 09 | `09-sandbox.md` | Where work happens: agentic-pi runtime, gondolin/docker backends, egress firewall, GitHub MCP tools, web search, LLM provider routing, GitHub App token downscoping |
| 10 | `10-state.md` | SQLite tables + JSONL event log + the split rule |
| 11 | `11-chat.md` | pi-ai in-process chat runtime (the non-sandboxed path) |

## Page contract

Every component page (`01` through `11`) follows this shape so the spec stays
reference-grade:

1. **Purpose** — what this layer does, why it exists.
2. **Inputs and outputs** — data crossing the boundary.
3. **Schema** — canonical shapes as code blocks (TypeScript, YAML, SQL DDL).
4. **Behavior** — the algorithm or lifecycle.
5. **Invariants** — non-obvious rules a re-implementation must preserve.
6. **Current implementation** — TypeScript file paths in `lastlight/src/`.
7. **Rebuild notes** — what would change in a different stack? What is
   incidental vs. essential?

`00-overview.md` is the exception: it carries the architecture diagram, the
glossary of terms, and the rebuild checklist that names what every
re-implementation must provide.

## Status

This spec is **in progress**. As pages land they get linked from the table
above. Empty cells mean the file has not been written yet.

The current runtime is **agentic-pi** for sandboxed phases and
**pi-ai** for the in-process chat path. Earlier references to OpenCode in
`CLAUDE.md` and elsewhere are historical — agentic-pi superseded it.
