---
title: "Overview"
order: 0
description: "Architecture, glossary, and rebuild checklist for Last Light. A re-implementation in any stack starts here."
---

Last Light is a GitHub repository maintenance agent. External systems
(GitHub App webhooks, Slack, CLI, cron, the admin dashboard) emit events;
a normalization layer turns each into a canonical `EventEnvelope`; a
deterministic router decides which YAML workflow to run; the workflow
engine executes phases, each one calling out to an agent runtime
(`agentic-pi` for sandboxed phases, `pi-ai` in-process for chat). Every
phase writes to SQLite plus a per-session JSONL event log that the admin
dashboard reads.

The rest of this spec breaks the system down one layer at a time. Start
on this page for the picture and the vocabulary; jump to the component
pages for the contracts and schemas needed to reimplement each piece.

> **A note on the runtime.** Sandboxed work runs through `agentic-pi`
> (a Node library that supervises sandboxed agent sessions); the chat
> path runs `pi-ai` in-process (a lighter, sandbox-free library suited
> for low-latency conversations). Both are independent of the LLM
> provider — Anthropic, OpenAI, and OpenRouter all work, selected per
> task via [Configuration](/spec/02-configuration). An earlier version
> of Last Light used OpenCode; references to it in older code comments
> are historical.

## Glossary

The terms used across this spec, in dependency order.

- **EventEnvelope** — the normalized event passed from connector to
  router. Same shape regardless of source (GitHub webhook, Slack message,
  CLI invocation, cron tick, dashboard trigger). Carries `type`, `source`,
  `sender`, `repo`, optional `issueNumber`/`prNumber`, `body`, `title`,
  `labels`, `authorAssociation`, the raw payload, and a `reply()` callback
  the engine uses to post back. Full schema in [Event Model](/spec/04-event-model).
- **Workflow** — a YAML file under `workflows/*.yaml`. Declares a
  sequence (or DAG) of phases the runner executes. The runner is
  workflow-agnostic: every behaviour (build, triage, review, explore,
  health, answer — a question answered directly without a PR) is just
  another YAML file. Full grammar in
  [Workflow Engine](/spec/06-workflow-engine).
- **Workflow Run** — one execution of a Workflow against a triggering
  event. Persisted in the `workflow_runs` table with `status` of
  `running`, `paused`, `complete`, or `failed`. Resumable across process
  restarts.
- **Phase** — a single step in a Workflow. Either a `context` checkpoint
  (no agent invocation), an `agent` phase (one agent session), or a
  `loop` phase (an agent phase that iterates on reviewer feedback, e.g.
  `reviewer_fix_1`, `reviewer_recheck_1`).
- **Execution** — one agent session: a single phase running, or a single
  chat turn. One row in the `executions` table with tokens, cost, stop
  reason, and a pointer to the JSONL event log for that session.
- **Skill** — a directory under `skills/<name>/` containing a `SKILL.md`
  (with mandatory `name` + `description` frontmatter) plus optional
  `scripts/` / `references/` / `assets/`. A phase declares
  `skills: [a, b, …]` (or sugar `skill: <name>`); the runner stages
  each into `<workspace>/.agents/skills/<name>/` and pi-coding-agent's
  built-in auto-discovery surfaces them as an XML catalogue in the
  system prompt. The agent reads each SKILL.md on demand via its
  `read` tool — pi's progressive-disclosure model. `prompt:` and
  `skills:` can coexist on the same phase.
- **Profile** (`GitAccessProfile`) — one of `read`, `issues-write`,
  `review-write`, `repo-write`. Determines which scopes the GitHub App
  installation token receives for a given workflow's sandbox. A triage
  run literally cannot push code.
- **Sandbox** — the isolated environment one agent session runs in. Two
  backends: `gondolin` (QEMU micro-VM, default) and `docker` container.
  Both apply a default-deny network egress policy and receive only a
  scoped GitHub token, never the App PEM. See [Sandbox](/spec/09-sandbox).
- **Session** — the agent runtime's per-execution conversation,
  identified by an `agentSessionId`. The same id appears in the SQLite
  `executions` row and in the JSONL filename of the session's event log,
  making the two views joinable.
- **Agent context** (`AGENTS.md`) — the persona + rules layer concatenated
  from `agent-context/*.md` (`soul.md`, `rules.md`, `security.md`).
  Materialized into the sandbox at session start; also injected into the
  chat path's system prompt.
- **Approval gate** — a pause point declared on a phase. When hit, the
  run persists with `status: paused` and a row in `workflow_approvals`.
  The user resolves it via GitHub comment, Slack slash command, or the
  dashboard; the runner resumes from the next phase.
- **Reply gate** — a softer pause used by the explore workflow's Socratic
  loop. The agent posts a question, the run pauses, the next maintainer
  comment is fed back as the next loop iteration's input.

## Rebuild checklist

A re-implementation in any stack must provide all of the following. Each
item links to the page where its full contract lives.

- [ ] An HTTP receiver for GitHub webhook payloads with HMAC signature
      verification — see [Integrations §3.1](/spec/03-integrations)
- [ ] A Slack socket-mode client (or alternative chat surface) for
      messaging — [Integrations §3.2](/spec/03-integrations)
- [ ] A CLI entrypoint that dispatches workflows for ad-hoc runs —
      [Integrations §3.3](/spec/03-integrations)
- [ ] A cron tick that fans out one dispatch per managed repository —
      [Integrations §3.4](/spec/03-integrations)
- [ ] An `EventEnvelope` normalizer per integration that produces the
      canonical shape — [Event Model](/spec/04-event-model)
- [ ] A deterministic router with a single LLM call for build-intent
      classification on `@`-mention comments — [Router](/spec/05-router)
- [ ] A YAML workflow loader with a typed schema validator —
      [Workflow Engine §6.1](/spec/06-workflow-engine)
- [ ] A workflow runner with linear **and** DAG execution, loop
      iterations (max-count + until-condition), approval + reply gates,
      and resume across process restarts — [Workflow Engine §6.2–§6.5](/spec/06-workflow-engine)
- [ ] A template engine for phase prompts with phase-output and scratch
      variable resolution — [Phases & Prompts](/spec/07-phases-and-prompts)
- [ ] A skill staging mechanism — declared skills materialised at
      `<workspace>/.agents/skills/<name>/` per phase so the agent
      runtime's auto-discovery surfaces them via progressive
      disclosure — and an agent-context layer (`AGENTS.md` injection) —
      [Skills](/spec/08-skills)
- [ ] An isolated agent runtime per session with default-deny network
      egress and SSRF protection against cloud-metadata endpoints —
      [Sandbox §9.1–§9.3](/spec/09-sandbox)
- [ ] GitHub App installation token minting with per-run profile
      downscoping. The App PEM never reaches the sandbox —
      [Sandbox §9.4](/spec/09-sandbox)
- [ ] Provider-agnostic LLM routing inside the sandbox (Anthropic /
      OpenAI / OpenRouter) — [Sandbox §9.5](/spec/09-sandbox)
- [ ] A persistent store with tables for executions, workflow runs,
      approvals, messaging sessions/messages, plus a per-session JSONL
      event log. The split between resume-state and event-log is
      load-bearing — [State](/spec/10-state)
- [ ] An in-process chat runtime distinct from the sandboxed path, for
      low-latency replies with read-only GitHub tools — [Chat](/spec/11-chat)
- [ ] An admin dashboard that reads the persisted state and exposes
      resume controls
- [ ] Crash recovery: any `paused` or `running` workflow rows must be
      picked up on harness boot — [Harness](/spec/01-harness)
