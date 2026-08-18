import type { V1Container, V1Pod } from "@kubernetes/client-node";
import type { RunResult } from "agentic-pi";
import type {
  Sandbox,
  SandboxFactoryOpts,
  PrePopulateSpec,
  ProvisionResult,
  RunAgentOpts,
  RunCommandOpts,
  RawCommandResult,
  SandboxEvent,
} from "../sandbox.js";
import { parseLine } from "../sandbox.js";
import type { SandboxBackend } from "../../config/config.js";
import { artifactStore, type ArtifactStore } from "../artifact-store.js";
import { loadAgentContext } from "../../workflows/loader.js";
import { makeK8sApis, type K8sApis } from "./client.js";
import { buildPodManifest, WORKSPACE_DIR } from "./pod.js";
import { buildServiceContainers } from "./service-containers.js";
import { ServiceSet } from "lastlight-shared/sandbox-services";
import { buildRunAgentScript } from "./run-agent-script.js";
import { podNameFor } from "./naming.js";
import { RunId } from "./run-id.js";
import { streamPodLog } from "./log-stream.js";
import {
  awaitPodResult,
  reclaimStalePod,
  waitForContainerStart,
  waitForPodGone,
} from "./pod-lifecycle.js";
import { buildCloneInitContainer } from "./init-clone.js";
import { buildSkillsInitContainer } from "./init-skills.js";
import { buildAgentContextInitContainer } from "./init-agent-context.js";
import { agentContextRegistry, type AgentContextRegistry } from "./agent-context-registry.js";
import { DEFAULT_ALLOWLIST, mergeAllowlist } from "../egress-allowlist.js";
import { egressModeFor, type HarnessSelector } from "./egress-policy.js";
import { EgressEnsurer, egressEnsurer } from "./egress-ensurer.js";
import {
  buildSkillTar,
  skillBundleRegistry,
  SKILLS_MOUNT_DIR,
  type SkillBundleRegistry,
} from "./skill-bundle.js";
import { QuotaExceededError, isQuotaExceeded, quotaMessage } from "./quota.js";
import { WorkspaceProvisioner, type Provisioned } from "./workspace-provisioner.js";
import { RunSecrets, type RunSecretsResult } from "./run-secrets.js";
import { AGENTIC_PROFILES, type AgentContextSink } from "../../engine/github/profiles.js";

/** Valid `--thinking` reasoning-effort levels. Mirrors the docker backend's
 *  guard (`docker.ts`) — a shared-set consolidation (the same move F8 made
 *  for `profile`) is a later task. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Valid `--web-search-provider` values. Mirrors the docker backend's guard. */
const WEB_SEARCH_PROVIDERS = new Set(["tavily", "brave", "exa"]);

/** The live pod + its Secrets for the last run, threaded explicitly out of
 *  `runPod` and held only for `dispose` to reap — the one piece of per-run
 *  state that outlives the call that created it (the pod `dispose` deletes and
 *  the Secrets it best-effort clears as a cascade-GC backstop). */
interface RunHandles extends RunSecretsResult {
  pod: string;
}

/** Config the adapter needs. `storageClassName` / `workspaceSize` size and
 *  class the per-(repo,PR) PVC (Task 5); `runAsUser` is the pod and
 *  initContainer security-context UID. `harnessEndpoint` / `harnessNamespace`
 *  / `harnessPodLabels` locate the harness Pod the skills-init fetches the
 *  bundle from (Task 3/6). The factory (`sandbox.ts`) resolves and passes all
 *  of these via `resolveKubernetesConfig()`. */
