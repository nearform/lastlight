# Running Last Light on Kubernetes (`sandbox.backend: kubernetes`)

A complete, `kubectl apply -k`-able example for the **kubernetes sandbox
backend**: each workflow phase runs as its own Pod in a dedicated namespace,
instead of in a QEMU micro-VM inside the harness process (the default
`gondolin` backend — see the older `gondolin`/`docker`-oriented deployment
guidance if that's what you're running instead). The harness is a Kubernetes
client (`@kubernetes/client-node`); it creates a Pod per phase, streams its
JSONL stdout, and reaps it. See the [sandbox spec](../../spec/09-sandbox.md)
(the `kubernetes` backend section) for the full architecture and rationale, and
[`architecture.md`](./architecture.md) for the same in diagrams (topology, pod
lifecycle, and the domain-model information flow).

## Requirements / dependencies matrix

Everything the kubernetes sandbox backend needs from the cluster, and what
happens if a piece is missing:

| Requirement | Why | If missing |
|---|---|---|
| **`@kubernetes/client-node@1.4.0`** (bundled in the harness image) | The harness's only k8s client. In-cluster it uses `KubeConfig.loadFromCluster()` — the mounted ServiceAccount token, nothing to configure. | N/A — ships in the image. |
| **RBAC `Role` + `RoleBinding`** (`sandbox-rbac.yaml`) | Least-privilege grant of exactly the verbs the harness calls (pod create/list/delete, pods/status get, pods/log get, secret create/patch/delete, PVC create/get/list/delete, CiliumNetworkPolicy create/get/update). | Every sandboxed phase fails outright — the harness can't create the Pod. Not gracefully degradable; this is a hard requirement. |
| **`lastlight-sandboxes` namespace at PSA `restricted`** (`sandbox-namespace.yaml`) | Dedicated namespace: RBAC blast radius, one `ResourceQuota` ceiling, a namespace of uniformly-untrusted pods for network policy to select. The sandbox pod spec is restricted-compliant by construction (`runAsNonRoot`, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, all capabilities dropped). | Pods can run in a laxer-PSA namespace, but you lose the admission-time guarantee that a future change can't accidentally request a broader security context. |
| **Pod-count `ResourceQuota` + `LimitRange`** (`sandbox-quota.yaml`) | The cluster — not an app-level `maxWorkflows` counter — is the single concurrency authority. A `403 exceeded quota` is treated as backpressure: the run stays queued and retries as capacity frees. The `LimitRange` supplies the per-pod requests/limits the (deliberately resource-less) sandbox pod spec needs to be schedulable, since the quota is pod-count only. | Without the quota, concurrency is unbounded (bounded only by a large sanity-fuse backstop in the app). Without the `LimitRange`, sandbox pods have no resource requests and the scheduler can't bin-pack them sensibly. |
| **RWO block/local `StorageClass`** (NOT NFS) | Two independent uses: the harness's own `lastlight-data` PVC holds the embedded SQLite DB (file locking needs a real block device); each `(repo, PR)` gets a reused workspace PVC (`ws-<owner>-<repo>-pr<N>`) that the harness's `WorkspaceProvisioner` creates on demand — RWO because only one sandbox pod per PR runs at a time. | SQLite locking is unsafe on NFS; a shared/RWX class doesn't buy anything here since sandbox pods never share a workspace concurrently. |
| **Reachable CoreDNS/kube-dns** | Every sandbox pod and the harness pod need cluster DNS to resolve Service names (the harness Service, `kubernetes.default.svc`) and, under Cilium, external FQDNs via the DNS proxy (below). | Pod-to-Service and FQDN-based egress resolution both break. |
| **Cilium, for *enforced* egress** — **current mechanism, not a permanent hard requirement** | The harness renders a `CiliumNetworkPolicy` pair (`strict`/`open`) per namespace from the same allowlist (`egress-allowlist.ts`) every backend uses, selected by a per-pod label. Cilium's DNS proxy is what makes the FQDN allowlist bite on IPs, closing the private-CIDR SSRF gap other backends can't close. | **Graceful degrade, not a hard failure.** On a non-Cilium cluster (or one where the harness SA lacks the CNP verb), applying the policy 403s, the harness logs one warning per namespace, and the run proceeds on the cluster's default network posture — sandbox pods get no allowlist enforcement, but nothing else breaks. A CNI-agnostic egress path (plain `NetworkPolicy` plus an out-of-band forward proxy, or a Gateway API implementation) is a known, tracked follow-up — Cilium is today's implementation, not a design commitment. |
| **Harness Service reachability from sandbox pods** | Sandbox pods reach the harness over three internal HTTP routes: `GET /internal/skill-bundle` (per-phase skill bundle, initContainer), `GET /internal/agent-context` (AGENTS.md context, initContainer), and `POST /internal/sandbox-artifacts` (build-artifact POST-back). All three are scoped-token-authenticated. `harness-deployment.yaml` ships a `Service` at `lastlight.lastlight.svc.cluster.local:8644` — exactly `sandbox.kubernetes.harnessEndpoint`'s default — so this works unmodified as long as you keep the harness namespace/name/pod-labels as shipped. | If the Service is missing, unreachable, or its DNS name doesn't match `sandbox.kubernetes.harnessEndpoint`, every phase's initContainer fails to fetch its skill bundle and the pod never starts the agent. |
| **Sandbox image pull** | `sandbox.kubernetes.image` (default `ghcr.io/nearform/lastlight-sandbox:latest`) is pulled once per sandbox pod. GHCR serves it publicly/anonymously by default. | On a cluster with restricted internet egress from nodes, or if you push the image to a private registry, add an `imagePullSecret` and reference it from the sandbox pod spec's `imagePullSecrets` (a harness config surface, not shipped here — see `sandbox.kubernetes` in `apps/server/src/config/config.ts` for what's currently configurable, or mirror the image into a registry your nodes can already pull from). |
| **Harness pod API-server egress, if the harness namespace is itself Cilium-selected** | The harness needs no special network rule to reach `kube-apiserver` under Cilium's *default-allow* posture — this only bites if your cluster (or a cluster-wide default-deny policy) also constrains the harness pod's own egress. | If the harness namespace has a default-deny egress policy, add an explicit allow rule from the harness pod to the API server (typically `kubernetes.default.svc.cluster.local:443`, i.e. the `kube-system`/default `kubernetes` Service) and to DNS — this manifest set does not ship one, since it's specific to whether/how your cluster's default network policy applies to the harness namespace. |

