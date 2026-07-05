---
name: lastlight-guide
description: Orientation & router for the Last Light skills. Use ONLY when the user has NOT named a concrete Last Light task — i.e. they're unsure which skill/flow they need, ask "what can Last Light do / where do I start", say "help me with Last Light" with no specific goal, or want a guided tour across server / client / overlay / evals. Do NOT use when the ask already names a task — "set up/deploy a server" → lastlight-server, "connect/log in my CLI" → lastlight-client, "customize a workflow/prompt/persona/config" → lastlight-overlay, "run evals / compare models / author a case / build a PR-review dataset" → lastlight-evals, "iteratively improve an eval toward a target score" → lastlight-evals-loop: invoke that skill directly. This skill only routes and, when the goal is ambiguous, asks. Also invocable as /lastlight-guide.
version: 1.0.0
tags: [lastlight, guide, router, orientation, help]
---

# Last Light — where do you want to go?

You don't need to know which skill you need — describe what you want and this
maps you onto it.

> **If the user already named a concrete task, don't linger here** — hand off to
> the matching skill immediately (see the menu below). This guide is for
> *"which one do I need?"*, not for doing the work.

There are two big things people do with Last Light:

- **Operate a deployment** — stand up the agent, connect to it, customize it.
- **Measure its quality** — run its real workflows as evals, compare models,
  build datasets.

**If the user's goal is ambiguous, ask** (use `AskUserQuestion`) rather than
guessing which flow they mean — "are you setting up a server, connecting a CLI to
one, customizing workflows, or running evals?" Then hand off to the skill below;
each is a full runbook, so **invoke it and follow it** rather than re-deriving its
steps here.

## Flow 1 — operate a Last Light deployment

The route from nothing to a running, customized agent. Do these in order the
first time; each is also usable on its own later.

1. **`lastlight-server`** — install & configure the **server**: Docker stack, a
   GitHub App, model provider key, and the repos it may manage. Start here to
   stand one up for the first time. Config lives in a private **overlay** at
   `instance/`.
2. **`lastlight-client`** — point the `lastlight` **CLI** at an existing server
   and log in (saves URL + token to `~/.lastlight/config.json`). For people who
   *use* a server someone else runs — no Docker, no GitHub App.
3. **`lastlight-overlay`** — create & customize the `instance/` **overlay**: fork
   built-in **workflows**, **prompts**, **skills**, or the agent **persona**
   (`agent-context`), and tune `config.yaml` — overriding only what you name,
   layered over the packaged defaults. Reach for it whenever you want to change
   *what the agent does or how it behaves* on an existing deployment.

## Flow 2 — measure quality with Last Light Evals

Not required to run a deployment — this is how you **tell if a model or a
workflow/prompt change is any good** before shipping it.

- **`lastlight-evals`** — run Last Light's **real** workflows against a mocked
  GitHub and grade them deterministically; compare models on pass rate / cost /
  latency; author eval cases; **build a PR-review dataset from your own gold
  PRs**. Its own front door lists the sub-flows (scaffold · run/compare · browse
  past runs · author a case from a PR/issue · build a PR-review dataset). If the
  user just hands you PR URLs and says "make a review eval set", that skill's
  interactive flow prompts for the URLs and does the rest.

## The bridge — overlay ↔ evals

The **overlay is shared** by both flows. `lastlight-evals --overlay <dir>` points
the harness at a *deployment's own* workflows **and** datasets, so you evaluate
exactly what you ship. The loop that ties it together:

> customize in **`lastlight-overlay`** → measure the change with
> **`lastlight-evals --overlay .`** → keep it or revert.

To run that loop *toward a target score* — automatically, and without overfitting
to specific cases — use **`lastlight-evals-loop`**: it diagnoses on a train split,
validates on a blind held-out split, and proposes one generic overlay fix at a
time (stopping for sign-off before it touches a gold answer).

## Quick menu — "I want to…"

| …do this | go to |
|---|---|
| Stand up / install / deploy a server for the first time | **`lastlight-server`** |
| Connect my CLI to a server / log in / run commands against it | **`lastlight-client`** |
| Customize a workflow, prompt, skill, or the agent's persona; tune config | **`lastlight-overlay`** |
| Run evals, compare models, browse past runs | **`lastlight-evals`** |
| Author an eval case from a GitHub PR or issue | **`lastlight-evals`** (§6) |
| Build a PR-review eval dataset from a list of gold PRs | **`lastlight-evals`** (§6) |
| Iteratively improve a workflow/prompt to raise an eval score | **`lastlight-evals-loop`** |

## Preconditions (what every flow assumes)

- **Node 24+** and the CLI: `lastlight` (server/client/overlay) or
  `lastlight-evals` (evals) — `npm i -g` either.
- **Docker + a GitHub App** — server only.
- **`gh` authenticated** — only for `lastlight-evals add-case` (reads real
  PRs/issues); running evals mocks GitHub and needs no token.
- **A model provider API key** — server and evals (`OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` / …).

Not sure which you have? Ask the user what they're trying to accomplish, confirm
the precondition for that flow, then hand off to the skill.
