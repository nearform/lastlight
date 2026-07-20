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
core-pin.ts           readCorePin() — resolve the overlay's `deploy.version` core
                      pin (a git tag/ref). Read host-side by the CLI's server
                      lifecycle and in-container for the drift banner.
overlay-assets.ts     Enumerate overlay vs core asset overrides/additions.
overlay-bootstrap.ts  Overlay-repo scaffolding (detectGh, scaffoldOverlayFiles,
                      bootstrapOverlayRepo) used by `lastlight server setup`.
workflow-loader.ts    Layer-aware workflow/asset loading (overlay wins by logical
                      name; built-ins are the fallback).
index.ts              Public barrel.
```

## Commands

```bash
pnpm --filter lastlight-shared build
pnpm --filter lastlight-shared typecheck
```
