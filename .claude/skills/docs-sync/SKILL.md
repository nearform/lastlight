---
name: docs-sync
description: Keep Last Light's docs in sync with the code. Use before committing changes to apps/server/workflows/, skills/, config/default.yaml, src/connectors, src/state, src/engine/router.ts, src/config/, packages/cli/src, packages/shared/src (providers/overlay helpers), or agent-context/ — or whenever the docs-check pre-commit hook fires. Maps each changed file to the doc surfaces it affects (the in-repo apps/server/spec/*.md AND the apps/www site) and updates them.
---

# docs-sync

Last Light's documentation lives in **two surfaces**, and a code change can
silently invalidate either. Since the monorepo migration both live in **this
repo** (`nearform/lastlight`) — the www site is no longer a separate repo, so a
doc update lands in the **same commit** as the code change:

1. **In-repo spec** — `apps/server/spec/*.md`. This is the rebuild-grade
   contract. It is the **source of truth for the website's `/spec/` section**:
   `apps/www/scripts/sync-spec.mjs` copies these files into
   `apps/www/src/content/spec/` at build time. So editing `apps/server/spec/*.md`
   _is_ how you update the public spec — no separate edit under `apps/www` is
   needed for spec pages.
2. **Hand-written site** — `apps/www/src/pages/docs/*.astro`,
   `apps/www/src/pages/*.astro`, `apps/www/src/data/docs-nav.ts`,
   `apps/www/src/pages/llms.txt.ts`. These are **not** generated from anything.
   They drift the most.

The recurring failure mode: a workflow or skill is added and neither surface is
updated. This skill exists to close that gap.

## When to run

- The `docs-check` PreToolUse hook nudged you before a `git commit`.
- You added/removed/renamed a workflow, skill, route, env var, CLI command,
  state table, or connector behaviour.
- You're doing a periodic freshness audit.

## Procedure

1. **Find what changed.** Staged: `git diff --cached --name-only`. Or for a
   broader review: `git diff --name-only <base>`.
2. **Map each changed path → target docs** using the table below.
3. **Establish ground truth from the code, never from memory.** For a workflow,
   read its `apps/server/workflows/<name>.yaml` (kind, skill, phases) and its
   permission profile in `gitAccessProfileForWorkflow`
   (`apps/server/src/workflows/runner.ts`). For a route, read
   `apps/server/config/default.yaml`. For an env var, grep `process.env`.
4. **Edit the spec** (`apps/server/spec/*.md`). Keep edits surgical — match the
   existing table/section format; don't rewrite files.
5. **Edit the site** under `apps/www`. New workflow pages mirror an existing
   sibling (`apps/www/src/pages/docs/workflows/issue-comment.astro` is the
   simplest template). Add an `apps/www/src/data/docs-nav.ts` entry and fix the
   prev/next chain on neighbouring pages.
6. **Verify the site builds:** `pnpm --filter lastlight-www exec astro check`
   (or `cd apps/www && npx astro check`). To preview spec changes on the site
   first run `pnpm --filter lastlight-www run sync-spec`.
7. **Report** which surfaces you touched. Spec + site are one commit now.

## Change → docs map

Paths are relative to the repo root: server code under `apps/server/`, the site
under `apps/www/`.

| Changed | Update |
|---|---|
| `apps/server/workflows/<name>.yaml` **added / removed / renamed** | **spec:** `apps/server/spec/05-router.md` (skill enumeration), `08-skills.md` (catalogue if a new skill), `00-overview.md` + `06-workflow-engine.md` (the "build, triage, review, …" behaviour list). **site:** `apps/www/src/pages/docs/workflows/overview.astro` (workflow card + trigger table + permissions table), `apps/www/src/data/docs-nav.ts`, a new `apps/www/src/pages/docs/workflows/<name>.astro` |
| `apps/server/config/default.yaml` `routes:` changed | **spec:** `05-router.md` routes/skill-enumeration tables. **site:** `workflows/overview.astro` trigger table |
| `apps/server/config/default.yaml` models / variants / new config keys | **spec:** `02-configuration.md`. **site:** `docs/configuration.astro`, `docs/faq.astro` |
| `apps/server/skills/<name>/` added / removed / purpose changed | **spec:** `08-skills.md` catalogue ("Used by" column). **site:** the workflow page(s) that reference the skill |
| Permission profile map changed (`gitAccessProfileForWorkflow`, `apps/server/src/workflows/runner.ts`) | **spec:** profiles section. **site:** `workflows/overview.astro` permissions table |
| `apps/server/src/connectors/**` — new platform, event type, or reply formatting | **spec:** `03-integrations.md`, `04-event-model.md` |
| `apps/server/src/state/**` — tables, indexes, or store split | **spec:** `10-state.md` (tables + "Current implementation" table) |
| New / renamed **env var** (grep `process.env`) | **spec:** `02-configuration.md`. **site:** `docs/configuration.astro`, `docs/faq.astro`. Also `apps/server/CLAUDE.md` "Environment" |
| `packages/shared/src/providers.ts` — new provider / model registry entry | **spec:** `02-configuration.md` (provider/env-key list). Also `apps/server/CLAUDE.md` "Runtime" + "Environment" provider lists, and `packages/shared/CLAUDE.md` |
| `packages/cli/src/**` commands | **site:** `docs/local-dev.astro`, `docs/cli.astro`. Also `packages/cli/CLAUDE.md` (the canonical CLI command catalogue) |
| `apps/server/src/engine/chat*.ts`, chat skills | **spec:** `11-chat.md`. **site:** `docs/` if user-facing |
| Sandbox / egress / firewall (`apps/server/src/sandbox/**`) | **spec:** `09-sandbox.md` |

## Don'ts

- Don't edit `apps/www/src/content/spec/*` directly — it's generated
  (gitignored) and overwritten by `sync-spec.mjs` from `apps/server/spec/`. Edit
  `apps/server/spec/` instead.
- Don't invent phases, fields, or routes. If the YAML doesn't say it, don't
  document it.
- `explore-reply` is **not** a workflow — it's a router continuation handler for
  a paused `explore` run's reply gate. Don't give it a workflow card or nav entry.
