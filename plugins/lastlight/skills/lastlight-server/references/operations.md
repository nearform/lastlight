# Last Light server — day-2 operations

All commands are **host-local** (run on the server, not over HTTP) and operate
on the working directory. That directory resolves from `--home` →
`LASTLIGHT_HOME` → the saved `serverHome` (from `lastlight server setup`) →
`~/lastlight`.

## Lifecycle

```bash
lastlight server status            # docker compose ps + core/overlay version drift
lastlight server start [service]   # docker compose up -d (whole stack, or one service)
lastlight server stop [service]    # stop one service, or `down` the whole stack
lastlight server restart [service] # restart (default service: agent)
```

## Apply config changes

- **Overlay config.yaml or an added/changed `.env` value:**
  `lastlight server restart agent` — no image rebuild.
- **Removing an `.env` value:** `lastlight server start agent` (recreate) — a
  restart can't unset env_file vars injected at container creation.
- **Code/asset changes** (anything under `src/`, `workflows/`, `skills/`,
  `agent-context/`, `config/default.yaml`): a full rebuild — `lastlight server
  update`.

## Redeploy after a code change (the canonical deploy)

```bash
lastlight server update            # pull core + overlay, build images, recreate, restart sidecars, health-check
#   flags: --no-core --no-overlay --no-build --yes
```

This: git-pulls the core repo and the `instance/` overlay, builds the `agent` +
`sandbox` (+ best-effort `sandbox-qa`) images, `docker compose up -d
--remove-orphans`, force-restarts the egress sidecars (coredns + nginx + otel),
and health-checks `http://127.0.0.1:8644/health`.

## Logs & health

```bash
curl -fsS http://127.0.0.1:8644/health
lastlight server logs agent --follow          # live harness logs
lastlight server logs [service] --tail 200 --since 10m
lastlight server list                          # the lastlight-* containers
```

## Debug a running instance (over the admin API)

These talk to the instance over HTTP (need `lastlight login` first — see the
lastlight-client skill):

```bash
lastlight workflow list [--status s] [--workflow name]
lastlight workflow log <id> [--follow]
lastlight session list ; lastlight session log <id> --follow
lastlight logs search "<text>" [--scope errors|messages|all]
lastlight approvals list|approve <id>|reject <id>
lastlight stats [--daily n | --hourly n]
```