## What this set contains

- `sandbox-namespace.yaml` — the `lastlight-sandboxes` namespace, PSA `restricted`.
- `sandbox-quota.yaml` — `ResourceQuota` (pod-count) + `LimitRange` (default
  per-pod cpu/memory requests+limits).
- `sandbox-rbac.yaml` — the harness `ServiceAccount`, the namespaced `Role`
  (exactly the verbs the harness calls), and the `RoleBinding`.
- `harness-deployment.yaml` — the `lastlight` namespace, its data `PersistentVolumeClaim`,
  the harness `Deployment` (SA-attached, no KVM/no privileged, `/health`
  probes), and the `Service` sandbox pods reach it through.
- `configmap.yaml` — the config overlay: `managedRepos` + `sandbox.backend:
  kubernetes` + `sandbox.kubernetes.*`.
- `kustomization.yaml` — ties the above together for `kubectl apply -k`.

Not shipped, by design:

- **The `lastlight-secrets` Secret** (GitHub App PEM + `.env`) — credentials,
  created out-of-band (below).
- **`CiliumNetworkPolicy` objects** — the harness renders and applies these
  itself at runtime from `egress-allowlist.ts`, once the RBAC verb is granted;
  there's nothing to hand-author or keep in sync here.
- **Ingress/Gateway** for the GitHub webhook — cluster-specific; add your own
  Ingress/Gateway/HTTPRoute fronting the `lastlight` Service on port 8644.
- **`imagePullSecret`** — only needed for a private registry; see the matrix
  above.

## The values you edit

