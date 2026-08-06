# Slack app manifest

`slack-manifest.json` is a reference Slack app manifest for a Last Light
deployment, trimmed to **only the scopes the code actually exercises**. Import
it at <https://api.slack.com/apps> → *Create New App* → *From a manifest*, or
paste it into an existing app's *App Manifest* editor.

## Before importing — replace the placeholders

- `YOUR_INSTANCE_DOMAIN` (two occurrences) → your instance host, e.g.
  `myinstance.example.com`. Used for:
  - the "Sign in with Slack" OAuth callback
    (`/admin/api/oauth/slack/callback`), and
  - the Events API request URL (`/webhooks/slack`).
- `name` / `bot_user.display_name` — default to `last-light` (the repo's
  default `botName`). If you set a custom `botName` in your overlay
  `config.yaml`, match it here so `@mention` autocomplete lines up.

## Scopes and why (each maps to real code)

### Bot token scopes (`xoxb-…`)

| Scope | Why | Code |
| --- | --- | --- |
| `chat:write` | Post replies + cron reports; edit the in-place status message (`chat.postMessage` / `chat.update`) | `src/connectors/slack/connector.ts` |
| `app_mentions:read` | Respond when `@mention`ed in a channel (`app_mention` event) | `connector.ts` |
| `im:history` | Read + respond to DMs (`message.im` event) | `connector.ts` |
| `users:read` | Resolve a user ID → username for display (`users.info`) | `connector.ts` |
| `assistant:write` | The "Thinking…" thread status indicator (`assistant.threads.setStatus`) | `connector.ts` |
| `reactions:write` | Fallback 👀 ack reaction when the assistant status API isn't available (`reactions.add`) | `connector.ts` |
| `reactions:read` | Receive `reaction_added` / `reaction_removed` — the 👍/👎 feedback signals of issue #255 | `src/engine/feedback/slack.ts` |

### Event subscriptions

- `app_mention` — needs `app_mentions:read`.
- `message.im` — needs `im:history`.
- `reaction_added` / `reaction_removed` — needs `reactions:read`. These carry the
  feedback signals (issue #255): a 👍 or 👎 on a message the bot posted is scored
  against the workflow run that produced it. Only reactions on messages Last
  Light itself posted are recorded — everything else is dropped on an indexed
  lookup miss. In **channels** the bot must be a member to receive these; DMs are
  covered by the existing `im:history`.

### User token scopes ("Sign in with Slack", dashboard login only)

- `openid`, `profile` — mint a dashboard session and read
  `team_id` / `team_domain` / `user_id` to enforce the workspace allowlist
  (`arctic`, `src/admin/routes.ts`). `email` is **not** requested.

### Non-scope secret

- **Signing secret** (`SLACK_SIGNING_SECRET`) — verifies Events API requests
  (HMAC over `v0:{ts}:{body}`). Not an OAuth scope; set it in your secrets
  `.env`, not in this manifest.

## Extra setup outside the manifest

- **`assistant:write` requires the "Agents & AI Apps" (Assistant) feature** to
  be enabled on the app in the Slack dashboard. The scope alone isn't enough —
  enable the feature, or the status indicator silently no-ops (the bot falls
  back to the `reactions.add` ack).

## Socket Mode (dev only)

This manifest is for **webhook / production mode** (`SLACK_MODE=webhook`, the
default). For Socket Mode local dev (`SLACK_MODE=socket`) instead:

- set `settings.socket_mode_enabled: true`,
- add an **app-level token** (`xapp-…`, `SLACK_APP_TOKEN`) with the
  `connections:write` scope, and
- add `channels:history` + `groups:history` bot scopes **only if** you want the
  bot to see non-mention messages in channels/private channels — Bolt's
  `message()` listener is a catch-all in Socket Mode. The default handlers act
  on DMs + mentions only, so you usually don't need them.

## What was dropped from the original manifest (and why)

Relative to an earlier over-provisioned manifest, this reference removes scopes
no code path uses:

- **User scopes dropped:** `emoji:read`, `files:read`, `im:history`, `im:write`,
  `mpim:read`, `mpim:write`, `mpim:history`, `reactions:read`, `reactions:write`,
  `search:read.*` (files/im/mpim/private/public/users), `users:read`,
  `users:read.email`. Nothing uses a Slack **user** token except the OIDC login
  (`openid`/`profile`). The `search:read.*` set mirrors Slack's MCP scope
  bundle, but `is_mcp_enabled` is `false` and there's no MCP integration. User
  scopes also require per-user consent and grant access to that user's private
  channels, DMs, and files — a needless privacy/blast-radius liability.
  (`reactions:read` and `reactions:write` stay dropped **as user scopes** — both
  are granted on the *bot* token above, which is the token the code uses.)
- **Bot scopes dropped:** `channels:read`, `files:write`, `im:read`, `im:write`,
  `channels:history`, `groups:history` — none are called by the connector, and
  the two `*:history` channel scopes only matter for Socket Mode (see above).
- **Bot scopes ADDED (were missing but required):** `assistant:write` and
  `reactions:write`. The code calls both on the **bot** token; the original
  granted `reactions:write` only as a *user* scope and omitted `assistant:write`
  entirely, so those features were failing with `missing_scope`.
- **Bot scope ADDED for feedback signals (issue #255):** `reactions:read`, with
  the `reaction_added` / `reaction_removed` subscriptions. **Re-consent the app
  after adding it** — Slack does not grant a new scope to an existing
  installation, and until it is granted no reaction event is delivered at all
  (silently: the handler is simply never called). Feedback is off in that state,
  not broken; everything else keeps working.
- **Events dropped:** `message.channels`, `message.groups` — the handlers act on
  DMs (`message.im`) and mentions (`app_mention`); the code ignores plain
  channel/group messages, so subscribing to them just delivers events nothing
  consumes.
