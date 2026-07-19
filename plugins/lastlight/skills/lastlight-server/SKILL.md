---
name: lastlight-server
description: Install and configure a Last Light SERVER — the GitHub maintenance agent plus its docker-compose stack — on a host. Use when the user wants to "set up / install / deploy / stand up a Last Light server or instance", configure its GitHub App, models, managed repos, or domain, or get the agent running for the first time. Drives the `lastlight` CLI; for connecting an existing CLI to a server use lastlight-client instead, and for editing a running deployment's config use lastlight-overlay.
version: 1.0.0
tags: [lastlight, server, deploy, docker, setup]
---

# Install & configure a Last Light server

A Last Light **server** runs the agent and a docker-compose stack on a host. It
needs: Docker, a GitHub App (so it can act on repos), a model provider API key,
and a list of repos it's allowed to manage. Configuration lives in a private
**overlay** at `instance/` (a `config.yaml` plus `secrets/.env` + `secrets/app.pem`).

Your job: gather the inputs, get the working directory in place, write the
config, then build and launch. Prefer the deterministic file-writing path below
(fully automatable) over the interactive wizard.

## 1. Check prerequisites

Run these and report anything missing before continuing:

```bash
docker info >/dev/null 2>&1 && echo "docker: ok" || echo "docker: NOT running"
git --version; node --version
command -v lastlight >/dev/null && lastlight --help >/dev/null 2>&1 && echo "lastlight: installed" || echo "lastlight: missing"
```

- Docker must be running.
- If `lastlight` is missing: `npm i -g lastlight`.

## 2. Gather inputs from the user

Ask for each of these (don't guess). Group the questions; explain what each is for.

**Required**
- **GitHub App** — App ID, Installation ID, and the path to the App's private
  key `.pem` file. (If they don't have a GitHub App yet, point them at GitHub →
  Settings → Developer settings → GitHub Apps; it needs webhook + repo
  contents/issues/pull-requests/checks permissions, plus **workflows** (read &
  write) so it can merge/push PRs that touch `.github/workflows/` — e.g.
  dependency PRs bumping GitHub Actions versions. They install it on their repos
  to get the Installation ID.)
- **Domain** — the public hostname for webhooks/dashboard, e.g.
  `lastlight.example.com`. Ask whether to use the bundled **Caddy** for
  automatic TLS (default yes). The GitHub App webhook URL will be
  `https://<domain>/webhook`.
- **Managed repos** — one or more `owner/repo` the bot is allowed to act on. The
  bot ignores any repo not listed.
- **Model** — a `provider/model` string (default `anthropic/claude-sonnet-4-6`),
  plus the **matching** provider's API key. Last Light is multi-provider: the
  `provider/` prefix picks the provider and the model id follows, e.g.
  `anthropic/claude-sonnet-4-6`, `openai/gpt-5.5`, `google/gemini-2.5-pro`,
  `openrouter/anthropic/claude-sonnet-4.5`. Set **only** the one API-key env var
  that matches the provider you chose. Common ones:
  - `anthropic/…` → `ANTHROPIC_API_KEY` (`sk-ant-…`)
  - `openai/…` → `OPENAI_API_KEY` (`sk-…`)
  - `openrouter/…` → `OPENROUTER_API_KEY` (`sk-or-…`) — aggregator, reaches
    Anthropic/Google/xAI/… models through one key
  - `google/…` → `GEMINI_API_KEY`, `mistral/…` → `MISTRAL_API_KEY`,
    `groq/…` → `GROQ_API_KEY`, `xai/…` → `XAI_API_KEY`, `deepseek/…` →
    `DEEPSEEK_API_KEY`, and more (Cerebras, Hugging Face, Moonshot, NVIDIA,
    Fireworks, Together, Z.AI, Kimi, MiniMax).

  The env var name is not always `<PROVIDER>_API_KEY` (e.g. Google uses
  `GEMINI_API_KEY`, Hugging Face uses `HF_TOKEN`); the full provider → model
  prefix → env-var map is the registry in `src/providers.ts`, echoed in
  `references/env-schema.md`.

**Optional**
- Admin dashboard password (≥8 chars) to protect `/admin`.
- Slack: bot token (`xoxb-…`), app token (`xapp-…`), delivery channel id,
  allowed user ids.

## 3. Working directory + overlay

The server runs out of a working directory: a checkout of the lastlight repo
plus an `instance/` overlay. Scaffold it (this clones the core repo if needed
and creates/clones the overlay):

```bash
lastlight server setup            # interactive: confirms working dir + overlay
```

If you need to do this non-interactively / the user already has a checkout, work
in that directory directly (it has `docker-compose.yml`, `workflows/`, `skills/`,
`config/`). The overlay you write to is `<workdir>/instance/`.

## 4. Write the configuration

Create the overlay files directly (this is the automatable path — it avoids the
TTY wizard). From the working directory:

1. `mkdir -p instance/secrets && chmod 700 instance/secrets`
2. Copy the user's PEM to `instance/secrets/app.pem` and `chmod 600` it.
3. Generate two random secrets: `openssl rand -hex 32` for `WEBHOOK_SECRET` and
   again for `ADMIN_SECRET`.
4. Write `instance/secrets/.env` (`chmod 600`) and `instance/config.yaml`
   following **`references/env-schema.md`** — it has the exact keys, value
   formats, and ready-to-fill templates for both files.
5. If the user declined Caddy, write `instance/docker-compose.override.yml` to
   disable it (template in `references/env-schema.md`).

Read `references/env-schema.md` now before writing the files — it has the precise
key list and value formats.

> Alternative (let the user drive): if they'd rather answer prompts themselves,
> have them run `lastlight setup --server` in the working directory — the same
> wizard, interactive. It is a TTY wizard, so you can't fill it in from a script.

## 5. Build and launch

```bash
lastlight server update           # build images, bring stack up, restart sidecars, health-check
```

Then verify:

```bash
curl -fsS http://127.0.0.1:8644/health && echo "  ← healthy"
lastlight server status           # compose state + version drift
```

## 6. Hand-off checklist

Tell the user to:
- Paste the generated `WEBHOOK_SECRET` and the webhook URL
  (`https://<domain>/webhook`) into their **GitHub App** settings, and confirm a
  test delivery succeeds.
- Visit `https://<domain>/admin` (password is `ADMIN_PASSWORD` if they set one).
- Make later config edits in the overlay, then `lastlight server restart agent`
  (no rebuild). See the **lastlight-overlay** skill for forking workflows/assets.

For day-2 operations (start/stop/restart/update, logs, redeploy after a code
change), read **`references/operations.md`**.

## Done when

The stack is up, `GET /health` returns ok, `lastlight server status` shows the
agent running, and the user has the webhook secret + URL to finish GitHub App
setup. Report the webhook URL, dashboard URL, and which config you wrote.
