/**
 * Seam: what a docker sandbox receives for a `sandboxGateway` provider. The
 * real key must not reach the sandbox env in any form — not as the key var,
 * not inside AGENTIC_PI_PROVIDERS.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installProviderOverrides, resetProviderRegistry, PROVIDER_OVERRIDES_ENV } from "#src/config/provider-registry.js";

const { executeAgent } = await import("#src/engine/agent-executor.js");
const { FakeSandbox } = await import("#src/sandbox/sandbox.js");

const REAL_KEY = "sk-test-not-a-real-key";
const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
  resetProviderRegistry();
});

async function runOn(backend: "docker" | "none") {
  const stateDir = mkdtempSync(join(tmpdir(), "ll-exec-gw-"));
  const sessionsDir = join(stateDir, "agent-sessions");
  mkdirSync(join(sessionsDir, "projects"), { recursive: true });
  const fake = new FakeSandbox({ returnRunResult: { success: true } as any });
  await executeAgent(
    "noop",
    { sandbox: backend, stateDir, sessionsDir, model: "acme/some-model" },
    { sandboxFactory: fake.asFactory() },
  );
  return fake;
}

describe("executor: model gateway (docker)", () => {
  it("hands the docker sandbox the placeholder and the gateway URL, never the real key", async () => {
    process.env.ACME_API_KEY = REAL_KEY;
    installProviderOverrides({
      acme: { baseUrl: "https://gw.example/v1", sandboxGateway: true, headers: { "x-cmd-zdr": "1" } },
    });
    const fake = await runOn("docker");
    const env = fake.env!;
    expect(env.ACME_API_KEY).toBe("lastlight-model-gateway");
    const wire = JSON.parse(env[PROVIDER_OVERRIDES_ENV]);
    expect(wire.acme.baseUrl).toBe("http://172.30.0.40/acme");
    expect(wire.acme.apiKeyEnv).toBe("ACME_API_KEY");
    for (const [k, v] of Object.entries(env)) expect(`${k}=${v}`).not.toContain(REAL_KEY);
  });

  it("leaves a provider without sandboxGateway alone", async () => {
    process.env.ACME_API_KEY = REAL_KEY;
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1" } });
    const fake = await runOn("docker");
    expect(fake.env!.ACME_API_KEY).toBe(REAL_KEY);
  });
});
