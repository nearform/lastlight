# Last Light vs. the agentic-coding landscape

*An honest comparison. Last updated June 2026 — pricing and benchmark numbers
move fast, so the point-in-time figures below are linked to sources rather than
treated as durable truth.*

## TL;DR

Last Light is **not** in the same category as most "AI coding agent" tools, and
comparing it feature-for-feature against them is misleading. It is a
**self-hosted, event-driven, single-tenant repository-maintenance harness** — a
YAML workflow engine that reacts to GitHub webhooks, Slack messages, and cron
ticks by running sandboxed AI agents to triage issues, review PRs, build
features, and report on repo health and security.

Most of what it's compared to is one of two other things:

- a **developer-driven pair programmer** you sit in front of (Cursor, Claude
  Code, Codex CLI, Aider, Cline), or
- a **vendor-hosted issue→PR agent** you delegate to in someone else's cloud
  (Devin, GitHub Copilot coding agent, OpenAI Codex cloud, Google Jules), or its
  commercial-platform sibling, Factory droid.

The important exceptions — and Last Light's truest peers — are the **open-source
agents that can also run self-hosted *and* autonomously**: OpenHands (via its
Resolver / headless mode) and Goose (via its scheduler and headless recipes).
Last Light is *not* alone in the self-hosted-autonomous quadrant; the honest
distinction from those tools is **shape**, covered in detail
[below](#last-light-vs-open-source-self-hosted-autonomous-agents-openhands--goose).

Choose Last Light when you want autonomous, auditable repo automation **running
on your own infrastructure with your own model keys and human approval gates**,
delivered as a turnkey multi-workflow GitHub/Slack service. Choose the
vendor-hosted options for zero-ops autonomy, the pair programmers for interactive
coding, and OpenHands/Goose when you'd rather compose your own autonomous setup
from a broader general-purpose agent.

## The category map

A flat feature table would flatter or unfairly penalise everything, because
these tools live on two different axes:

```
                    developer-driven ←——————————→ event-driven / autonomous
                    (you drive it, per task)      (it reacts to events)

  hosted / SaaS   │ Cursor, Claude Code,         │ Devin, Copilot coding agent,
                  │ Codex CLI, Windsurf          │ Codex cloud, Jules, Factory droid
  ────────────────┼──────────────────────────────┼──────────────────────────────────
  self-hosted     │ Aider, Cline,                │ ★ Last Light, Archon,
  (you run it)    │ OpenHands, Goose             │ OpenHands (Resolver),
                  │ (interactive)                │ Goose (scheduler / recipes)
```

Last Light lives in the **self-hosted *and* event-driven** quadrant — but it is
*not* alone there. OpenHands (run as the Resolver / headless) and Goose (driven
by its scheduler and recipes) both span the divider: they're interactive tools
that can *also* run self-hosted and autonomously. So the meaningful comparison
isn't "is anything else self-hosted and autonomous" (things are) but **what shape
that autonomy takes**:

- The **vendor bots** (Devin, Copilot, Codex, Jules) are autonomous but hosted —
  you don't run them.
- **OpenHands / Goose** are autonomous and self-hostable, but as a *single
  pipeline* (OpenHands Resolver = issue→PR) or a *general-purpose agent you
  compose* (Goose recipes + scheduler).
- **Last Light** ships a *purpose-built, multi-workflow repo-maintenance service*:
  many event types and Slack and cron routed into triage / review / build /
  health / security / explore workflows, with approval gates and a security
  boundary wired in.

That breadth is the point of the tool — and also why it carries operational
burden a per-task CLI or a SaaS bot doesn't.

## At a glance

| Tool | Category | Hosting | Trigger model | Bring-your-own model? | Isolation | Human gates | Cost model | Best for |
|------|----------|---------|---------------|----------------------|-----------|-------------|------------|----------|
| **Last Light** | Repo-maintenance harness | Self-hosted only | Webhooks + Slack + cron + CLI | Yes (Anthropic/OpenAI/OpenRouter) | Docker/micro-VM sandbox + default-deny egress firewall | First-class (GitHub/Slack/dashboard) | Free/OSS + your model spend + your infra | Self-hosted autonomous repo maintenance with approval gates |
| **Factory droid** | Commercial multi-agent platform | SaaS (on-prem at Enterprise) | IDE + CLI + browser + Slack + Jira/Linear | Yes (Claude/GPT/Gemini/DeepSeek/Qwen) | Managed cloud sandboxes ("Droid Computers") | Tiered autonomy levels | $20 / $100 / $200 per mo + Team/Enterprise | Enterprises wanting a polished multi-surface droid fleet |
| **Devin** | Autonomous cloud agent | SaaS | Task / issue assignment | No (vendor model) | Vendor cloud sandbox | Review the PR | Subscription | Delegating well-scoped tasks to a "junior engineer" |
| **Copilot coding agent** | Autonomous GitHub agent | SaaS (GitHub) | Assign a GitHub issue | No (vendor model) | Sandboxed GitHub Actions | Review the draft PR | Copilot subscription | Teams already living in GitHub |
| **OpenAI Codex (cloud)** | Autonomous cloud agent | SaaS | Task / multi-surface | No (vendor model) | Vendor cloud sandbox | Review the PR | Subscription | GPT-5.x-grade autonomy |
| **Google Jules** | Autonomous cloud agent | SaaS | GitHub issue→PR | No (Gemini) | Google Cloud VMs | Review the PR | Free preview / subscription | Gemini-grade autonomy in GCP |
| **OpenHands** | OSS agent + Resolver | Self-hosted or cloud | CLI/IDE *and* event-driven (issue label → PR) | Yes (full BYOM) | Sandboxed runtime | In the loop or review the PR | Free/OSS + your model spend (or Cloud) | Self-hosted single-pipeline issue→PR autonomy |
| **Goose** | OSS general agent | Self-hosted | CLI/IDE, recipes, built-in scheduler | Yes (full BYOM) | Local / your choice | Configurable approval gates | Free/OSS + your model spend | Composing your own autonomous/scheduled agent |
| **Archon** | OSS harness builder | Self-hosted | Terminal + Slack + Telegram + GitHub comments + web | Yes (orchestrates Claude Code/Codex/etc.) | Per-run Git worktrees | Workflow gates | Free/OSS + your model spend | Dispatching parallel coding runs from anywhere |
| **Aider / Cline** | OSS dev-driven agents | Self-hostable | CLI / IDE, per task | Yes (full BYOM) | Local / your choice | You're in the loop | Free/OSS + your model spend | Free, private, hackable per-task coding |

Treat each cell as a generalisation, not a spec sheet — see each tool's docs for
specifics, and the [Sources](#sources) for where these claims come from.

## Last Light vs. Factory droid (head-to-head)

These two look superficially similar — both run AI coding agents with a planner
and reviewer split, both are model-agnostic, both reach Slack — so this is the
comparison worth doing carefully. The difference is **commercial platform vs.
self-hosted harness**.

### What Factory droid does that Last Light doesn't

- **Multi-surface presence.** Droids live in the terminal, VS Code, JetBrains,
  Vim, the browser, and Slack. Last Light has no editor integration at all — it
  reaches you through GitHub comments, Slack, and a web dashboard, never inside
  your editor.
- **Managed cloud sandboxes.** Factory's "Droid Computers" run agent workloads
  in Factory-operated cloud environments with zero setup. Last Light expects
  *you* to run the Docker/micro-VM sandbox on your own host.
- **Ticket-system-native work.** Jira and Linear tickets are first-class units of
  work, with acceptance criteria and linked context pulled in automatically. Last
  Light is GitHub-issue-centric; there's no Jira/Linear integration.
- **Broader model menu.** Claude, GPT-5.x, Gemini, DeepSeek, Qwen. Last Light
  routes across Anthropic, OpenAI, and OpenRouter (which reaches many vendors,
  but it's a narrower first-class set).
- **Published benchmark leadership.** Factory has reported state-of-the-art
  Terminal-Bench results. Last Light publishes no benchmark numbers.
- **A commercial product.** SOC 2 Type II, support, an SLA, account management, a
  managed upgrade path, and a polished UX. Last Light is an OSS project you
  operate yourself.
- **Mature multi-agent coordination.** A coordinator dispatches to specialised
  Code/Reviewer/Tester/Knowledge/Reliability droids. Last Light's
  Architect→Executor→Reviewer cycle is narrower and YAML-defined rather than a
  product-managed fleet.

### What Last Light does that Factory droid doesn't (for its niche)

- **Truly self-hosted at every tier.** Your code, prompts, and model traffic stay
  on your infrastructure with your own provider keys. Factory is SaaS; on-prem
  deployment exists only at the Enterprise tier. If "code never leaves our infra"
  is a hard requirement and you're not buying Enterprise, Last Light wins by
  construction.
- **Workflows as open config, not a closed product.** Every behaviour is a YAML
  workflow you can read, fork, and override via the `instance/` overlay — triage,
  review, the build cycle, health, security, explore, verify, demo. You can add
  phases, change models per phase, and gate steps without touching a vendor.
- **An egress policy you own.** A default-deny firewall (allowlist + SNI-peeking
  proxy / micro-VM HTTP interceptor) plus downscoped, per-run GitHub App tokens
  (four permission profiles) mean *you* decide exactly what the agent can reach
  and what it can write. With a SaaS agent you trust the vendor's boundary.
- **First-class human approval gates.** Runs pause after the architect plan (and
  optionally after review) and resume via a GitHub comment (`@last-light
  approve`), a Slack slash command (`/approve`), or the dashboard — gates are
  data in config, not a fixed product flow.
- **Standing event+cron service.** It reacts to webhooks in real time *and* runs
  scheduled weekly health/security sweeps, with no human invocation. Factory's
  autonomy is powerful but is still oriented around delegated tasks/tickets.
- **Free and OSS.** No per-seat or per-tier cost — you pay for model tokens and
  the box it runs on.

### Choosing between them

- **Choose Factory droid when** you want a polished, supported, multi-surface
  agent platform your whole team can adopt today, you're fine with a SaaS vendor
  (or you're buying Enterprise for on-prem), and you value benchmark-leading
  models and zero-ops sandboxes over owning the stack.
- **Choose Last Light when** you need the agent to run on your own infrastructure
  with your own keys and a network boundary you control, you want repo
  maintenance behaviours expressed as forkable YAML, and you'd rather operate an
  OSS harness than pay and trust a SaaS — accepting that you own the ops.

## Last Light vs. the autonomous GitHub bots (Devin / Copilot coding agent / Codex cloud / Jules)

These are Last Light's closest *behavioural* peers. They share one lifecycle:
**ticket → cloud sandbox → autonomous edit → PR → human review.** Last Light's
build cycle does the same thing (Guardrails → Architect → Executor → Reviewer →
PR). The divergence is **ownership and extensibility**, not the basic loop.

- **The bots' advantage:** zero operations, best-in-class first-party models,
  tight platform integration (Copilot in GitHub, Jules in GCP), and a polished
  managed sandbox. You assign an issue and a PR appears. Nothing to run.
- **The bots' constraints:** vendor-hosted (your code runs in their cloud),
  vendor-model-locked (no BYOM for Devin/Copilot/Codex/Jules), an opaque sandbox
  and egress boundary you can't inspect or tighten, per-seat or usage pricing,
  and limited ability to customise the *workflow* — you get the lifecycle they
  ship.
- **Last Light's trade:** you own the harness, the model routing, the egress
  allowlist, the GitHub token scopes, and the workflow DAG — and you can add
  triage, review, health, and security behaviours the bots don't offer as a
  unit. The cost is that you run and maintain it yourself, on your own host, and
  there's no vendor to page.

**Rule of thumb:** if you want an issue→PR agent and don't care where it runs,
the hosted bots are less work and likely have stronger out-of-the-box models. If
where it runs, what it can reach, and how the workflow is shaped are
first-order concerns, Last Light is built for that and they aren't.

## Last Light vs. open-source self-hosted *autonomous* agents (OpenHands / Goose)

This is Last Light's truest peer group, and the comparison most worth getting
right — all self-hostable, all fully BYO-model, all able to run **autonomously**,
not just interactively. Last Light is **not** uniquely "the self-hosted
autonomous one." The real difference is **a turnkey multi-workflow service vs. an
autonomy primitive you assemble.**

**OpenHands** is the closest single competitor. Its **Resolver** (a GitHub Action
backed by headless mode) does exactly the event-driven thing: label an issue and
it spins up a sandboxed runtime, edits code, runs tests, and opens a PR — fully
autonomous and self-hostable (or run on OpenHands Cloud/Enterprise). That is the
same loop as Last Light's build cycle. OpenHands is also a larger project with a
bigger ecosystem, a cloud product, and broader general-purpose use.

**Goose** (from Block) is autonomous-capable too: a headless CLI, reusable
**recipes** (pre-configured agents), a built-in **scheduler** for timetabled
runs, CI/CD embedding, and developer-configurable approval gates. It's a
general-purpose agent you can shape into a scheduled, non-interactive worker.

What Last Light adds on top of "self-hosted + autonomous," for its specific
niche:

- **A suite of distinct workflows, not one pipeline.** OpenHands Resolver is
  essentially issue→PR. Last Light ships triage, standalone PR review, the full
  build cycle, weekly health reports, weekly security scans, explore (Socratic),
  verify, demo, and chat — as forkable YAML, out of the box.
- **Multi-source event routing.** It reacts to many GitHub webhook types (issue,
  PR, comment, review, check-run), Slack messages/slash-commands, *and* cron
  sweeps — through one deterministic router — rather than a single issue-label
  trigger or a hand-wired schedule.
- **Approval gates as a built-in, mid-run primitive.** Runs pause after the
  architect plan and resume via GitHub comment / Slack / dashboard. Goose has
  configurable approval gates within a run; Last Light's are wired to the
  collaboration surfaces (GitHub/Slack) and the workflow DAG by default.
- **An ownership-grade security boundary.** Default-deny egress firewall plus
  four downscoped, per-run GitHub App permission profiles. You can build similar
  isolation around OpenHands/Goose, but Last Light treats it as the default
  posture, not a thing you assemble.

What OpenHands/Goose do better: they're bigger, more general-purpose, have larger
communities, more integrations, and (for OpenHands) a managed cloud option. If
your need is "label an issue, get a PR, self-hosted," OpenHands Resolver is a more
proven, lower-effort path than standing up Last Light. If your need is "a
schedulable general agent," Goose is more flexible. Last Light wins specifically
when you want the *whole repo-maintenance suite* — multiple event sources,
multiple workflows, approval gates, and the security boundary — as one
purpose-built service rather than something you compose.

## Last Light vs. Archon (the closest architectural twin)

[Archon](https://archon.diy/) (`coleam00/Archon`, "the first open-source harness
builder for AI coding") is the most architecturally similar tool in this whole
comparison — close enough that the differences are subtle and worth spelling out.
Both are **self-hosted, open-source, YAML-DAG workflow engines** with **loops,
gates, and conditions**, **multi-channel dispatch** (Archon: terminal, Slack,
Telegram, GitHub comments, web; Last Light: GitHub webhooks, Slack, CLI, cron),
and **per-workflow model choice**. If you described either in one line, you'd use
nearly the same words.

The differences are in **execution model, isolation, and intent**:

- **What runs the agent.** Archon is a *harness builder that orchestrates external
  agent CLIs* — Claude Code, Codex, and others are the execution engine; you bring
  the coding agent. Last Light has its **own integrated runtime** (agentic-pi /
  pi-ai) with model routing baked in. Archon is more agent-agnostic; Last Light is
  more self-contained.
- **Isolation.** Archon isolates parallel runs in **per-run Git worktrees** —
  light, collision-free, great for fan-out. Last Light isolates in a **Docker /
  micro-VM sandbox with a default-deny egress firewall and downscoped per-run
  GitHub tokens** — heavier, but a real network/permission boundary. Different
  points on the safety-vs-simplicity curve.
- **Intent / centre of gravity.** Archon's framing is *developer dispatch* —
  "dispatch work from anywhere," run many agents in parallel, beat the
  single-workstation bottleneck (it grew out of an MCP knowledge-base + task
  management tool). Last Light's framing is *autonomous repo maintenance* — a
  standing service that triages, reviews, and reports on a repo's health and
  security on its own, with human approval gates. Archon leans
  developer-in-the-loop dispatch; Last Light leans unattended event-driven
  maintenance. They meet in the middle but start from opposite ends.

**Choose Archon when** you want a lightweight, agent-agnostic harness to dispatch
parallel coding runs (across worktrees) from many channels, driving whatever CLI
agent you already use. **Choose Last Light when** you want a self-contained
repo-maintenance *service* with its own runtime, a hardened sandbox/egress/token
boundary, and a built-in suite of triage/review/health/security workflows.
Honestly, if you like one's philosophy you should evaluate the other — they're
solving adjacent problems and borrow the same core idea (workflows as code).

## Honest limitations of Last Light

State these plainly — they're the flip side of the design choices above:

- **Self-hosted only.** No hosted/SaaS option. You provision a host, run the
  Docker compose stack, and operate it. That's real work the SaaS tools don't ask
  of you.
- **Single-tenant.** It's built around one operator/installation, not per-user
  RBAC or multi-team isolation. Not designed to be a shared enterprise platform.
- **No IDE or editor integration.** No pair-programming, no inline completions,
  no "agent in your editor." It reaches you through GitHub, Slack, and the
  dashboard only.
- **No published benchmarks.** Unlike Factory or the hosted bots, there are no
  Terminal-Bench / SWE-bench numbers to point to. Quality tracks whatever models
  you route to.
- **Smaller ecosystem and no vendor support.** No SLA, no support desk, no
  account team — it's an OSS project you read the source of.
- **Egress caveat in open mode.** The Docker firewall peeks TLS SNI without
  terminating it, so in opt-in *unrestricted-egress* mode a hostname resolving to
  a private IP could be tunnelled. Strict mode (the default) avoids this by only
  resolving allowlisted hosts; closing it fully in open mode would require TLS
  termination, which isn't pulled in. (Documented honestly in `spec/`.)

## Decision guide

- **You want to write code interactively at your desk** → Cursor / Claude Code /
  Codex CLI (or OSS: Aider / Cline / Goose).
- **You want to delegate a task and get a PR back, zero ops, best models** →
  Devin / Copilot coding agent / Codex cloud / Jules.
- **You want a polished, supported, multi-surface agent platform for a whole
  team** → Factory droid.
- **You want a self-hosted, single-pipeline issue→PR agent** → OpenHands
  (Resolver).
- **You want a lightweight, agent-agnostic harness to dispatch parallel coding
  runs from many channels** → Archon.
- **You want autonomous repo maintenance on your own infrastructure, as a
  self-contained service — your own runtime and keys, a network boundary you
  control, forkable YAML workflows, a suite of triage/review/health/security
  workflows, and human approval gates** → **Last Light**.
- **You want a free, private, per-task agent on your own machine** → Aider /
  Cline / Goose / OpenHands.

## Where Last Light's specifics come from

The Last Light claims above are drawn from this repository — see
[`spec/README.md`](../spec/README.md) (the rebuild-grade specification) and
[`CLAUDE.md`](../CLAUDE.md) for the runtime, isolation, deployment, and workflow
details, and [`workflows/`](../workflows/) for the actual YAML workflow set.

## Sources

External claims about other tools are point-in-time (June 2026) and come from:

- Factory — product & docs: <https://factory.ai/> · <https://docs.factory.ai/pricing> · <https://docs.factory.ai/reference/cli-reference> · <https://factory.ai/news/terminal-bench>
- GitHub Copilot coding agent & OpenAI Codex on GitHub: <https://docs.github.com/en/copilot/concepts/agents> · <https://docs.github.com/en/copilot/concepts/agents/openai-codex>
- GitHub Copilot product: <https://github.com/features/copilot>
- OpenHands — repo & Resolver/headless docs: <https://github.com/OpenHands/OpenHands> · <https://docs.openhands.dev/openhands/usage/run-openhands/headless-mode>
- Goose — docs (recipes, scheduler, headless): <https://goose-docs.ai/>
- Archon — site & repo: <https://archon.diy/> · <https://github.com/coleam00/Archon>
- Landscape & benchmark write-ups: <https://artificialanalysis.ai/agents/coding> · <https://www.morphllm.com/best-ai-coding-agents-2026> · <https://medium.com/@dave-patten/the-state-of-ai-coding-agents-2026-from-pair-programming-to-autonomous-ai-teams-b11f2b39232a>

> Pricing, model menus, and benchmark scores change frequently. Verify against
> each vendor's own pages before relying on a specific figure.