export interface K8sAdapterConfig {
  namespace: string;
  image: string;
  storageClassName: string;
  workspaceSize: string;
  runAsUser: number;
  harnessEndpoint: string;
  harnessNamespace: string;
  harnessPodLabels: Record<string, string>;
  /** Image for the port-remap forwarder sidecar. Operator config, never repo-chosen. */
  forwarderImage?: string;
  /** Injectable fake `K8sApis` for tests; defaults to the real client. */
  apis?: K8sApis;
  /** Injectable registry for tests; defaults to the module singleton skillBundleRegistry. */
  skillRegistry?: SkillBundleRegistry;
  /** Injectable registry for tests; defaults to the module singleton agentContextRegistry. */
  agentContextRegistry?: AgentContextRegistry;
  /** Injectable artifact store (tests only). Defaults to the module-wide
   *  `artifactStore` singleton (`../artifact-store.js`) — the same instance
   *  the `/internal/sandbox-artifacts` route resolves tokens against, so a
   *  token this adapter registers is always resolvable by that route. */
  artifactStore?: ArtifactStore;
  /** Injectable egress-policy applier (tests only). Defaults to the module-wide
   *  `egressEnsurer` singleton (`./egress-ensurer.js`) so production keeps
   *  ensure-once-per-namespace-per-process behaviour. A test can inject a
   *  fresh `EgressEnsurer` for isolation instead of needing a unique
   *  namespace per test. */
  egressEnsurer?: EgressEnsurer;
}

/**
 * The `kubernetes` {@link Sandbox} adapter — one pod per `runAgent`/
 * `runCommand` call. A thin orchestrator (F1): it wires the collaborators that
 * own the real work — {@link WorkspaceProvisioner} (emptyDir vs per-(repo,PR)
 * PVC), {@link RunSecrets} (creds/prompt Secret create + ownerRef patch +
 * best-effort delete), {@link EgressEnsurer} (the CiliumNetworkPolicy pair),
 * and the free pod-lifecycle functions (`pod-lifecycle.ts`) — behind the
 * unchanged `Sandbox` port.
 *
 * `provision` hands back a {@link Provisioned} the orchestrator holds until
 * `dispose` (the sequence provision→runPod is provision-scoped, and the port
 * gives no channel to thread it per call); `runPod` threads a
 * {@link RunHandles} out explicitly for `runCommand`'s result poll and for
 * `dispose` to reap, rather than stashing loose `activePod`/`activeCredsSecret`
 * mutable fields mid-call. The only other fields that outlive a call are the
 * skill/agent-context/artifact tokens, kept solely so `dispose` can evict them.
 *
 * `runAgent` delivers the prompt via a per-run prompt Secret mounted into the
 * pod and piped to the agent's stdin; the resolved agent-context (persona/hard
 * rules) is delivered over its own HTTP init-fetch channel (nearform#240),
 * mirroring skills: `runAgent` registers the resolved text with the (injectable)
 * agent-context registry, carries the fetch token into the creds Secret, and
 * adds an agent-context initContainer that pulls it from the harness's
 * `/internal/agent-context` route and writes it to `<WORKSPACE_DIR>/AGENTS.md`.
 * The text is handed in by the orchestrator through {@link setAgentContext} — the
 * same composition the host-shared backends write to disk, so a run's repo layer
 * (issue #180) reaches both — and only falls back to the module-level loader when
 * no caller offered one.
 * A dedicated route (not the skills bundle) because agent-context is
 * per-run-constant and a no-skills phase must still receive `AGENTS.md`.
 * `stageSkills` tars the resolved skill dirs and registers the bundle with the
 * (injectable) skill registry; `runPod` then carries the fetch token into the
 * creds Secret and adds a skills initContainer that pulls it from the harness's
 * `/internal/skill-bundle` route. `runAgent` additionally mints a per-run token
 * from the (injectable) artifact store and carries it into the same creds
 * Secret; the in-pod script tars `.lastlight/` after the agent finishes and
 * uploads it to the harness's `/internal/sandbox-artifacts` route, best-effort
 * so an upload hiccup never masks the agent's real exit code — `dispose` evicts
 * the token afterward.
 */
