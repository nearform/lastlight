import { describe, it, expect, vi } from "vitest";
import { RunSecrets } from "#src/sandbox/k8s/run-secrets.js";
import { podNameFor } from "#src/sandbox/k8s/naming.js";

/** Minimal fake `CoreV1Api` covering the three Secret methods `RunSecrets`
 *  touches. `deleteThrows` makes the delete reject so the best-effort swallow
 *  can be asserted. */
function fakeCore(opts: { deleteThrows?: boolean } = {}) {
  const secretsCreated: any[] = [];
  const secretsPatched: any[] = [];
  const secretsDeleted: string[] = [];
  const core = {
    createNamespacedSecret: vi.fn(async ({ body }: any) => {
      secretsCreated.push(body);
      return body;
    }),
    patchNamespacedSecret: vi.fn(async ({ name, body }: any) => {
      secretsPatched.push({ name, body });
      return {};
    }),
    deleteNamespacedSecret: vi.fn(async ({ name }: any) => {
      if (opts.deleteThrows) throw new Error("boom");
      secretsDeleted.push(name);
      return {};
    }),
  } as any;
  return { core, secretsCreated, secretsPatched, secretsDeleted };
}

const podLabel = podNameFor("acme-web-pr12", "run");

describe("RunSecrets.create", () => {
  it("creates only a creds Secret when no prompt text is supplied", async () => {
    const { core, secretsCreated } = fakeCore();
    const runSecrets = new RunSecrets(core, "ns");

    const out = await runSecrets.create({ podLabel, env: { GITHUB_TOKEN: "ghs_x" } });

    expect(secretsCreated).toHaveLength(1);
    expect(out.credsSecret).toBe(secretsCreated[0].metadata.name);
    expect(out.credsSecret.endsWith("-creds")).toBe(true);
    expect(out.promptSecret).toBeUndefined();
    expect(secretsCreated[0].stringData).toMatchObject({ GITHUB_TOKEN: "ghs_x" });
    // The pod-linking label is what the reclaim sweep matches secrets on.
    expect(secretsCreated[0].metadata.labels["lastlight.io/pod"]).toBe(podLabel.value);
  });

  it("creates a prompt Secret carrying ONLY the prompt key (agent-context now " +
    "rides the /internal/agent-context init-fetch channel — nearform#240)", async () => {
    const { core, secretsCreated } = fakeCore();
    const runSecrets = new RunSecrets(core, "ns");

    const out = await runSecrets.create({
      podLabel,
      env: {},
      promptText: "REVIEW THIS PR",
    });

    expect(out.promptSecret).toBeDefined();
    const prompt = secretsCreated.find((s: any) => s.metadata.name.endsWith("-prompt"));
    expect(prompt.stringData).toEqual({ prompt: "REVIEW THIS PR" });
  });

  it("carries the agent-context token in the creds Secret so the init can bearer-auth", async () => {
    const { core, secretsCreated } = fakeCore();
    const runSecrets = new RunSecrets(core, "ns");

    await runSecrets.create({
      podLabel,
      env: { GITHUB_TOKEN: "ghs_x" },
      promptText: "hi",
      agentContextToken: "ctx-tok",
    });

    const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    expect(creds.stringData.LASTLIGHT_AGENT_CONTEXT_TOKEN).toBe("ctx-tok");
    const prompt = secretsCreated.find((s: any) => s.metadata.name.endsWith("-prompt"));
    expect(prompt.stringData).toEqual({ prompt: "hi" });
  });

  it("best-effort deletes the creds Secret and rethrows if the prompt Secret create fails", async () => {
    // Restores the pre-refactor guarantee: the creds Secret is created first,
    // has no ownerReference yet, no parent Pod, and the reclaim sweep never
    // touches Secrets — so a prompt-create failure must not orphan it. The
    // ORIGINAL error propagates.
    const { core, secretsCreated, secretsDeleted } = fakeCore();
    const promptErr = new Error("prompt secret create failed");
    core.createNamespacedSecret = vi.fn(async ({ body }: any) => {
      if (body.metadata.name.endsWith("-prompt")) throw promptErr;
      secretsCreated.push(body);
      return body;
    });
    const runSecrets = new RunSecrets(core, "ns");

    await expect(
      runSecrets.create({ podLabel, env: {}, promptText: "hi" }),
    ).rejects.toBe(promptErr);

    const credsName = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds")).metadata
      .name;
    expect(secretsDeleted).toEqual([credsName]);
  });

  it("best-effort deletes the prompt Secret and rethrows if the creds Secret create fails", async () => {
    // Mirror of the previous test — only reachable because `create` now runs
    // both Secret creates concurrently (Promise.allSettled), not sequentially.
    // Sequentially, a creds failure would abort before the prompt create was
    // ever attempted; concurrently, the prompt create can fulfil while creds
    // rejects, so the prompt Secret must not be orphaned either. The ORIGINAL
    // (creds) error propagates.
    const { core, secretsCreated, secretsDeleted } = fakeCore();
    const credsErr = new Error("creds secret create failed");
    core.createNamespacedSecret = vi.fn(async ({ body }: any) => {
      if (body.metadata.name.endsWith("-creds")) throw credsErr;
      secretsCreated.push(body);
      return body;
    });
    const runSecrets = new RunSecrets(core, "ns");

    await expect(
      runSecrets.create({ podLabel, env: {}, promptText: "hi" }),
    ).rejects.toBe(credsErr);

    const promptName = secretsCreated.find((s: any) => s.metadata.name.endsWith("-prompt")).metadata
      .name;
    expect(secretsDeleted).toEqual([promptName]);
  });

  it("injects skill + artifact tokens into the creds Secret when present", async () => {
    const { core, secretsCreated } = fakeCore();
    const runSecrets = new RunSecrets(core, "ns");

    await runSecrets.create({
      podLabel,
      env: { A: "1" },
      skillToken: "skill-tok",
      artifactToken: "artifact-tok",
    });

    const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    expect(creds.stringData).toMatchObject({
      A: "1",
      LASTLIGHT_SKILL_TOKEN: "skill-tok",
      LASTLIGHT_ARTIFACT_TOKEN: "artifact-tok",
    });
  });
});

