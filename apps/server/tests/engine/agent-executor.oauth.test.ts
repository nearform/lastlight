/**
 * Executor OAuth env injection — the sandbox path can only carry OAuth creds
 * via env, so `prepareRun` injects the provider's OAuth env var when the run's
 * model is OAuth-backed and a login exists:
 *   - anthropic  → ANTHROPIC_OAUTH_TOKEN
 *   - copilot    → COPILOT_GITHUB_TOKEN
 *   - codex      → no env route → nothing injected (chat-only)
 *
 * We capture the env handed to the sandbox via FakeSandbox and stub
 * `resolveOAuthApiKey` so the assertion is about the wiring, not pi-ai's token
 * internals or the network.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveOAuthApiKeySpy = vi.fn();
vi.mock("#src/engine/oauth.js", async (importActual) => {
  const actual = await importActual<typeof import("#src/engine/oauth.js")>();
  return { ...actual, resolveOAuthApiKey: (...a: unknown[]) => resolveOAuthApiKeySpy(...a) };
});

const { executeAgent } = await import("#src/engine/agent-executor.js");
const { FakeSandbox } = await import("#src/sandbox/sandbox.js");

function stateDirs() {
  const stateDir = mkdtempSync(join(tmpdir(), "ll-exec-oauth-"));
  const sessionsDir = join(stateDir, "agent-sessions");
  mkdirSync(join(sessionsDir, "projects"), { recursive: true });
  return { stateDir, sessionsDir };
}

async function runWithModel(
  model: string,
  opts: { backend?: "none" | "docker"; writeStore?: boolean } = {},
) {
  const { stateDir, sessionsDir } = stateDirs();
  if (opts.writeStore) {
    writeFileSync(
      join(stateDir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } }),
    );
  }
  const fake = new FakeSandbox({ returnRunResult: { success: true } as any });
  await executeAgent("noop", { sandbox: opts.backend ?? "docker", stateDir, sessionsDir, model }, {
    sandboxFactory: fake.asFactory(),
  });
  return { fake, stateDir };
}

const savedEnv = { ...process.env };
beforeEach(() => {
  resolveOAuthApiKeySpy.mockReset();
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.COPILOT_GITHUB_TOKEN;
  // Clear the API-key fallback so the missing-login path is deterministic —
  // individual tests set it back when they exercise the suppression.
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

// Container backends (docker/smol) run the model call in-guest, so OAuth creds
// must ride in via env tokens. These assert that injection.
describe("executor OAuth env injection (container backends)", () => {
  it("injects ANTHROPIC_OAUTH_TOKEN for an Anthropic OAuth model with a login", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue({ apiKey: "ant-oauth-tok", credentials: {} });
    const { fake } = await runWithModel("anthropic/claude-sonnet-4-6", { backend: "docker" });
    expect(resolveOAuthApiKeySpy).toHaveBeenCalledWith("anthropic", undefined, expect.any(String));
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBe("ant-oauth-tok");
  });

  it("injects COPILOT_GITHUB_TOKEN for a Copilot OAuth model with a login", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue({ apiKey: "copilot-tok", credentials: {} });
    const { fake } = await runWithModel("github-copilot/gpt-4o", { backend: "docker" });
    expect(fake.env?.COPILOT_GITHUB_TOKEN).toBe("copilot-tok");
  });

  it("warns (injects nothing) for a Codex model — no in-guest env route", async () => {
    const { fake } = await runWithModel("openai-codex/gpt-5.4", { backend: "docker" });
    expect(resolveOAuthApiKeySpy).not.toHaveBeenCalled();
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(fake.env?.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it("injects nothing for an Anthropic model with no stored login", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue(null);
    const { fake } = await runWithModel("anthropic/claude-sonnet-4-6", { backend: "docker" });
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
  });

  it("warns about a missing OAuth login only when no API-key fallback exists", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runWithModel("anthropic/claude-sonnet-4-6", { backend: "docker" });
    expect(warn.mock.calls.some(([m]) => String(m).includes("needs an OAuth login"))).toBe(true);
  });

  it("stays silent about a missing OAuth login when ANTHROPIC_API_KEY is set (API-key auth works)", async () => {
    // anthropic is oauthOnly:false — with a key present the sandbox authenticates
    // fine, so the OAuth-login warning was pure per-run noise.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    resolveOAuthApiKeySpy.mockResolvedValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake } = await runWithModel("anthropic/claude-sonnet-4-6", { backend: "docker" });
    expect(warn.mock.calls.some(([m]) => String(m).includes("needs an OAuth login"))).toBe(false);
    // The API key still rides into the sandbox env for pi-ai to use.
    expect(fake.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
  });

  it("skips store resolution when an explicit ANTHROPIC_OAUTH_TOKEN is already in the env", async () => {
    process.env.ANTHROPIC_OAUTH_TOKEN = "preset-token";
    await runWithModel("anthropic/claude-sonnet-4-6", { backend: "docker" });
    expect(resolveOAuthApiKeySpy).not.toHaveBeenCalled();
  });

  it("does not resolve OAuth for a plain API-key model", async () => {
    const { fake } = await runWithModel("openai/gpt-5.5", { backend: "docker" });
    expect(resolveOAuthApiKeySpy).not.toHaveBeenCalled();
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
  });
});

// In-process backends (none/gondolin) run the model call host-side, so OAuth is
// carried by the credential store via agentic-pi's `authFile` — NOT env tokens.
describe("executor OAuth via authFile (in-process backends)", () => {
  it("passes authFile to the run and does NOT inject env tokens for Codex", async () => {
    const { fake, stateDir } = await runWithModel("openai-codex/gpt-5.4", {
      backend: "none",
      writeStore: true,
    });
    // No env-token injection on the in-process path…
    expect(resolveOAuthApiKeySpy).not.toHaveBeenCalled();
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    // …instead the store path is handed to agentic-pi as authFile.
    expect(fake.receivedAgentOpts?.authFile).toBe(join(stateDir, "auth.json"));
  });

  it("omits authFile when no credential store exists", async () => {
    const { fake } = await runWithModel("anthropic/claude-sonnet-4-6", { backend: "none" });
    expect(fake.receivedAgentOpts?.authFile).toBeUndefined();
  });
});
