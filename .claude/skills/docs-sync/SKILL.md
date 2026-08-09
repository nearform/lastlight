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
3. **The homepage** — `apps/www/src/pages/index.astro`. Called out separately
   because it is the page nobody remembers to update and the one every visitor
   reads first. It makes **countable, falsifiable claims** (how many dashboard
   tabs, which sandbox backends, which skills exist) that go stale silently: an
   August 2026 audit found it still claiming "four tabs" against eleven, and two
   sandbox backends against five. It is marketing copy, so it does not list
   everything — but nothing on it may be **wrong**, and a genuinely new
   user-facing capability belongs there. Same rule for `/comparisons/*`, whose
   "what Last Light does that X doesn't" lists are claims about us.

The recurring failure mode: a workflow or skill is added and neither surface is
updated. This skill exists to close that gap.

**Counts are the tell.** Any doc sentence containing a number that enumerates
code ("four tabs", "two backends", "eleven workflows") is a liability. When you
touch the thing being counted, grep the docs for the count and fix it — or
better, reword it so it does not need a number.

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
| `apps/server/workflows/<name>.yaml` **added / removed / renamed** | **spec:** `apps/server/spec/05-router.md` (skill enumeration), `08-skills.md` (catalogue if a new skill), `00-overview.md` + `06-workflow-engine.md` (the "build, triage, review, …" behaviour list). **site:** `apps/www/src/pages/docs/workflows/overview.astro` (workflow card + trigger table + permissions table), `apps/www/src/data/docs-nav.ts`, a new `apps/www/src/pages/docs/workflows/<name>.astro`, **and `index.astro`'s "Tricks up its sleeve" grid** if it is user-facing |
| `apps/server/config/default.yaml` `routes:` changed | **spec:** `05-router.md` routes/skill-enumeration tables. **site:** `workflows/overview.astro` trigger table |
| `apps/server/config/default.yaml` models / variants / new config keys | **spec:** `02-configuration.md`. **site:** `docs/configuration.astro`, `docs/faq.astro` |
| `apps/server/skills/<name>/` added / removed / purpose changed | **spec:** `08-skills.md` catalogue ("Used by" column). **site:** the workflow page(s) that reference the skill, plus `index.astro`'s "Tricks up its sleeve" grid |
| `apps/server/dashboard/src/App.tsx` **nav/tab list changed** | **site:** `index.astro` "Inside the dashboard" (the tab **count** in the section intro, and the screenshot tour if a headline tab appeared). Screenshots live in `apps/www/public/screenshots/` — see "Refreshing the dashboard screenshots" below |
| `apps/server/src/sandbox/sandbox.ts` **backend added / removed** | **spec:** `09-sandbox.md` §Backends (it states the count). **site:** `index.astro` "How it works" paragraph, `docs/configuration.astro`, and the `comparisons/*` isolation rows |
| A **new user-facing capability** (feedback signals, per-repo `.lastlight/`, OTel, OAuth provider logins, …) | **spec:** the owning page. **site:** `index.astro` (a feature card or section) **and** `apps/www/src/pages/comparisons/*.astro` where it is a genuine differentiator. A capability none of Devin / Factory / Copilot has belongs in the "what Last Light does that X doesn't" lists |
| Permission profile map changed (`gitAccessProfileForWorkflow`, `apps/server/src/workflows/runner.ts`) | **spec:** profiles section. **site:** `workflows/overview.astro` permissions table |
| `apps/server/src/connectors/**` — new platform, event type, or reply formatting | **spec:** `03-integrations.md`, `04-event-model.md` |
| `apps/server/src/state/**` — tables, indexes, or store split | **spec:** `10-state.md` (tables + "Current implementation" table) |
| New / renamed **env var** (grep `process.env`) | **spec:** `02-configuration.md`. **site:** `docs/configuration.astro`, `docs/faq.astro`. Also `apps/server/CLAUDE.md` "Environment" |
| `packages/shared/src/providers.ts` — new provider / model registry entry | **spec:** `02-configuration.md` (provider/env-key list). Also `apps/server/CLAUDE.md` "Runtime" + "Environment" provider lists, and `packages/shared/CLAUDE.md` |
| `packages/cli/src/**` commands | **site:** `docs/local-dev.astro`, `docs/cli.astro`. Also `packages/cli/CLAUDE.md` (the canonical CLI command catalogue) |
| `apps/server/src/engine/chat*.ts`, chat skills | **spec:** `11-chat.md`. **site:** `docs/` if user-facing |
| Sandbox / egress / firewall (`apps/server/src/sandbox/**`) | **spec:** `09-sandbox.md` |

## Refreshing the dashboard screenshots

`apps/www/public/screenshots/*.png` are the most drift-prone assets on the site:
they are pictures of a UI that keeps changing, and nothing fails when they go
stale. Refresh them whenever the tab list or a shown panel changes.

**You do not need a password.** The CLI's saved bearer token authenticates a
browser directly, because `authMiddleware` accepts `?token=` (it has to: SSE's
`EventSource` cannot set an `Authorization` header) and the SPA picks any
`?token=` up on load, stores it under the `lastlight-token` localStorage key,
and strips it from the URL (`apps/server/dashboard/src/App.tsx`, the OAuth
callback branch). So:

```bash
lastlight login https://<instance>          # once; writes ~/.lastlight/config.json
TOKEN=$(jq -r .token ~/.lastlight/config.json)
echo "https://<instance>/admin/?token=$TOKEN"   # open this in a browser
```

Then drive it with the `chrome-devtools` MCP tools (`navigate_page`,
`resize_page`, `take_screenshot`) and write the PNGs into
`apps/www/public/screenshots/`.

**Capture every shot twice, once per theme.** The homepage swaps them to follow
`html[data-theme]`, so a dark screenshot on a light page looks broken. The
convention is `<name>.png` for dark and `<name>-light.png` for light, paired by
the `data-shot` attribute on the `<img>`. The dashboard's own theme lives in the
`ll-theme` localStorage key (`dark` / `neaform`), so set it and reload rather
than clicking the toggle.

Two details that matter for a set that looks consistent:

- **Size.** Resize the page to **1285 × 925**; Chrome renders at DPR 2, giving
  the 2570 × 1850 PNGs the existing set uses. Check with
  `sips -g pixelWidth -g pixelHeight`.
- **Navigate by URL, not by clicking the nav** (`?tab=home|runs|sessions|chat-sessions|repos|feedback|crons|logs`,
  plus `&rtab=config` for a repo's config pane). Clicking leaves the cursor on
  the sidebar and its hover tooltip lands in the shot.

Two cautions. The token is a **30-day credential for a live instance**: never
paste it into a commit, an issue, or a screenshot's own address bar. And
screenshots of production show **real repo and user names** — prefer a dev
instance, or check the frame before committing it.

## Don'ts

- Don't edit `apps/www/src/content/spec/*` directly — it's generated
  (gitignored) and overwritten by `sync-spec.mjs` from `apps/server/spec/`. Edit
  `apps/server/spec/` instead.
- Don't invent phases, fields, or routes. If the YAML doesn't say it, don't
  document it.
- `explore-reply` is **not** a workflow — it's a router continuation handler for
  a paused `explore` run's reply gate. Don't give it a workflow card or nav entry.
