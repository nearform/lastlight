# Overlay config reference — `instance/secrets/.env` + `instance/config.yaml`

The server reads config in layers: packaged `config/default.yaml` → overlay
`instance/config.yaml` → `instance/secrets/.env` env vars → `LASTLIGHT_*` env.
Secrets stay env-only and out of git. The container entrypoint copies
`instance/secrets/.env` → `/app/.env` and `instance/secrets/*.pem` → `/app/*.pem`
(mode 600) at boot, and the overlay is mounted read-only at `/app/instance`.

## `instance/secrets/.env`  (mode 0600)

Write exactly these keys. `WEBHOOK_SECRET` and `ADMIN_SECRET` are random 32-byte
hex (`openssl rand -hex 32`). Include only the ONE provider key that matches the
model.

```dotenv
# ── Last Light — Environment Variables ─────────────────────

# Overlay (this deployment's private config + assets)
LASTLIGHT_OVERLAY_DIR=/app/instance

# ── GitHub App (required) ────────────────────────────────
GITHUB_APP_ID=123456
# PEM lives at instance/secrets/app.pem; the entrypoint symlinks it to /app/app.pem.
GITHUB_APP_PRIVATE_KEY_PATH=./app.pem
GITHUB_APP_INSTALLATION_ID=789012

# ── Webhook (required) — must match the GitHub App's webhook secret ──
WEBHOOK_SECRET=<openssl rand -hex 32>

# ── Domain (used by Caddy for TLS) ───────────────────────
DOMAIN=lastlight.example.com

# ── Model + provider API key ─────────────────────────────
# Multi-provider: the `provider/` prefix selects the provider, e.g.
#   anthropic/claude-sonnet-4-6 · openai/gpt-5.5 · google/gemini-2.5-pro
#   openrouter/anthropic/claude-sonnet-4.5
LASTLIGHT_MODEL=anthropic/claude-sonnet-4-6
# Set whichever ONE env var matches LASTLIGHT_MODEL's provider:
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# OPENROUTER_API_KEY=sk-or-...
# GEMINI_API_KEY=AIza...          # google/…
# MISTRAL_API_KEY=...             # mistral/…
# GROQ_API_KEY=...                # groq/…
# XAI_API_KEY=...                 # xai/…
# DEEPSEEK_API_KEY=...            # deepseek/…
# …plus Cerebras, Hugging Face (HF_TOKEN), Moonshot, NVIDIA, Fireworks,
#    Together, Z.AI, Kimi, MiniMax — see src/providers.ts for the full list.

# ── Admin dashboard ──────────────────────────────────────
ADMIN_SECRET=<openssl rand -hex 32>
# Optional — protects /admin with a password (>=8 chars):
# ADMIN_PASSWORD=...

# ── Slack (optional) ─────────────────────────────────────
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_APP_TOKEN=xapp-...
# SLACK_DELIVERY_CHANNEL=C0123456
# SLACK_ALLOWED_USERS=U0123,U0456
```

Notes:
- `GITHUB_APP_PRIVATE_KEY_PATH=./app.pem` is correct as-is — it's resolved
  inside the container, not on the host. Just place the file at
  `instance/secrets/app.pem`.
- Provider selection is driven by `LASTLIGHT_MODEL`'s `provider/` prefix, not by
  the key shape — Last Light forwards every provider's API-key env var into the
  runtime and each provider authenticates with its own. Set only the env var for
  the provider your model prefix names. The `sk-ant-…` / `sk-or-…` / `sk-…` key
  prefixes are just the wizard's convenience hints, not the selection mechanism.
- **Removing** an env var later requires a container *recreate*
  (`lastlight server start agent`), not just a restart — compose injects
  `env_file` vars at creation time. Adding/changing one only needs
  `lastlight server restart agent`.

## `instance/config.yaml`

Non-secret overlay config, merged over `config/default.yaml`. Arrays replace;
maps deep-merge. Minimum useful content is the managed-repos list:

```yaml
# Last Light — private deployment overlay config
# Merged over config/default.yaml at startup. Restart to apply:
#   lastlight server restart agent
managedRepos:
  - owner/repo
  - owner/another-repo
```

If there are no repos yet, write `managedRepos: []` and tell the user to add
entries before the bot will act. You can also override `models`, `variants`,
`routes`, and `disabled.*` here — see the repo's `config/default.yaml` for the
full shape.

## `instance/.gitignore`

So the overlay can become a private git repo without leaking secrets:

```gitignore
secrets/
*.pem
```

## `instance/docker-compose.override.yml`  (only if Caddy is disabled)

Write this ONLY when the user opts out of Caddy TLS (they terminate TLS
elsewhere). Then symlink it into the working dir as `./docker-compose.override.yml`
(or run `lastlight server setup` / `update`, which ensures the symlink).

```yaml
# Deployment compose override — this deployment opted out of Caddy TLS.
services:
  caddy:
    profiles:
      - disabled
```
