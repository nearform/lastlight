# Native deploy (systemd + gondolin)

Production deploy for `lastlight` as a systemd service on a KVM-capable
Linux host. Replaces the Docker compose deploy; the Dockerfiles in the
repo root are kept only for local prod-like smoke testing.

## Why native

`agentic-pi`'s gondolin sandbox needs `/dev/kvm`. Running lastlight inside
a container loses or complicates KVM access (Docker-in-Docker, nested
virt, capability juggling). On a bare-metal Linux box you get
near-native VM performance with no extra moving parts.

See `agentic-pi/SPIKE-gondolin.md` for the full analysis.

## First-time install

On the prod host as root:

```bash
# 1. Clone the repo to the canonical path.
git clone https://github.com/nearform/lastlight.git /opt/lastlight
cd /opt/lastlight

# 2. (Optional) Drop the GitHub App PEM in place before the install runs,
#    so install.sh locks it down. Otherwise place it later and re-run.
install -m 0600 -o root /path/to/your-app.pem /etc/lastlight/app.pem

# 3. Provision system + install systemd unit.
sudo bash deploy/native/install.sh

# 4. install.sh scaffolds /etc/lastlight/lastlight.env from the example
#    and refuses to (re)start the service while any CHANGE_ME placeholder
#    remains. Edit it:
sudo $EDITOR /etc/lastlight/lastlight.env

# 5. Re-run install.sh to start the service.
sudo bash deploy/native/install.sh
```

## Re-deploying a code change

```bash
cd /opt/lastlight
sudo -u lastlight git pull
sudo bash deploy/native/install.sh   # rebuilds + restarts the service
```

The existing `/home/lastlight/deploy.sh` on the prod host should be
replaced with the two lines above (or wrap them in a script).

## What's where

| Path | Purpose |
| --- | --- |
| `/opt/lastlight` | Source checkout. `node dist/index.js` runs from here. |
| `/etc/lastlight/lastlight.env` | systemd EnvironmentFile (mode 0640). Holds all secrets. |
| `/etc/lastlight/app.pem` | GitHub App private key (mode 0640). Optional but typical. |
| `/var/lib/lastlight/` | Persistent state — SQLite DB, session JSONLs, gondolin image cache. |
| `/var/lib/lastlight/lastlight.db` | Workflow runs, executions, messaging sessions. |
| `/var/lib/lastlight/agent-sessions/` | Dashboard's JSONL envelope store. |
| `/var/lib/lastlight/.cache/agentic-pi/images/` | Downloaded gondolin guest images (~89 MB each). |
| `/var/log/lastlight/` | LogsDirectory if anything writes to it. |
| `/etc/systemd/system/lastlight.service` | The unit file (installed by install.sh from `deploy/native/lastlight.service`). |

## Operations

```bash
# Status / logs
systemctl status lastlight
journalctl -u lastlight -f                    # live tail
journalctl -u lastlight --since '10 min ago'  # recent

# Restart (e.g. after an env edit that doesn't need a rebuild)
sudo systemctl restart lastlight

# Stop / disable
sudo systemctl stop lastlight
sudo systemctl disable lastlight
```

## TLS / reverse proxy

The harness binds `127.0.0.1:8644` by default (PORT in the env file).
Front it with Caddy or nginx for TLS.

Minimal Caddy setup:

```bash
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile <<'EOF'
your-domain.example.com {
  reverse_proxy 127.0.0.1:8644
}
EOF
sudo systemctl reload caddy
```

## Migrating from the Docker compose deploy

On the old (Docker compose) box:

```bash
# Snapshot the persistent volume.
docker run --rm -v lastlight_agent-data:/data -v /tmp:/backup busybox \
  tar czf /backup/lastlight-data.tgz -C /data .
scp /tmp/lastlight-data.tgz root@new-host:/tmp/
docker compose down
```

On the new (native) host, after running install.sh and editing the env file:

```bash
sudo systemctl stop lastlight
sudo tar xzf /tmp/lastlight-data.tgz -C /var/lib/lastlight \
  lastlight.db lastlight.db-shm lastlight.db-wal \
  agent-sessions secrets || true
# The old volume used these directory names that the new code doesn't read.
# Safe to skip restoring them: opencode-home/, opencode-serve/, sandboxes/,
# sandbox-data/, sessions/, claude-home/.
sudo chown -R lastlight:lastlight /var/lib/lastlight
sudo systemctl start lastlight
```

The DB schema is unchanged across the migration, so workflow_runs +
executions history carry over.

## Rollback

If the new service doesn't come up cleanly:

```bash
sudo systemctl stop lastlight
sudo systemctl disable lastlight
# Restore the docker stack on the same host (or fail over to the old host)
docker compose up -d
```

State at `/var/lib/lastlight/` and the docker `agent-data` volume are
independent — neither rollback step touches the other.

## Verification

After the service is up:

```bash
# 1. It started cleanly.
systemctl status lastlight   # → active (running)

# 2. KVM is reachable from the service's user context.
sudo -u lastlight ls -l /dev/kvm

# 3. The harness is listening.
curl -sS http://127.0.0.1:8644/admin/  | head -5

# 4. (Optional) Trigger a real workflow via a PR comment and watch:
journalctl -u lastlight -f
# Then look in the dashboard for the executions row + a JSONL under
# /var/lib/lastlight/agent-sessions/projects/<slug>/
```
