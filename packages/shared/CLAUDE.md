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
config-types.ts       Shared config TypeScript types (the overlay/runtime config shape).
repo-config-schema.ts The PURE half of the per-repository `.lastlight/` config
                      layer (issue #180): the operator bounds (RepoConfigPolicy,
                      DEFAULT_REPO_CONFIG_ALLOW_KEYS, the 200-file / 2 MiB caps),
                      path classification (repoLayerPathKind, isRepoWorkflowPath),
                      the file guard (sanitizeRepoFiles), the config guard
                      (parseRepoConfigYaml, sanitizeRepoConfigLayer), the merge
                      (mergeLayer, resolveRepoConfig) and the RepoConfigWarning
                      vocabulary. No fs, no network, no runtime config.
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
