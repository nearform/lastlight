# lastlight-shared

The published **`lastlight-shared`** package — light modules used by **both** the
`lastlight` CLI and `lastlight-core`, factored out so the CLI never needs an edge
to core.

**Dependency invariant:** depends only on `lastlight-workflow-engine` (plus small
leaf libs — `@earendil-works/pi-ai`, `yaml`, `chalk`, `@clack/prompts`). It must
**never** gain an edge back to `lastlight-core` (dep-cruiser gate).

## Modules (`src/`)

```
providers.ts          The provider + OAuth registry — the canonical list of
                      `provider/model` prefixes and their env keys (PROVIDERS +
                      OAUTH_PROVIDERS). Single source of truth for "which env var
                      unlocks which provider". Imported by core's runtime + the CLI.
oauth.ts              Shared OAuth token helpers (store shape, refresh/persist)
                      for the subscription-login providers.
config-types.ts       Shared config TypeScript types (the overlay/runtime config
                      shape), plus the `fix:` / `dependencies:` / `review:`
                      policy blocks (issues #251/#252) and their shipped
                      defaults (defaultFixConfig / defaultDependenciesConfig /
                      defaultReviewConfig). Those three are here for a sharper
                      reason than the rest: they are REPO-SETTABLE, so
                      repo-config-schema.ts below — compiled into the CLI as
                      well as core — has to know their shape and their defaults
                      to clamp against. Core's normaliser and the repo-layer
                      clamps therefore agree by construction, not by two
                      hand-maintained copies.
repo-config-schema.ts The PURE half of the per-repository `.lastlight/` config
                      layer (issue #180): the operator bounds (RepoConfigPolicy,
                      DEFAULT_REPO_CONFIG_ALLOW_KEYS, the 200-file / 2 MiB caps),
                      path classification (repoLayerPathKind, isRepoWorkflowPath),
                      the file guard (sanitizeRepoFiles), the config guard
                      (parseRepoConfigYaml, sanitizeRepoConfigLayer), the merge
                      (mergeLayer, resolveRepoConfig) and the RepoConfigWarning
                      vocabulary. No fs, no network, no runtime config.
                      One rule governs almost every validator in here: a repo
                      may only ever be MORE conservative than the operator. The
                      exception is `notifications` (which Slack channel this
                      repo's digest goes to) — routing has no more/less
                      conservative direction, so the repo's answer wins and the
                      validation is about SHAPE only. What bounds it is not a
                      bound: the layer is always read from the DEFAULT BRANCH,
                      so a PR cannot redirect the bot's output, and Slack will
                      not deliver to a channel the bot was never invited to.
                      Its `channel: null` is meaningful ("send me nothing") and
                      is distinguished from an absent key by PROVENANCE, which
                      is why that one leaf is flattened to a dotted
                      `"slack.channel"` key in `RepoConfigSources`. `approval` is
                      the original add-only case; `fix` / `dependencies` /
                      `review` generalise it — a loosening leaf is DROPPED with
                      a `policy-downgrade` warning, and dropping is the clamp
                      (the base carries the operator's value, so the dropped
                      leaf resolves to exactly it). Leaves that even a one-way
                      clamp would get wrong are operator-only and answer
                      `key-not-allowed`: fix.escalateModelAfterAttempt (spend),
                      fix.gateTimeoutSeconds (shared resource),
                      dependencies.minSettledChecks (a max() clamp would weld
                      the escape hatch shut for a repo with no CI).
                      `shapeMerged` is TOTAL over the three blocks — a base
                      built before they existed, or the CLI's empty offline
                      base, still yields a complete policy leaf-by-leaf, so no
                      consumer carries its own "if undefined then".
                      It lives HERE because both consumers need identical
                      answers and only shared is reachable by both: core at
                      runtime (`apps/server/src/config/repo-config.ts` owns the
                      impure half — fetch, TTL cache, unpack — and re-exports
                      this wholesale) and the CLI offline (`lastlight repo config
                      validate`), which may never gain an edge to core.
                      `mergeLayer` is also THE definition of Last Light's config
                      merge semantics — core's `config-resolve.ts` re-exports it
                      rather than carrying a copy, so the repo layer can never
                      acquire precedence the operator's layers don't have.
                      Exported both from the barrel and as the
                      `lastlight-shared/repo-config-schema` subpath.
sandbox-services.ts   The dependency-service domain model (a repo-declared test
                      postgres/redis a phase runs against): PortMapping,
                      ServiceSpec, ServiceSet, ImageAllowlist, parseServiceSpec.
                      PURE — no fs, no network, no framework types. It says what
                      a phase WANTS; the sandbox adapters decide how, exactly as
                      EgressPolicy does. Here rather than in core because the CLI
                      validates `.lastlight/` offline and may never gain an edge
                      to core — the same reason repo-config-schema.ts is here,
                      which imports it for the `services:` sanitizer.
                      ServiceSet is an AGGREGATE, not a list: services share the
                      sandbox's network namespace, so a phase has one flat port
                      space and a collision is invisible to any per-item
                      validator. Admission is partial by design — a rejected
                      service is dropped and reported, never thrown.
                      Note ImageAllowlist's polarity is the INVERSE of
                      RepoConfigPolicy.allowedModels: absent/null/empty permits
                      NOTHING, because a service image is arbitrary code pulled
                      onto the operator's infrastructure.
core-pin.ts           readCorePin() — resolve the overlay's `deploy.version` core
                      pin (a git tag/ref). Read host-side by the CLI's server
                      lifecycle and in-container for the drift banner.
overlay-assets.ts     Enumerate overlay vs core asset overrides/additions.
overlay-bootstrap.ts  Overlay-repo scaffolding (detectGh, scaffoldOverlayFiles,
                      bootstrapOverlayRepo) used by `lastlight server setup`.
workflow-loader.ts    Layer-aware workflow/asset loading (overlay wins by logical
                      name; built-ins are the fallback). The layer-dependent half
                      is `createAssetResolver(layers, disabled, opts)`; the
                      module-level exports (loadPromptTemplate, resolveSkillPaths,
                      loadAgentContext, …) are a thin facade over one built from
                      the last `configureWorkflowAssets` call. A caller composes a
                      PER-RUN stack with `getAssetLayers()` + `makeLayer("repo",
                      …)` + `getDisabledAssets()` rather than mutating the
                      globals — concurrent runs share the process. `repo` layers
                      are asset-only (`populateCache` refuses their workflow/cron
                      YAML) and, under `agentContextAdditiveOnly`, may only ADD
                      agent-context files; drops surface as `AssetWarning`s.
index.ts              Public barrel.
```

## Commands

```bash
pnpm --filter lastlight-shared build
pnpm --filter lastlight-shared typecheck
```