| Value | Where | Default | Edit when |
|---|---|---|---|
| Sandbox namespace | `sandbox-namespace.yaml`, `sandbox-rbac.yaml` (Role/RoleBinding namespace), `configmap.yaml` (`sandbox.kubernetes.namespace`) | `lastlight-sandboxes` | You need a non-default name — keep all three in sync, it's the one name code and manifests share. |
| Harness namespace/name/pod-labels | `harness-deployment.yaml`, `sandbox-rbac.yaml` (`ServiceAccount`/`RoleBinding` subject namespace) | `lastlight` namespace, `lastlight` Deployment/Service, `app.kubernetes.io/name: lastlight` pod label | You relabel/rename the harness — then also set `sandbox.kubernetes.harnessNamespace`/`harnessEndpoint`/`harnessPodLabels` (or the `LASTLIGHT_K8S_HARNESS_*` env vars) to match, or the skill-fetch egress rule and DNS name stop resolving. |
| `storageClassName` | `configmap.yaml` (`sandbox.kubernetes.storageClassName`) for the per-PR workspace PVCs; `harness-deployment.yaml`'s PVC (commented out) for the harness's own data PVC | empty (cluster default) | Your cluster's default `StorageClass` isn't RWO block/local (e.g. it's NFS-backed) — set an explicit block/local class in both places. |
| Sandbox image tag | `configmap.yaml` (`sandbox.kubernetes.image`) | `ghcr.io/nearform/lastlight-sandbox:latest` | Pin to a release tag for reproducibility. |
| Harness agent image tag | `harness-deployment.yaml` (`spec.template.spec.containers[0].image`) | `ghcr.io/nearform/lastlight-agent:latest` | Same — pin once you cut a deploy. |
| `ResourceQuota` pod count | `sandbox-quota.yaml` (`spec.hard.pods`) | `"4"` | Scale concurrency to your cluster's real capacity — this is the single concurrency knob (design §8), not an app-level setting. |
| `managedRepos` | `configmap.yaml` | placeholder `your-org/your-repo` | Always — the bot won't act on any repo until this (or the GitHub App's installation-repo list) is set. |
| `workspaceSize` | `configmap.yaml` (`sandbox.kubernetes.workspaceSize`) | `5Gi` | Your repos' checkouts (+ `node_modules` etc.) don't fit in 5Gi. |

Full env-var surface (each overrides the matching `sandbox.kubernetes.*` YAML
key; see `resolveKubernetesConfig` in `apps/server/src/config/config.ts`):

| Env var | Overrides |
|---|---|
| `LASTLIGHT_K8S_NAMESPACE` | `sandbox.kubernetes.namespace` |
| `K8S_SANDBOX_IMAGE` | `sandbox.kubernetes.image` |
| `LASTLIGHT_K8S_STORAGE_CLASS` | `sandbox.kubernetes.storageClassName` |
| `LASTLIGHT_K8S_WORKSPACE_SIZE` | `sandbox.kubernetes.workspaceSize` |
| `LASTLIGHT_K8S_RUN_AS_USER` | `sandbox.kubernetes.runAsUser` |
| `LASTLIGHT_K8S_HARNESS_ENDPOINT` | `sandbox.kubernetes.harnessEndpoint` |
| `LASTLIGHT_K8S_HARNESS_NAMESPACE` | `sandbox.kubernetes.harnessNamespace` |
| `LASTLIGHT_K8S_HARNESS_POD_LABELS` | `sandbox.kubernetes.harnessPodLabels` (`k=v,k=v` form) |

## Create the Secret

```bash
kubectl create secret generic lastlight-secrets \
  --namespace lastlight \
  --from-file=.env=instance/secrets/.env \
  --from-file=app.pem=instance/secrets/app.pem
```

(The `lastlight` namespace must exist first — apply the rest of the set, or
just `kubectl apply -f harness-deployment.yaml`, then create the Secret; the
harness pod stays `Pending`/`CreateContainerConfigError` until it exists.)

## Apply order

`kubectl apply -k .` applies everything in one pass — Kubernetes/kustomize
handle the namespace-before-namespaced-object ordering. If you're applying
files individually instead:

```bash
kubectl apply -f sandbox-namespace.yaml       # namespace must exist first
kubectl apply -f harness-deployment.yaml      # creates the `lastlight` namespace too
kubectl apply -f sandbox-rbac.yaml            # SA + Role + RoleBinding
kubectl apply -f sandbox-quota.yaml           # ResourceQuota + LimitRange
kubectl apply -f configmap.yaml
# then create the Secret (above), then:
kubectl rollout status deployment/lastlight -n lastlight
```

## Apply

```bash
kubectl apply -k .
```

The harness Pod becomes ready once `/health` responds (no QEMU guest-image
download to wait on here, unlike the `gondolin` backend — startup should be
fast). The first sandboxed phase it runs will create a Pod in
`lastlight-sandboxes`; watch it with:

```bash
kubectl get pods -n lastlight-sandboxes -w
```

## Validate the manifests yourself

```bash
kustomize build apps/server/deploy/k8s | kubeconform -strict -ignore-missing-schemas
```

`-ignore-missing-schemas` is needed only because the `CiliumNetworkPolicy`
custom resource's CRD schema isn't bundled with kubeconform's default schema
set (its RBAC `Role` rule referencing it, shipped here, needs no such
schema — only the CNP *objects* the harness generates at runtime would).
