import { describe, it, expect } from "vitest";
import { buildPodManifest, PROMPT_FILE, RUN_ID_LABEL } from "#src/sandbox/k8s/pod.js";
import { EGRESS_POLICY_LABEL } from "#src/sandbox/k8s/egress-policy.js";
import { SKILLS_MOUNT_DIR } from "#src/sandbox/k8s/skill-bundle.js";
import { RunId } from "#src/sandbox/k8s/run-id.js";

describe("buildPodManifest", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "ghcr.io/nearform/lastlight-sandbox:latest",
    command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
    cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800,
    runAsUser: 10001, workspace: { kind: "emptyDir" }, egressPolicy: "strict",
  });
  it("targets the sandbox namespace and image", () => {
    expect(pod.metadata?.namespace).toBe("lastlight-sandboxes");
    expect(pod.spec?.containers[0].image).toBe("ghcr.io/nearform/lastlight-sandbox:latest");
  });
  it("never restarts and has a deadline", () => {
    expect(pod.spec?.restartPolicy).toBe("Never");
    expect(pod.spec?.activeDeadlineSeconds).toBe(1800);
  });
  it("gives the sandbox pod no service-account token", () => {
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
  });
});

describe("buildPodManifest securityContext", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "ghcr.io/yo61/lastlight-sandbox:latest",
    command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
    cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800,
    runAsUser: 10001, workspace: { kind: "emptyDir" }, egressPolicy: "strict",
  });
  it("sets a restricted-compliant pod securityContext", () => {
    expect(pod.spec?.securityContext?.runAsNonRoot).toBe(true);
    expect(pod.spec?.securityContext?.runAsUser).toBe(10001);
    expect(pod.spec?.securityContext?.fsGroup).toBe(10001);
    expect(pod.spec?.securityContext?.seccompProfile?.type).toBe("RuntimeDefault");
  });
  it("sets a restricted-compliant container securityContext", () => {
    const c = pod.spec?.containers[0];
    expect(c?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(c?.securityContext?.capabilities?.drop).toEqual(["ALL"]);
  });
});

describe("buildPodManifest creds via envFrom", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "img", command: ["sh", "-c", "true"],
    envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
    activeDeadlineSeconds: 1800, runAsUser: 10001, workspace: { kind: "emptyDir" },
    egressPolicy: "strict",
  });
  it("pulls env from the creds Secret, not inline values", () => {
    const c = pod.spec?.containers[0];
    expect(c?.envFrom).toContainEqual({ secretRef: { name: "ll-x-creds" } });
    expect(c?.env).toBeUndefined();
  });
});

describe("buildPodManifest prompt mount", () => {
  it("mounts the prompt Secret's `prompt` key as a read-only file when set", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "lastlight-sandboxes", image: "img",
      command: ["sh", "-c", "exec agentic-pi run --model m --sandbox none --no-session < " + PROMPT_FILE],
      envFromSecret: "ll-x-creds", promptSecret: "ll-x-prompt",
      cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "prompt");
    expect(vol?.secret).toMatchObject({
      secretName: "ll-x-prompt",
      items: [{ key: "prompt", path: "prompt" }],
    });
    const mount = pod.spec?.containers[0].volumeMounts?.find((m) => m.name === "prompt");
    expect(mount).toMatchObject({ mountPath: "/lastlight", readOnly: true });
  });

  it("never projects an `agents` key onto the prompt volume (agent-context moved " +
    "to the /internal/agent-context init-fetch channel — nearform#240)", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "lastlight-sandboxes", image: "img",
      command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", promptSecret: "ll-x-prompt",
      cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "prompt");
    expect(vol?.secret?.items).toEqual([{ key: "prompt", path: "prompt" }]);
  });

  it("omits the prompt volume when no promptSecret is given (runCommand path)", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "lastlight-sandboxes", image: "img",
      command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
      cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    expect(pod.spec?.volumes?.some((v) => v.name === "prompt")).toBe(false);
  });
});