describe("RunSecrets.patchOwnerRefs", () => {
  it("patches both secrets with a JSON-Patch add op referencing the pod uid", async () => {
    const { core, secretsPatched } = fakeCore();
    const runSecrets = new RunSecrets(core, "ns");
    const pod = { metadata: { name: podLabel.value, uid: "pod-uid-1" } } as any;

    await runSecrets.patchOwnerRefs(pod, podLabel.value, {
      credsSecret: "creds-x",
      promptSecret: "prompt-x",
    });

    expect(secretsPatched.map((p) => p.name)).toEqual(
      expect.arrayContaining(["creds-x", "prompt-x"]),
    );
    for (const { body } of secretsPatched) {
      expect(body).toEqual([
        {
          op: "add",
          path: "/metadata/ownerReferences",
          value: [
            expect.objectContaining({ kind: "Pod", name: podLabel.value, uid: "pod-uid-1" }),
          ],
        },
      ]);
    }
  });

  it("patches only the creds Secret when there is no prompt Secret", async () => {
    const { core, secretsPatched } = fakeCore();
    const runSecrets = new RunSecrets(core, "ns");
    const pod = { metadata: { name: podLabel.value, uid: "pod-uid-1" } } as any;

    await runSecrets.patchOwnerRefs(pod, podLabel.value, { credsSecret: "creds-x" });

    expect(secretsPatched).toHaveLength(1);
    expect(secretsPatched[0].name).toBe("creds-x");
  });

  it("throws when the created pod has no uid to own the secrets", async () => {
    const { core } = fakeCore();
    const runSecrets = new RunSecrets(core, "ns");
    const pod = { metadata: { name: podLabel.value } } as any;

    await expect(
      runSecrets.patchOwnerRefs(pod, podLabel.value, { credsSecret: "creds-x" }),
    ).rejects.toThrow(/without a uid/);
  });
});

describe("RunSecrets.deleteBestEffort", () => {
  it("deletes the named secret", async () => {
    const { core, secretsDeleted } = fakeCore();
    const runSecrets = new RunSecrets(core, "ns");

    await runSecrets.deleteBestEffort("creds-x");

    expect(secretsDeleted).toEqual(["creds-x"]);
  });

  it("swallows a delete error (the secret may already be gone)", async () => {
    const { core } = fakeCore({ deleteThrows: true });
    const runSecrets = new RunSecrets(core, "ns");

    await expect(runSecrets.deleteBestEffort("creds-x")).resolves.toBeUndefined();
  });
});
