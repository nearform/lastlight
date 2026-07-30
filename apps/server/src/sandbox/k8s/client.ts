import { KubeConfig, CoreV1Api, CustomObjectsApi, Log } from "@kubernetes/client-node";

export interface K8sApis {
  core: CoreV1Api;
  /** CiliumNetworkPolicy (cilium.io/v2) lives off the core API — needs the
   *  generic custom-objects client. */
  custom: CustomObjectsApi;
  log: Log;
  kc: KubeConfig;
}

/**
 * True when running inside a Kubernetes Pod. `KUBERNETES_SERVICE_HOST` is
 * injected into every pod by the kubelet, so it's the reliable in-cluster
 * signal. We must NOT rely on `KubeConfig.loadFromCluster()` throwing
 * off-cluster: in @kubernetes/client-node 1.4.0 it does NOT throw when the
 * service-host env vars are absent — it silently builds a
 * `https://undefined:undefined` server URL, which then fails every request
 * with "Invalid URL". Detect explicitly instead.
 */
export function inClusterConfigAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KUBERNETES_SERVICE_HOST);
}

/** Build the k8s clients. In-cluster (mounted SA token) when running in a Pod;
 *  otherwise the local kubeconfig for dev. Pass an explicit `kc` in tests. */
export function makeK8sApis(kc?: KubeConfig): K8sApis {
  const config = kc ?? loadInClusterOrDefault();
  return {
    core: config.makeApiClient(CoreV1Api),
    custom: config.makeApiClient(CustomObjectsApi),
    log: new Log(config),
    kc: config,
  };
}

function loadInClusterOrDefault(): KubeConfig {
  const kc = new KubeConfig();
  if (inClusterConfigAvailable()) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}