export class KubernetesSandbox implements Sandbox, AgentContextSink {
  readonly backend: SandboxBackend = "kubernetes";
  private readonly apis: K8sApis;
  private readonly ns: string;
  private readonly image: string;
  private readonly runAsUser: number;
  private readonly harnessEndpoint: string;
  private readonly harnessNamespace: string;
  private readonly harnessPodLabels: Record<string, string>;
  private readonly forwarderImage: string;
  private readonly skillRegistry: SkillBundleRegistry;
  private readonly agentContextRegistry: AgentContextRegistry;
  private readonly artifactStore: ArtifactStore;
  private readonly egressEnsurer: EgressEnsurer;
  private readonly provisioner: WorkspaceProvisioner;
  private readonly runSecrets: RunSecrets;
  /** Result of the last `provision()` call — the workspace descriptor + pre-clone
   *  coordinates `runPod` reads to shape the pod (PVC/emptyDir volume, clone
   *  init, run-id stamp). Set once per sandbox lifecycle, before any run. */
  private provisioned?: Provisioned;
  /** Pod + Secrets for the last run, held for `dispose` to reap. */
  private handles?: RunHandles;
  /** Fetch token for the bundle staged by the last `stageSkills()` call, if
   *  any — `runPod` carries it into the creds Secret + skills-init; `dispose`
   *  evicts it from the registry. */
  private skillToken?: string;
  /** Fetch token for the resolved agent-context registered by the last
   *  `runAgent()` call, if any — `runPod` carries it into the creds Secret +
   *  agent-context-init; `dispose` evicts it from the registry. Never minted
   *  for `runCommand` (no agent, no AGENTS.md), nor when the context is empty. */
  private agentContextToken?: string;
  /** Artifact-upload token minted by the last `runAgent()` call, if any —
   *  `runPod` carries it into the creds Secret; the in-pod script reads it back
   *  via env to authenticate the `.lastlight/` upload; `dispose` evicts it from
   *  the store. Never minted for `runCommand` (nothing to upload). */
  private artifactToken?: string;
  /** The agent context the orchestrator resolved for THIS run (issue #180) —
   *  set through {@link setAgentContext} before `runAgent`. Per-instance, and a
   *  sandbox instance is per-run, so it can't leak between runs. Undefined when
   *  the caller never offered one; `runAgent` then falls back to the
   *  module-level loader exactly as it did before the seam existed. */
  private agentContext?: string;

  constructor(
    private readonly opts: SandboxFactoryOpts,
    cfg: K8sAdapterConfig,
  ) {
    this.apis = cfg.apis ?? makeK8sApis();
    this.ns = cfg.namespace;
    this.image = opts.imageName ?? cfg.image;
    this.runAsUser = cfg.runAsUser;
    this.harnessEndpoint = cfg.harnessEndpoint;
    this.harnessNamespace = cfg.harnessNamespace;
    this.harnessPodLabels = cfg.harnessPodLabels;
    this.forwarderImage = cfg.forwarderImage ?? "alpine/socat:latest";
    this.skillRegistry = cfg.skillRegistry ?? skillBundleRegistry;
    this.agentContextRegistry = cfg.agentContextRegistry ?? agentContextRegistry;
    this.artifactStore = cfg.artifactStore ?? artifactStore;
    this.egressEnsurer = cfg.egressEnsurer ?? egressEnsurer;
    this.provisioner = new WorkspaceProvisioner(this.apis.core, {
      namespace: cfg.namespace,
      storageClassName: cfg.storageClassName,
      workspaceSize: cfg.workspaceSize,
      taskId: opts.taskId,
    });
    this.runSecrets = new RunSecrets(this.apis.core, cfg.namespace);
  }

  /**
   * {@link AgentContextSink} — take the run's already-composed agent context
   * (persona + hard rules) from the orchestrator.
   *
   * The kubernetes backend is the one adapter that can't be served by the
   * orchestrator's plain workspace write (its `hostWorkspaceDir` is an in-pod
   * path), so it receives the SAME text through this seam and serves it over the
   * init-fetch channel below. Security-relevant: the value is used verbatim.
   * Re-composing it here would drop the target repo's additive
   * `agent-context/*.md` — and, worse, a naive re-compose that *did* include the
   * repo layer would bypass the additive-only filter the orchestrator's value has
   * already been through.
   */
  setAgentContext(text: string): void {
    this.agentContext = text;
  }

