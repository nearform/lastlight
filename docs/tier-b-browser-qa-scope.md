# Tier B — Headless-browser QA (scope & as-built)

> **Status:** implemented. Tier A (`/verify` + `/qa-test` as text-evidence
> workflows + the `requires_sandbox` skip gate) was the prerequisite; Tier B
> adds a gated browser-QA phase that drives a real headless Chromium and
> attaches screenshot evidence. Tier C (`/demo` video pipeline) remains **out of
> scope**.
>
> **Lineage:** part of migrating Factory's
> [droid-control](https://github.com/Factory-AI/factory-plugins/tree/master/plugins/droid-control)
> `/demo`, `/verify`, `/qa-test` into Last Light, phased text-evidence →
> screenshots → video. See the approved plan
> (`~/.claude/plans/https-github-com-factory-ai-factory-plug-silly-lollipop.md`).

## Goal

Let the `verify` and `qa-test` workflows drive a **web app** with a real
headless browser and attach **screenshot evidence** (PNG) — extending the
text-only evidence Tier A produces. No video.

## Decisions (locked before building)

1. **Backend mechanism — global, not per-phase.** The active sandbox backend
   stays a single global setting; we do **not** add a per-phase backend
   override. The browser phase declares `requires_sandbox: docker`, so on the
   default gondolin backend it is **silently skipped** (the Tier A gate). It
   only runs where the host is already on the docker backend.
2. **Image — a fixed second image, not overridable.** A separate
   `lastlight-sandbox-qa:latest` image bakes in Playwright + Chromium. The lean
   default `lastlight-sandbox:latest` is untouched. The browser phase selects
   the QA image with a new per-phase `sandbox_image: qa` field. The name is a
   fixed constant — there is **no env override**.
3. **Driver — a bundled CLI in the skill's `scripts/`.** `skills/browser-qa/`
   ships `agent-browser.mjs`, a Playwright-backed Node CLI staged into the phase
   like any other skill. (No MCP server.)
4. **Artifacts — build-assets + dashboard link.** Screenshots are harvested by
   the existing build-assets path and served read-only via the admin API +
   dashboard Artifacts view. (No committed PNGs / inline raw-URL embeds.)

## As-built architecture

**A discrete, terminal, gated browser phase** is appended to each workflow
(`verify_browser` in `verify.yaml`, `qa_browser` in `qa-test.yaml`):

```yaml
- name: verify_browser
  label: Verify (browser)
  prompt: prompts/verify-browser.md
  skills: [verify, building, browser-qa]
  requires_sandbox: docker   # skip floor: no-op on gondolin
  sandbox_image: qa          # run on lastlight-sandbox-qa:latest
  output_var: verifyBrowserResult
  messages: { on_start: …, on_success: "{{verifyBrowserResult}}", on_failure: … }
```

It is **additive**: the text phase always posts the verdict/report; the browser
phase, when it runs, posts a **supplementary screenshot-evidence comment**. It
is the **last** phase (terminal) so its skip never cascades.

**Three independent skip conditions** make it degrade gracefully — it runs
*only* where browser QA is actually possible:

| Host situation | Result |
|---|---|
| gondolin backend | `requires_sandbox: docker` → skipped |
| docker backend, QA image **not** built | runner's `qaImageAvailable()` check → skipped |
| docker backend, QA image built | runs on `lastlight-sandbox-qa:latest` |

As defence-in-depth, the `browser-qa` skill *also* runs `agent-browser doctor`
at the top of the phase and falls back / reports cleanly if Chromium can't
launch — so a misconfigured image can never produce faked screenshots.

### Where each piece lives

- **Image** — `sandbox-qa.Dockerfile` (`FROM lastlight-sandbox:latest` +
  Playwright `1.49.1` + pinned Chromium at `PLAYWRIGHT_BROWSERS_PATH=
  /opt/playwright-browsers`, world-readable; `NODE_PATH=/usr/local/lib/
  node_modules` so a plain `node` script resolves the global `playwright`).
  Everything is baked at build time — the egress allowlist never permits the
  Playwright CDN. `docker-compose.yml` adds a `sandbox-qa` build-only service.
- **`sandbox_image` field** — `src/workflows/schema.ts` (enum `default|qa`),
  overlaid onto `ExecutorConfig.sandboxImage` by `phaseConfigFor`
  (`src/workflows/phase-executor.ts`). The orchestrator's `withSandbox`
  (`src/engine/executors/orchestrator.ts`) maps `qa` → `SANDBOX_IMAGE_QA` and
  passes it via `sandboxFor`; the `DockerSandbox` adapter forwards it as
  `createTaskSandbox({ imageName })`.
- **Image constants + availability probe** — `src/sandbox/images.ts`
  (`SANDBOX_IMAGE`, `SANDBOX_IMAGE_QA`, `qaImageAvailable()`). Kept in a
  docker-free module so `runner.ts` can import it without pulling
  `DockerSandbox`. The gate lives in `runWorkflow`'s scheduling loop.
- **Driver + skill** — `skills/browser-qa/SKILL.md` +
  `scripts/agent-browser.mjs` (`doctor`; `run <flow.json> --base-url --out-dir`,
  one Chromium session, JSON report of per-step status/extracted-text/console
  errors + screenshot paths). The agent reasons over the JSON; the PNGs are
  human evidence.
- **Prompts** — `workflows/prompts/verify-browser.md`,
  `workflows/prompts/qa-browser.md`. They tell the agent to save screenshots
  under `{{issueDir}}/` so the harness harvests them.
- **Artifacts** — `BuildAssetStore.readBuffer` (binary-safe) +
  `imageMimeForArtifact` in the admin GET route serve PNGs with the right
  Content-Type; `dashboard/.../ArtifactImageViewer.tsx` renders them (authed
  blob fetch → object URL). Harvest itself was already extension-agnostic.

## Constraints / known limitations (v1)

- **Screenshots need server-mode build assets.** Harvest only runs when
  `LASTLIGHT_BUILD_ASSETS=server` (verify/qa-test are read-only profiles and
  can't commit PNGs into the repo). On a QA-enabled docker host, set
  `LASTLIGHT_BUILD_ASSETS=server`. Without it the browser phase still drives the
  UI and reports DOM/text observations, but notes the images weren't retained.
- **No inline image links in the comment yet.** The comment references each
  screenshot by filename and points at the run's dashboard Artifacts view;
  per-screenshot deep links (a prompt-rendered `{{artifactUrl}}` per file) are a
  follow-up — the agent's free-text report can't itself render template helpers.
- **Double install on docker.** The browser phase re-clones + re-installs (it's
  a separate agent run). Inherent to a discrete gated phase; only paid on
  QA-enabled docker hosts.
- **Egress.** Browser QA hits `localhost` (the repo's dev-server); the strict
  allowlist suffices. A test needing third-party origins would need
  `unrestricted_egress: true` on the phase — not set by default.

## Deploy

`lastlight-sandbox-qa:latest` is **not** built by a normal deploy (it adds
hundreds of MB). Build it explicitly on a QA-enabled docker host, after the base
image (`FROM` dependency):

```bash
docker compose --profile build-only build sandbox sandbox-qa
```

Then run the harness on the docker backend with `LASTLIGHT_BUILD_ASSETS=server`.
On any host where the image isn't built, the browser phase simply skips.

## Verification

Validated in this change:

- `npx tsc -p tsconfig.json --noEmit` (server) + `cd dashboard && npx tsc -b` —
  clean.
- `npx vitest run` — full suite green, including new coverage: the runner skips
  a `sandbox_image: qa` phase on docker when the QA image is absent
  (`runner.test.ts`), and `BuildAssetStore.readBuffer` is binary-safe +
  traversal-checked (`build-assets.test.ts`). Real `verify.yaml`/`qa-test.yaml`
  parse with the new fields.
- `node --check skills/browser-qa/scripts/agent-browser.mjs` — parses.

Still requires a docker host with the QA image (cannot run here):

- Build `lastlight-sandbox-qa:latest`; confirm `agent-browser doctor` launches
  Chromium headless with **no runtime network**.
- Run `/qa-test` against a repo that serves a dev-server on `localhost`; confirm
  the browser phase drives it, screenshots are captured under `{{issueDir}}/`,
  harvested, and rendered in the dashboard Artifacts view.
- Confirm the **skip floor** on a non-docker / image-less host: the browser
  phase is a non-failing skip and the text path still delivers.
- Run the `docs-sync` skill (touches `workflows/`, `skills/`, `src/sandbox/**`,
  `src/state/**`) for spec + www updates.

## Out of scope (Tier C — `/demo`)

Terminal recording (tctl/tuistory/asciinema), the Remotion video-render pipeline
(`remotion/` + `agg` + `ffmpeg`), binary `*.mp4` artifacts, and the `build.yaml`
demo phase. Tracked separately by the plan's Tier C.
