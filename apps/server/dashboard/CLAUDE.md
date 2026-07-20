# @lastlight/dashboard

The admin SPA for `lastlight-core` — a private (`@lastlight/dashboard`) **React +
Vite + Tailwind** app, built into `dist/` and served by the harness at **`/admin`**
at runtime.

It's a **read-mostly** view over the harness admin API (`apps/server/src/admin/`):
workflow runs, sessions (via `SessionReader` / `ChatSessionReader`), approvals,
logs, config (Default / Overlay / Merged), managed repos, stats, and the
core/overlay version drift banner. Auth (password and/or Slack/GitHub OAuth) is
handled by the admin API; the SPA just carries the session token.

## Commands

```bash
pnpm --filter @lastlight/dashboard dev        # vite dev server
pnpm --filter @lastlight/dashboard build      # tsc -b && vite build → dist/
pnpm --filter @lastlight/dashboard typecheck  # tsc -b
```

`pnpm --filter lastlight-core build:dashboard` builds it as part of the server
package; the server's `dev` script runs both concurrently. See
[`apps/server/CLAUDE.md`](../CLAUDE.md) for the admin API + session-store details.
