import { afterEach, describe, it, expect } from "vitest";
import { installProviderOverrides, resetProviderRegistry } from "#src/config/provider-registry.js";
import { dockerSandboxAllowlist } from "#src/sandbox/egress-allowlist.js";

/**
 * The claude-code runtime needs exactly one host, the Anthropic API, and adds
 * none: the built-in `anthropic` provider already puts it on every docker
 * allowlist, and a `sandboxGateway` provider (always one of the operator's own)
 * can never take it away while the built-in one calls it directly. This pins
 * that dependency so a registry change cannot silently cut Claude Code off.
 */
describe("egress for the claude-code runtime", () => {
  afterEach(() => resetProviderRegistry());

  it("the Anthropic API is on the docker allowlist by default", () => {
    expect(dockerSandboxAllowlist()).toContain("anthropic.com");
  });

  it("stays there when an operator gateway provider also uses anthropic.com", () => {
    installProviderOverrides({
      "my-claude": {
        baseUrl: "https://api.anthropic.com/v1",
        api: "anthropic-messages",
        envKey: "MY_CLAUDE_KEY",
        sandboxGateway: true,
      },
    });
    expect(dockerSandboxAllowlist()).toContain("anthropic.com");
  });
});