describe("buildPodManifest workspace", () => {
  it("backs the workspace with the PVC and attaches the init clone when kind=pvc", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "pvc", claimName: "ws-acme-web-pr12" },
      initContainers: [{ name: "clone", image: "img" }],
      egressPolicy: "strict",
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "workspace");
    expect(vol?.persistentVolumeClaim?.claimName).toBe("ws-acme-web-pr12");
    expect(pod.spec?.initContainers?.[0].name).toBe("clone");
  });
  it("uses emptyDir with no init when kind=emptyDir", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "workspace");
    expect(vol?.emptyDir).toBeDefined();
    expect(pod.spec?.initContainers).toBeUndefined();
  });
  it("attaches the creds Secret envFrom to the init clone container", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "pvc", claimName: "ws-acme-web-pr12" },
      initContainers: [{ name: "clone", image: "img" }],
      egressPolicy: "strict",
    });
    const init = pod.spec?.initContainers?.[0];
    expect(init?.envFrom).toContainEqual({ secretRef: { name: "ll-x-creds" } });
  });
});

describe("buildPodManifest resource requests", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
    envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
    activeDeadlineSeconds: 1800, runAsUser: 10001,
    workspace: { kind: "pvc", claimName: "ws-acme-web-pr12" },
    initContainers: [{ name: "clone", image: "img" }],
    egressPolicy: "strict",
  });

  it("declares requests (no limits) on the agent container so a compute quota can meter it", () => {
    const agent = pod.spec?.containers?.[0];
    expect(agent?.resources?.requests).toEqual({ cpu: "250m", memory: "512Mi" });
    expect(agent?.resources?.limits).toBeUndefined();
  });

  it("declares requests on init containers too (a compute quota meters every container)", () => {
    const init = pod.spec?.initContainers?.[0];
    expect(init?.resources?.requests).toEqual({ cpu: "100m", memory: "128Mi" });
    expect(init?.resources?.limits).toBeUndefined();
  });
});

describe("buildPodManifest egress label", () => {
  it("stamps egress-policy=strict so the strict CiliumNetworkPolicy selects it", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    expect(pod.metadata?.labels?.[EGRESS_POLICY_LABEL]).toBe("strict");
  });
  it("stamps egress-policy=open for an unrestricted phase", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "open",
    });
    expect(pod.metadata?.labels?.[EGRESS_POLICY_LABEL]).toBe("open");
  });
});

describe("buildPodManifest skills mount", () => {
  it("adds a skills emptyDir + mounts it in the agent container when skillsMount is set", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict", skillsMount: true,
      initContainers: [{ name: "skills", image: "img" }],
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "skills");
    expect(vol?.emptyDir).toBeDefined();
    const mount = pod.spec?.containers[0].volumeMounts?.find((m) => m.name === "skills");
    expect(mount?.mountPath).toBe(SKILLS_MOUNT_DIR);
    expect(pod.spec?.initContainers?.some((c) => c.name === "skills")).toBe(true);
  });

  it("omits the skills volume when skillsMount is not set", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    expect(pod.spec?.volumes?.some((v) => v.name === "skills")).toBe(false);
    expect(pod.spec?.containers[0].volumeMounts?.some((m) => m.name === "skills")).toBe(false);
  });
});

describe("buildPodManifest run-id label + fsGroupChangePolicy", () => {
  it("labels the pod with the run id and sets OnRootMismatch when runId is given", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict", runId: RunId.from("run-42"),
    });
    expect(pod.metadata?.labels?.[RUN_ID_LABEL]).toBe("run-42");
    expect(pod.spec?.securityContext?.fsGroupChangePolicy).toBe("OnRootMismatch");
  });
  it("omits the run-id label when no runId, but still sets fsGroupChangePolicy", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    expect(pod.metadata?.labels?.[RUN_ID_LABEL]).toBeUndefined();
    expect(pod.spec?.securityContext?.fsGroupChangePolicy).toBe("OnRootMismatch");
  });
});
