---
name: lastlight-overlay
description: Create or customize a Last Light deployment OVERLAY (the private instance/ repo) — scaffold it, then fork built-in workflows, prompts, skills, or the agent persona (agent-context) so a deployment can override them. Use when the user wants to "create a Last Light overlay / instance repo", "customize / fork a workflow", "override a prompt or skill", "change the agent's persona/soul/rules", or tune a deployment's config without forking the whole codebase. For first-time server install use lastlight-server.
version: 1.1.0
tags: [lastlight, overlay, instance, fork, workflows, customization]
---

# Create & customize a Last Light overlay

Last Light keeps per-deployment customization in a private **overlay** at
`instance/`, layered over the packaged defaults at startup. The overlay can hold
`config.yaml`, `secrets/`, and overrides of any asset — `workflows/`,
`workflows/prompts/`, `skills/`, `agent-context/`. An overlay copy **shadows the
built-in by logical name**, so you only fork what you want to change.

These are host-local file operations on the working directory (resolved from
`--home` → `LASTLIGHT_HOME` → saved `serverHome` → `~/lastlight`).

## 1. Scaffold or adopt the overlay

```bash
lastlight server setup
```

This scaffolds/adopts the working directory: clones the core repo if needed, then
**creates a fresh overlay** (scaffold + optional private `gh repo create`) or
**clones an existing** overlay repo — your choice at the prompt. It also symlinks
`instance/docker-compose.override.yml` and saves the working dir for later
`lastlight server …` commands.

Read **`references/overlay-layout.md`** for the full directory shape and how the
layering/merge rules work (arrays replace, maps deep-merge, overlay wins by
name).

## 2. Tune non-secret config

Edit `instance/config.yaml` to set `managedRepos`, and optionally override
`models`, `variants`, `routes`, `approvals`, `disabled.*`. Secrets stay in
`instance/secrets/.env` (never in config.yaml).

## 3. Fork built-in assets to customize them

Use `lastlight fork` — it copies a built-in into `instance/` so your edited copy
shadows the default. Read **`references/forking.md`** for exactly what each fork
copies and the editing workflow.

> **No core checkout needed.** The defaults it forks *from* ship inside the
> `lastlight` package, so this works from any overlay — including a **Last Light
> Evals** workspace (run it from the workspace root to target `./instance`, or
> from inside `./instance`). You only need `lastlight server setup` (which clones
> core) when you're standing up a deployment, not to fork into an existing overlay.

```bash
lastlight fork                     # list forkable workflows + agent-context (marks what's already forked)
lastlight fork <workflow>          # copy a workflow YAML + every prompt & skill its phases reference
lastlight fork agent-context       # copy soul.md / rules.md / security.md (the persona)
lastlight fork agent-context soul.md   # just one persona file
#   add --force to overwrite an existing overlay copy; --home <dir> to target a specific working dir
```

Then edit the copied files under `instance/…`.

## 4. Apply

- **Config-only or overlay-asset edits** (committed to the overlay): take effect
  with `lastlight server restart agent` — no image rebuild.
- If the overlay is a separate git repo, commit + push there first, then restart.

```bash
lastlight server status            # shows forked/overridden assets + version drift
lastlight server restart agent
```

## Done when

The overlay exists with the intended `config.yaml` and any forked assets under
`instance/`, `lastlight server status` lists the overrides, and the agent has
been restarted to apply them. Report which assets were forked and where they live.
