# WP2 — vendoring the toolchain into the sandbox image

**Goal.** Make `lastlight-facts` and its analysis tools available inside every
sandbox at a fixed path, pinned, with no npm round-trip at run time and no
possibility of resolving the target repo's own toolchain.

**Depends on:** [WP1](01-code-facts.md).

> **Demoted off the critical path, 2026-08-21
> ([10-design-review.md](10-design-review.md) §D1/§D3/§E4).** Two corrections:
>
> 1. **The eval harness cannot reach this image at all** — it defaults to
>    `--sandbox none`, rejects `docker`/`smol`, and `gondolin` needs `/dev/kvm`.
>    So `code-facts` ships **inside the `lastlight` CLI** and resolves
>    `LASTLIGHT_FACTS_BIN` → `PATH` → the baked path. This WP stops being "the
>    thing that makes the tools exist" and becomes "the thing that makes the
>    image match the manifest" — it can land any time before the Release.
> 2. **The base image is not actually pinned.** gitleaks is (`v8.21.2`, line 97)
>    but semgrep is `pipx install semgrep` (line 96) and uv is
>    `astral.sh/uv/install.sh` (line 108) — both float. A single
>    `packages/code-facts/toolchain.json` becomes the source of truth, read here
>    as build ARGs (which fixes those two as a side effect), verified by the eval
>    preflight, and **stamped into the facts envelope** so every scorecard records
>    which toolchain produced it.

## The three-way resolution is a symptom, and this WP should DELETE it

**Added 2026-08-23.** The correction above records the resolution order
(`LASTLIGHT_FACTS_BIN` → `PATH` → `/opt/lastlight/bin/lastlight-facts`) as the
answer. It was the right answer while the tools existed in only one of the three
places; it is the wrong end state, and it has since spread. That shell preamble —

```sh
FACTS="${LASTLIGHT_FACTS_BIN:-$(command -v lastlight-facts || echo /opt/lastlight/bin/lastlight-facts)}"
```

— is now copy-pasted into **every** deterministic phase in `pr-review.yaml`, into
each of the five survey branches' `until_bash` gates, into
`prompts/review-adjudicate.md`, and it is pinned by three separate test files.
Sixteen files mention `LASTLIGHT_FACTS_BIN`. Every one of them is a place the
wrong binary can be picked up, and a prompt that carries shell resolution logic
is a prompt whose instruction and mechanism are separable — the exact property
[`seed-render.ts`](../../../packages/code-facts/src/seed-render.ts) exists to
avoid.

**The end state: there is one invocation, `lastlight facts …`, and it works
everywhere.** `code-facts` already ships inside the `lastlight` CLI (§D1) and the
subcommand already exists (`packages/cli/src/cli.ts`). What is missing is only
that the sandbox image does not carry the CLI — which is precisely what this work
package is for. So this WP's deliverable is not "put `lastlight-facts` on `PATH`
in the image"; it is:

1. Ship the **`lastlight` CLI** in the sandbox image, not a second bare binary.
2. Replace every `FACTS="${LASTLIGHT_FACTS_BIN:-…}"` preamble with a plain
   `lastlight facts …`, and delete the env var and the baked path.
3. Keep exactly one escape hatch for local development against an unpublished
   build, if one is still needed after (1) — but it must not be load-bearing for
   any shipped invocation, and no prompt may mention it.

Two things to preserve while doing it. The eval harness runs `--sandbox none` on
the host and must keep working, which is what the env var buys today — so (1) has
to be verified on the host path as well as in-image. And the **toolchain stamp**
in the facts envelope stays regardless: "which toolchain produced this scorecard"
is a question the resolution order was never what answered.

## Why this is its own work package

Three constraints collide here, and getting any of them wrong is silent:

1. **The pinned-compiler rule** ([WP1](01-code-facts.md), locked decision 5) is
   only actually enforced by *where the bundle lives*. A `pnpm install` inside
   the target repo would resolve the repo's `typescript` and break on TS 7.
2. **The sandbox is offline-by-default.** Egress is a strict allowlist
   (`src/sandbox/egress-allowlist.ts`). Fetching an analyser at review time
   would add a failure mode and a firewall entry for no benefit.
3. **Image layers are expensive.** `sandbox-qa` carries ~300 MB of Chromium and
   the existing COPY ordering keeps it cached. A careless layer costs every
   build.

## The pattern to copy