  async provision(pre?: PrePopulateSpec): Promise<ProvisionResult> {
    this.provisioned = await this.provisioner.provision(pre);
    return this.provisioned.result;
  }

  /**
   * Package `skillPaths` into a tar, register it in the (injectable) skill
   * registry, and return the in-pod dirs the agent should `--skill` against.
   * The returned token is stashed on `this.skillToken` so `runPod` can wire the
   * creds Secret + skills-init and `dispose` can evict it; the orchestrator also
   * threads the returned dirs back in as `opts.skillDirs` for the `runAgent`
   * command (Task 6 brief). Deduped: `buildSkillTar` doesn't dedupe
   * sanitized-name collisions (two skill dirs whose basenames sanitize equal
   * merge in the tar), so a `Set` here at least keeps the returned `--skill`
   * list free of repeats.
   */
  stageSkills(_phaseKey: string, skillPaths: string[] | undefined): string[] | undefined {
    const { tar, names } = buildSkillTar(skillPaths ?? []);
    if (!names.length) return undefined;
    this.skillToken = this.skillRegistry.register(tar);
    return [...new Set(names)].map((n) => `${SKILLS_MOUNT_DIR}/${n}`);
  }

  /** Hosts the strict policy allows — the shared allowlist plus OTEL collector
   *  hosts when sandbox OTEL forwarding is on (mirrors `egressPolicyFor`). */
  private strictHosts(): string[] {
    const otel = this.opts.otel;
    const extra = otel?.enabled && otel.forwardToSandbox ? otel.collectorHosts : [];
    return mergeAllowlist(DEFAULT_ALLOWLIST, extra);
  }

  /** Apply the egress policy pair once per namespace, via the injected
   *  {@link EgressEnsurer} (`this.egressEnsurer`). Best-effort in Plan 3: a
   *  403 means the CiliumNetworkPolicy RBAC verb isn't granted yet (Plan 6),
   *  so it warns ONCE and runs on Cilium's default-allow — no regression to
   *  the validated flows; the same code enforces the moment RBAC lands. */
  private ensureEgress(): Promise<void> {
    const port = Number(new URL(this.harnessEndpoint).port) || 8644;
    const harness: HarnessSelector = {
      namespace: this.harnessNamespace,
      labels: this.harnessPodLabels,
      port,
    };
    return this.egressEnsurer.ensure(this.apis.custom, this.ns, this.strictHosts(), harness);
  }

  sandboxPathFor(relPath: string): string {
    return `${WORKSPACE_DIR}/${relPath}`;
  }

  /** The provisioned pre-clone descriptor's `runId` wrapped as a {@link RunId}
   *  — stamped identically onto the Pod (`runPod`) and the PVC
   *  (`WorkspaceProvisioner`) so the reclaim run-selector (Plan 5) matches both
   *  (F7). Undefined when `provision()` had no pre-clone descriptor, or the
   *  descriptor carried no runId. */
  private currentRunId(): RunId | undefined {
    const runId = this.provisioned?.pre?.runId;
    return runId ? RunId.from(runId) : undefined;
  }

