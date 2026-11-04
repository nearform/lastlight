import { describe, it, expect } from "vitest";
import { sandboxEnvForClaudeCode } from "#src/engine/claude-code/sandbox-env.js";

describe("sandboxEnvForClaudeCode", () => {
  it("keeps the Claude token and drops every GitHub and provider credential", () => {
    const out = sandboxEnvForClaudeCode(
      {
        GIT_TOKEN: "g",
        GITHUB_TOKEN: "g",
        GH_TOKEN: "g",
        GITHUB_APP_ID: "1",
        GIT_CONFIG_KEY_0: "http.extraheader",
        GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic x",
        GIT_CONFIG_COUNT: "1",
        COMMANDCODE_API_KEY: "k",
        DEEPSEEK_API_KEY: "k",
        ANTHROPIC_OAUTH_TOKEN: "k",
        AGENTIC_PI_PROVIDERS: "{}",
        TAVILY_API_KEY: "k",
        PATH: "/usr/bin",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      },
      "sk-ant-oat01-x",
      ["COMMANDCODE_API_KEY", "DEEPSEEK_API_KEY"],
    );
    expect(out).toEqual({
      PATH: "/usr/bin",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
      CLAUDE_CONFIG_DIR: "/home/agent/.claude-ll",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });

  it("drops anything that looks like a key even when the registry does not list it", () => {
    const out = sandboxEnvForClaudeCode({ SOME_NEW_PROVIDER_API_KEY: "k", MY_SECRET: "s", FOO_PASSWORD: "p" }, "t", []);
    expect(Object.keys(out).sort()).toEqual(
      ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER"].sort(),
    );
  });
});