`agentic-pi` is already vendored exactly this way, and the comment in the root
`CLAUDE.md` explains why:

> The sandbox images no longer install it from npm — they **vendor** it from the
> workspace (a `pnpm deploy` bundle built in `sandbox*.Dockerfile`), so the
> sandbox's whole dependency tree is exactly what the lockfile resolved and CI
> tested.

Do the same:

- A builder stage runs `pnpm deploy --filter code-facts /out` (or the workspace's
  established equivalent — read the existing `agentic-pi` stage and mirror it
  rather than inventing a second idiom).
- `COPY --from=builder /out /opt/lastlight/code-facts` in
  `apps/server/sandbox.Dockerfile`, placed **above** the base's toolchain layers
  so the COPY is content-addressed on the bundle and an unchanged `code-facts`
  does not rebuild the tail.
- A wrapper on `PATH`: `/usr/local/bin/lastlight-facts` → `node
  /opt/lastlight/code-facts/dist/cli.js "$@"`.

Apply to `sandbox.Dockerfile` **and** `sandbox-qa.Dockerfile` (both are `FROM`
the shared base and both can run review phases).

## What goes in the base vs the lean image

`apps/server/sandbox-base.Dockerfile` already carries `git ripgrep curl jq
ca-certificates gettext-base gosu build-essential pkg-config python3 unzip`,
fnm + Node, corepack/pnpm/yarn, **semgrep**, **gitleaks**, and **uv**.

| Tool | Where | Note |
|---|---|---|
| `lastlight-facts` bundle | **lean** (`sandbox.Dockerfile`) | changes often; keep it out of the slow base |
| `ast-grep` | base | single static binary, stable |
| `opengrep` | base | replaces the Semgrep dependency for the review path — see below |
| StrykerJS | **in the bundle**, not global | it must run against the *repo's* test runner but with *our* pinned Stryker; a global install would be resolved inconsistently |
| gitleaks, semgrep | already in base | unchanged |

### On Semgrep vs Opengrep

`skills/security-review/SKILL.md` uses `semgrep --config auto`, and that is a
**separate workflow** producing a summary issue, not PR comments. Leave it
alone. This work package **adds** Opengrep for the review path
([locked decision 7](README.md)) and does not migrate security-review. Two
scanners in the base is cheap; a licence problem in the product is not.

## Reaching production

Per `docs/RELEASING.md` and the deployment section of `apps/server/CLAUDE.md`:
`lastlight server update` **pulls** prebuilt images from GHCR, and only a
**GitHub Release** builds them. So:

- A sandbox-image change **cannot** reach prod via an overlay push. It needs a
  Release, then a `deploy.version` bump in the overlay.
- For iteration, `lastlight server update --local` builds from source on the
  host. The eval harness runs the images it is pointed at, so local builds are
  enough for every measurement in this plan.
- Build order matters: `sandbox-base` before `sandbox` before `sandbox-qa` —
  `docker compose build` parallelises within one invocation, so the base must be
  its own step. `server update --local` already does this in waves; match it.

## Acceptance criteria

1. `docker run --rm lastlight-sandbox:latest lastlight-facts --version` prints a
   version. On `lastlight-sandbox-qa:latest` too.
2. `lastlight-facts` resolves its TypeScript from `/opt/lastlight/code-facts`.
   Assert it by running it against a fixture repo that pins a *different*
   `typescript` version and checking the reported compiler version is ours.
3. `ast-grep --version` and `opengrep --version` succeed in the base image.
4. Rebuilding with an unchanged `code-facts` does **not** invalidate the
   sandbox-qa Chromium layer. Verify by build-log inspection, and record the
   before/after image sizes in the PR description.
5. `apps/server/tests/…/docker-compose.test.ts` (the topology contract) stays
   green; add an image-content assertion if the existing tests cover binaries.
6. The lean image grows by less than ~80 MB. If it grows more, say so and
   justify it — sandbox images are pulled on every deploy.

## Non-goals

- **No egress-allowlist change.** Everything is baked in; `npm pack` in
  [WP1](01-code-facts.md)'s `deps` uses registries that are *already* allowed.
- **No change to `security-review`.**
- **No overlay-owned custom images** (issue #179) — out of scope here.
- **No Release.** WP2 lands the Dockerfile change; cutting the Release is WP9 in
  [HANDOFF.md](HANDOFF.md), after the pipeline measures well.