  async runAgent(
    taskId: string,
    prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    // The prompt reaches the container via a mounted Secret file (see
    // `RunSecrets`), piped to stdin by the generated script — never as a CLI
    // arg (`ps`-visible) or inline env. AGENTS.md (nearform#240): the harness
    // has no host-shared workspace to write it into on k8s (`writeAgentsMd` is
    // skipped for this backend — see orchestrator.ts), so the resolved
    // agent-context is served over a dedicated authenticated HTTP init-fetch
    // channel (mirroring skills): register the text, mint a token, and an
    // agent-context initContainer pulls it into `<WORKSPACE_DIR>/AGENTS.md`
    // before the agent runs. Empty context ⇒ no token, no init container.
    this.artifactToken = this.artifactStore.register(this.opts.taskId);
    // The run's own context when the orchestrator supplied one (it carries the
    // target repo's additive agent-context; see `setAgentContext`), else the
    // operator-only module-level composition — the pre-issue-#180 behaviour.
    const agentContext = this.agentContext ?? loadAgentContext();
    if (agentContext) this.agentContextToken = this.agentContextRegistry.register(agentContext);

    // Untrusted / free-form values (model, harness endpoint, profile, thinking
    // level, web-search provider) never get spliced into the script TEXT — each
    // is validated against a closed set (where one applies) then bound to its
    // own `sh` positional arg (`$1`..`$5`) below, immune to quote-breaking
    // regardless of characters (the same contract `init-clone.ts` uses).
    // `buildRunAgentScript` only ever sees booleans deciding whether a flag
    // appears, never the values.
    this.assertValidRunAgentOpts(opts);

    const script = buildRunAgentScript({
      profile: Boolean(opts.profile),
      skillDirs: opts.skillDirs ?? [],
      thinking: Boolean(opts.thinking),
      webSearch: opts.webSearch === true,
      webSearchProvider: opts.webSearch === true && Boolean(opts.webSearchProvider),
      artifactUpload: Boolean(this.artifactToken),
    });
    // `runPod` stashes the resulting `RunHandles` on `this.handles` for
    // `dispose`; `runAgent` has no further use for them (the orchestrator
    // reconstructs the result from the streamed events), so the return is
    // ignored here — unlike `runCommand`, which threads them into its poll.
    await this.runPod({
      taskId,
      command: [
        "sh",
        "-c",
        script,
        "sh",
        opts.model,
        this.harnessEndpoint,
        opts.profile ?? "",
        opts.thinking ?? "",
        opts.webSearchProvider ?? "",
      ],
      env: { ...this.opts.env, ...opts.sandboxEnv },
      cwd: opts.agentCwd,
      onLine: parseLine(onEvent),
      promptText: prompt,
    });
    return undefined; // orchestrator reconstructs the result from the streamed events
  }

  /** Guard the free-form `runAgent` options against their closed sets so an
   *  unexpected value fails loudly here rather than reaching the CLI. Profile
   *  enables agentic-pi's github_* extension per access profile; web-search
   *  defaults OFF (agentic-pi auto-enables it whenever any `*_API_KEY` is
   *  present, so a phase that never opted in actively suppresses it via the
   *  script's `--no-web-search`). */
  private assertValidRunAgentOpts(opts: RunAgentOpts): void {
    if (opts.profile && !AGENTIC_PROFILES.has(opts.profile)) {
      throw new Error(
        `Refusing to pass profile "${opts.profile}" — must be one of ` +
          `${[...AGENTIC_PROFILES].join("|")}`,
      );
    }
    if (opts.thinking && !THINKING_LEVELS.has(opts.thinking)) {
      throw new Error(
        `Refusing to pass thinking "${opts.thinking}" — must be one of ` +
          `${[...THINKING_LEVELS].join("|")}`,
      );
    }
    if (opts.webSearch === true && opts.webSearchProvider) {
      if (!WEB_SEARCH_PROVIDERS.has(opts.webSearchProvider)) {
        throw new Error(
          `Refusing to pass web-search-provider "${opts.webSearchProvider}" — must be one of ` +
            `${[...WEB_SEARCH_PROVIDERS].join("|")}`,
        );
      }
    }
  }

