import type { CoreV1Api, V1Pod, V1Secret } from "@kubernetes/client-node";
import type { Rfc1123Label } from "./resource-name.js";
import { buildSecretManifest, podOwnerReference, secretNameFor } from "./secret.js";

/** The Secret names a `create()` call produced — the creds Secret always, the
 *  prompt Secret only for a `runAgent` run. The orchestrator folds these into
 *  its {@link RunHandles} (pod + secrets) for cascade-safe disposal. */
export interface RunSecretsResult {
  credsSecret: string;
  promptSecret?: string;
}

/** Inputs for one run's Secrets. `promptText` present ⇒ a prompt Secret is
 *  created (a `runAgent` run); absent ⇒ creds only (a `runCommand` run). The
 *  three tokens, when set, ride the creds Secret so the pod's `envFrom` exposes
 *  them to the main container and the init containers (skills-init /
 *  agent-context-init / the post-run artifact upload). */
export interface CreateSecretsInput {
  podLabel: Rfc1123Label;
  env: Record<string, string>;
  skillToken?: string;
  agentContextToken?: string;
  artifactToken?: string;
  promptText?: string;
}

/**
 * Owns the per-run Secret lifecycle for a `KubernetesSandbox` pod: create the
 * creds (and, for `runAgent`, prompt) Secrets BEFORE the pod (a pod whose
 * `envFrom`/volume names a missing Secret fails to start), patch each Secret's
 * `ownerReferences` to the created pod so deleting the pod cascade-GCs them,
 * and best-effort delete them directly as a backstop. Extracted from
 * `KubernetesSandbox` (F1) so the Secret handling is independently testable
 * against a fake `CoreV1Api`.
 */
export class RunSecrets {
  constructor(
    private readonly core: CoreV1Api,
    private readonly namespace: string,
  ) {}

  /**
   * Create this run's Secrets and return their names. Per-run creds travel in
   * the pod's OWN Secret, never inline on the pod spec (inline env is `kubectl
   * get pod -o yaml`-visible — issue #223); the skill/agent-context/artifact
   * tokens ride the same map so the init containers (skills-init /
   * agent-context-init) and the post-run upload authenticate via the same
   * `envFrom`. The prompt travels a second Secret mounted read-only and piped to
   * the agent's stdin.
   */
  async create(input: CreateSecretsInput): Promise<RunSecretsResult> {
    const { podLabel, env, skillToken, agentContextToken, artifactToken, promptText } = input;
    const credsSecret = secretNameFor(podLabel, "creds");
    const credsBody = buildSecretManifest({
      name: credsSecret,
      namespace: this.namespace,
      data: {
        ...env,
        ...(skillToken && { LASTLIGHT_SKILL_TOKEN: skillToken }),
        ...(agentContextToken && { LASTLIGHT_AGENT_CONTEXT_TOKEN: agentContextToken }),
        ...(artifactToken && { LASTLIGHT_ARTIFACT_TOKEN: artifactToken }),
      },
      labels: { "lastlight.io/pod": podLabel.value },
    });

    if (promptText === undefined) {
      await this.core.createNamespacedSecret({ namespace: this.namespace, body: credsBody });
      return { credsSecret };
    }

    const promptSecret = secretNameFor(podLabel, "prompt");
    const promptBody = buildSecretManifest({
      name: promptSecret,
      namespace: this.namespace,
      data: { prompt: promptText },
      labels: { "lastlight.io/pod": podLabel.value },
    });
    await this.createBoth({ credsSecret, credsBody, promptSecret, promptBody });
    return { credsSecret, promptSecret };
  }

  /**
   * Create the creds + prompt Secrets concurrently (one round-trip instead of
   * two sequential ones). `Promise.allSettled`, not `Promise.all`, because
   * parallelizing widens the pre-existing orphan risk: sequentially, only
   * "prompt fails after creds already exists" was reachable (creds is awaited
   * first). Run concurrently, "creds fails while prompt succeeds" becomes
   * reachable too. Either Secret has no ownerReference yet (that patch runs
   * after pod-create), no parent Pod to cascade-GC it, and the reclaim sweep
   * (`reclaim.ts`) only reaps Pods/PVCs, never Secrets — so on ANY failure,
   * best-effort delete whichever Secret DID get created, then rethrow (the
   * creds error takes priority if both failed), keeping the whole create
   * atomic from the caller's view exactly as the sequential version was.
   */
  private async createBoth(args: {
    credsSecret: string;
    credsBody: V1Secret;
    promptSecret: string;
    promptBody: V1Secret;
  }): Promise<void> {
    const { credsSecret, credsBody, promptSecret, promptBody } = args;
    const [credsResult, promptResult] = await Promise.allSettled([
      this.core.createNamespacedSecret({ namespace: this.namespace, body: credsBody }),
      this.core.createNamespacedSecret({ namespace: this.namespace, body: promptBody }),
    ]);
    if (credsResult.status === "fulfilled" && promptResult.status === "fulfilled") return;

    if (credsResult.status === "fulfilled") await this.deleteBestEffort(credsSecret);
    if (promptResult.status === "fulfilled") await this.deleteBestEffort(promptSecret);
    const failed = credsResult.status === "rejected" ? credsResult : promptResult;
    throw (failed as PromiseRejectedResult).reason;
  }

  /**
   * Cascade-GC ref: patch each Secret's `ownerReferences` to the created pod's
   * uid, so deleting the pod GCs them too. The body must be an RFC 6902 JSON
   * Patch document (client-node 1.4.0 always negotiates `application/json-patch+json`
   * for `patchNamespacedSecret`), and `add` (not `replace`) because
   * `ownerReferences` doesn't exist on a freshly created Secret. The two
   * patches target independent Secrets with no cleanup coupling between them
   * (unlike `create`'s orphan risk), so they run concurrently via
   * `Promise.all` — one round-trip instead of two.
   */
  async patchOwnerRefs(pod: V1Pod, podName: string, secrets: RunSecretsResult): Promise<void> {
    const uid = pod.metadata?.uid;
    if (!uid) throw new Error(`k8s sandbox pod ${podName} was created without a uid`);
    const patch = [
      { op: "add", path: "/metadata/ownerReferences", value: [podOwnerReference(podName, uid)] },
    ];
    const names = [secrets.credsSecret, ...(secrets.promptSecret ? [secrets.promptSecret] : [])];
    await Promise.all(
      names.map((name) =>
        this.core.patchNamespacedSecret({ name, namespace: this.namespace, body: patch }),
      ),
    );
  }

  /** Best-effort Secret delete — used both by the pod-create failure path and
   *  `dispose`; swallows the error since the Secret may already be gone
   *  (cascade-GC'd with the pod, or the reclaim sweep). */
  async deleteBestEffort(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedSecret({ name, namespace: this.namespace });
    } catch {
      /* already gone */
    }
  }
}
