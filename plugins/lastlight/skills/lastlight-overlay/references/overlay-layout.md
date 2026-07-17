# Overlay layout & layering rules

The overlay is a private directory (often its own git repo) mounted read-only at
`/app/instance` and pointed to by `LASTLIGHT_OVERLAY_DIR`. It is layered over the
packaged defaults at startup.

```
instance/
  config.yaml                  # merged over config/default.yaml
  .gitignore                   # ignores secrets/ + *.pem
  docker-compose.override.yml  # optional (e.g. Caddy disabled); symlinked into the project root
  secrets/                     # host-only, gitignored
    .env                       # all env vars (mode 0600)
    app.pem                    # GitHub App private key (mode 0600)
  agent-context/               # optional persona overrides
    soul.md
    rules.md
    security.md
  workflows/                   # optional workflow overrides
    <name>.yaml
    prompts/
      <name>.md
  skills/                      # optional skill overrides
    <name>/
      SKILL.md
```

## Layering / merge rules

- **config.yaml** is deep-merged over the packaged `config/default.yaml`:
  - **maps** deep-merge,
  - **arrays** replace wholesale (e.g. `managedRepos`, `disabled.*`),
  - environment variables override both.
  - Secrets are env-only — never put them in config.yaml.
- **Assets** (`workflows/`, `workflows/prompts/`, `skills/`, `agent-context/`)
  resolve **layer-aware by logical name**: an overlay file with the same logical
  name as a built-in *wins*; built-ins are the fallback. So you fork only what
  you want to change.

## What `config.yaml` can override

`managedRepos`, `models` / per-task model overrides, `variants` (reasoning
effort), `routes`, `approvals`, and `disabled.*`. See the repo's
`config/default.yaml` for the authoritative shape and keys.

**Models.** `models.default` is the fallback for every agent phase; per-task
keys (a phase name like `architect`, or a cheap helper `classifier` / `screener`)
override it, each a `provider/model` string. The provider **API key** is env-only
(`secrets/.env`), never in `config.yaml`. The `classifier`/`screener` helpers fall
back to the first provider's fast model — not `models.default` — when unset, so an
unpinned deployment routes cheaply. (Env `OPENCODE_MODELS` still works and is
layered on top of the `models` map at load, so env wins over `config.yaml`.)

## Applying changes

- config.yaml change, or an added/changed `.env` value → `lastlight server
  restart agent`.
- **Removing** an `.env` value → `lastlight server start agent` (recreate).
- The dashboard's `/config` view shows Default / Overlay / Merged (non-secret) so
  you can confirm what took effect.