  async runCommand(taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult> {
    let stdout = "";
    const handles = await this.runPod({
      taskId,
      command: ["sh", "-c", command],
      env: { ...this.opts.env, ...opts.sandboxEnv },
      cwd: opts.cwd,
      onLine: (line) => {
        stdout += line + "\n";
      },
      timeoutSeconds: opts.timeoutSeconds,
    });
    const { exitCode, timedOut } = await this.awaitPodResult(handles.pod);
    return { exitCode, stdout, stderr: "", timedOut };
  }

  /** Delegates to {@link awaitPodResult} (`pod-lifecycle.ts`) — see there for
   *  the poll/fallback rationale. */
  private awaitPodResult(name: string): Promise<{ exitCode: number; timedOut: boolean }> {
    return awaitPodResult(this.apis.core, this.ns, name);
  }

  private async runPod(input: {
    taskId: string;
    command: string[];
    env: Record<string, string>;
    cwd: string;
    onLine: (line: string) => void;
    timeoutSeconds?: number;
    /** Prompt text for a `runAgent` call — creates a prompt Secret mounted
     *  into the pod. Omitted for `runCommand` (no prompt to deliver). */
    promptText?: string;
  }): Promise<RunHandles> {
    const { taskId, command, env, cwd, onLine, timeoutSeconds, promptText } = input;
    // `Rfc1123Label`, not a raw string: threading the type through is what makes
    // "a Secret name is only ever derived from a pod name" a compile-time fact
    // (F6) — `RunSecrets` takes this label directly, so a raw string can't reach
    // it.
    const podLabel = podNameFor(taskId, "run");
    await this.ensureEgress();

    // Clear a previous attempt's tombstone BEFORE creating anything (#336).
    // These names are deterministic, so a retry of a run whose harness died
    // mid-flight would otherwise 409 on the Secret create below — and again on
    // the pod create, since deleting the pod is what GCs its Secrets. Only a
    // finished pod is reclaimed; a live one still means a real collision.
    await reclaimStalePod(this.apis.core, this.ns, podLabel.value);

    const secrets = await this.runSecrets.create({
      podLabel,
      env,
      skillToken: this.skillToken,
      agentContextToken: this.agentContextToken,
      artifactToken: this.artifactToken,
      promptText,
    });
    // Handle set the moment the Secrets exist and the pod name is fixed — so
    // `dispose` can reap the pod + Secrets even if a later step (pod create,
    // start wait, log stream) throws, mirroring the old early `activePod`
    // assignment (the input channel is gone; disposal state is not).
    const handles: RunHandles = { pod: podLabel.value, ...secrets };
    this.handles = handles;

    // Wall-clock cap: activeDeadlineSeconds kills the pod at the per-call budget
    // (runCommand threads its RunCommandOpts.timeoutSeconds; runAgent falls
    // through to the factory timeout). streamPodLog resolves once the pod (and
    // its log stream) terminates, so no separate timeout is needed here.
    const manifest = buildPodManifest({
      name: podLabel.value,
      namespace: this.ns,
      image: this.image,
      command,
      envFromSecret: secrets.credsSecret,
      promptSecret: secrets.promptSecret,
      cwd,
      activeDeadlineSeconds: timeoutSeconds ?? this.opts.timeoutSeconds ?? 1800,
      runAsUser: this.runAsUser,
      workspace: this.provisioned?.workspace ?? { kind: "emptyDir" },
      initContainers: this.buildInitContainers(),
      // Dependency services, translated by the anti-corruption layer. A separate field
      // from initContainers so the creds Secret is never stamped onto them (see pod.ts).
      services: buildServiceContainers(this.opts.services ?? ServiceSet.empty(), {
        forwarderImage: this.forwarderImage,
      }),
      egressPolicy: egressModeFor(this.opts.egress),
      skillsMount: this.skillToken !== undefined,
      runId: this.currentRunId(),
    });
    const created = await this.createPodOrCleanupSecrets(manifest, secrets);
    await this.runSecrets.patchOwnerRefs(created, podLabel.value, secrets);
    await this.waitForContainerStart(podLabel.value);
    await streamPodLog(this.apis.log, this.ns, podLabel.value, "agent", onLine);
    return handles;
  }

  /** The init containers this run needs: the minimal clone (locked decision #2)
   *  only when the run has a PVC workspace AND a pre-clone descriptor (an
   *  ephemeral emptyDir run has nothing to clone into), the skills-init whenever
   *  `stageSkills` staged a bundle, and the agent-context-init whenever
   *  `runAgent` registered a non-empty context (fetches `AGENTS.md` into the
   *  workspace root). All coexist, and `buildPodManifest` attaches the creds
   *  Secret's `envFrom` to each. */
  private buildInitContainers(): V1Container[] {
    const initContainers: V1Container[] = [];
    const pre = this.provisioned?.pre;
    if (this.provisioned?.workspace.kind === "pvc" && pre) {
      initContainers.push(
        buildCloneInitContainer(this.image, {
          owner: pre.owner,
          repo: pre.repo,
          branch: pre.branch,
          cwd: WORKSPACE_DIR,
          runAsUser: this.runAsUser,
          baseBranch: pre.baseBranch,
          runId: pre.runId,
          recreateFromBase: pre.recreateFromBase,
        }),
      );
    }
    if (this.skillToken) {
      initContainers.push(
        buildSkillsInitContainer(this.image, {
          endpoint: this.harnessEndpoint,
          runAsUser: this.runAsUser,
        }),
      );
    }
    if (this.agentContextToken) {
      initContainers.push(
        buildAgentContextInitContainer(this.image, {
          endpoint: this.harnessEndpoint,
          runAsUser: this.runAsUser,
        }),
      );
    }
    return initContainers;
  }

  /** Create the Pod; on failure, best-effort delete the Secret(s) already
   *  created for it (they exist before the Pod per the ordering rule), so a
   *  failed create doesn't orphan them — then rethrow. A ResourceQuota rejection
   *  is backpressure, not a failure: rethrow a typed error so the orchestrator
   *  stamps `error_quota` and the run requeues (see the Concurrency section of
   *  `spec/09-sandbox.md`). */
  private async createPodOrCleanupSecrets(
    manifest: V1Pod,
    secrets: RunSecretsResult,
  ): Promise<V1Pod> {
    try {
      return await this.apis.core.createNamespacedPod({ namespace: this.ns, body: manifest });
    } catch (err) {
      await this.runSecrets.deleteBestEffort(secrets.credsSecret);
      if (secrets.promptSecret) await this.runSecrets.deleteBestEffort(secrets.promptSecret);
      if (isQuotaExceeded(err)) throw new QuotaExceededError(quotaMessage(err));
      throw err;
    }
  }

  /** Delegates to {@link waitForContainerStart} (`pod-lifecycle.ts`) — see
   *  there for the started/fatal/init-container-check rationale. */
  private waitForContainerStart(name: string): Promise<void> {
    return waitForContainerStart(this.apis.core, this.ns, name);
  }

  /** Delegates to {@link waitForPodGone} (`pod-lifecycle.ts`) — see there for
   *  the RWO Multi-Attach rationale. */
  private waitForPodGone(name: string): Promise<void> {
    return waitForPodGone(this.apis.core, this.ns, name);
  }

  async dispose(): Promise<void> {
    const handles = this.handles;
    if (handles) {
      this.handles = undefined;
      let deleteSucceeded = false;
      try {
        await this.apis.core.deleteNamespacedPod({ name: handles.pod, namespace: this.ns });
        deleteSucceeded = true;
      } catch {
        /* already gone — the reclaim sweep (Plan 4) is the backstop */
      }
      if (deleteSucceeded) await this.waitForPodGone(handles.pod);
      await this.runSecrets.deleteBestEffort(handles.credsSecret);
      if (handles.promptSecret) await this.runSecrets.deleteBestEffort(handles.promptSecret);
    }
    if (this.skillToken) {
      this.skillRegistry.evict(this.skillToken);
      this.skillToken = undefined;
    }
    if (this.agentContextToken) {
      this.agentContextRegistry.evict(this.agentContextToken);
      this.agentContextToken = undefined;
    }
    if (this.artifactToken) {
      this.artifactStore.evict(this.artifactToken);
      this.artifactToken = undefined;
    }
  }
}
