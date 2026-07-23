# Running Last Light on Kubernetes (gondolin backend)

A complete, `kubectl apply -k`-able example for the **default gondolin** sandbox
backend, which runs each workflow phase in a QEMU micro-VM. It uses the
`lastlight-agent-qemu` image (the base `lastlight-agent` image ships no QEMU).

## Cluster prerequisites

- Nodes with **`/dev/kvm`** present — bare metal, or a VM/cloud instance with
  nested virtualization enabled — and the `kvm` kernel module active. Most
  managed shared-CPU hosts (Cloud Run, Fly shared VMs) do **not** qualify.
- A block/local StorageClass (not NFS) so the embedded SQLite DB locks safely.

## What this set contains

- `namespace.yaml` — the `lastlight` namespace at `privileged` PodSecurity
  (required: `SYS_RESOURCE` exceeds `baseline`).
- `generic-device-plugin.yaml` — `squat/generic-device-plugin` DaemonSet
  advertising `devic.es/kvm`, so the pod gets `/dev/kvm` without being
  privileged. **The only privileged component here.**
- `deployment.yaml`, `pvc.yaml`, `service.yaml`, `configmap.yaml` — the harness.

## The edits it needs

1. **Image** (`deployment.yaml`) — pin `ghcr.io/nearform/lastlight-agent-qemu`
   to a release tag.
2. **Secret** — create it (see below); the Deployment mounts `lastlight-secrets`.
3. **StorageClass** (`pvc.yaml`) — set `storageClassName`, or rely on the
   cluster default.
4. **Ingress** — add your own Ingress/Gateway to reach the `lastlight` Service on
   port 8644 (the GitHub webhook needs to reach it). Not shipped — cluster-specific.
5. **Managed repos** (`configmap.yaml`) — set `managedRepos`.

## Create the Secret

```bash
kubectl create secret generic lastlight-secrets \
  --namespace lastlight \
  --from-file=.env=instance/secrets/.env \
  --from-file=app.pem=instance/secrets/app.pem
```

(The namespace must exist first: `kubectl apply -f namespace.yaml`, or apply the
whole set and re-create the Secret — the pod stays pending until it exists.)

## Apply

```bash
kubectl apply -k .
```

On the first apply the pod may sit `Pending` for a minute or two with an
`Insufficient devic.es/kvm` event while the device-plugin DaemonSet starts and
registers the resource on each node. Kubernetes reschedules automatically once
it's advertised — no action needed.

## Known limitation

Until [nearform/lastlight#210](https://github.com/nearform/lastlight/issues/210)
Gap 2 lands, the gondolin guest image lacks `gitleaks`/`semgrep`, so the
`security-review` task falls back to a manual (Claude-only) pass.
