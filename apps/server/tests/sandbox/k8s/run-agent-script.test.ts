import { describe, it, expect } from "vitest";
import { buildRunAgentScript } from "#src/sandbox/k8s/run-agent-script.js";

/** Minimal valid input — every flag off, no skills. Individual tests spread
 *  over this to flip one thing at a time. */
const base = {
  profile: false,
  skillDirs: [] as readonly string[],
  thinking: false,
  webSearch: false,
  webSearchProvider: false,
  artifactUpload: false,
};

describe("buildRunAgentScript", () => {
  it("never copies AGENTS.md itself — the agent-context init-fetch channel " +
    "(init-agent-context.ts, nearform#240) writes it into the workspace root", () => {
    const script = buildRunAgentScript(base);
    expect(script).not.toContain("AGENTS.md");
    expect(script).not.toContain("/lastlight/AGENTS.md");
  });

  it("always runs agentic-pi with the model bound to $1, sandbox none, no-session", () => {
    const script = buildRunAgentScript(base);
    expect(script).toContain('agentic-pi run --model "$1" --sandbox none --no-session');
  });

  describe("--profile", () => {
    it('emits --profile "$3" when profile is true', () => {
      const script = buildRunAgentScript({ ...base, profile: true });
      expect(script).toContain('--profile "$3"');
    });

    it("omits --profile entirely when profile is false", () => {
      const script = buildRunAgentScript({ ...base, profile: false });
      expect(script).not.toContain("--profile");
    });
  });

  describe("--skill", () => {
    it("emits one --skill flag per dir, in order", () => {
      const script = buildRunAgentScript({
        ...base,
        skillDirs: ["/lastlight-skills/pr-review", "/lastlight-skills/triage"],
      });
      expect(script).toContain("--skill /lastlight-skills/pr-review");
      expect(script).toContain("--skill /lastlight-skills/triage");
      const first = script.indexOf("--skill /lastlight-skills/pr-review");
      const second = script.indexOf("--skill /lastlight-skills/triage");
      expect(first).toBeLessThan(second);
    });

    it("emits no --skill flag when skillDirs is empty", () => {
      const script = buildRunAgentScript({ ...base, skillDirs: [] });
      expect(script).not.toContain("--skill");
    });
  });

  describe("--thinking", () => {
    it('emits --thinking "$4" when thinking is true', () => {
      const script = buildRunAgentScript({ ...base, thinking: true });
      expect(script).toContain('--thinking "$4"');
    });

    it("omits --thinking entirely when thinking is false", () => {
      const script = buildRunAgentScript({ ...base, thinking: false });
      expect(script).not.toContain("--thinking");
    });
  });

  describe("web search (F0 — the behaviour restored on the k8s backend)", () => {
    it("emits --no-web-search when webSearch is false — the suppressor agentic-pi needs " +
      "since it auto-enables search whenever any *_API_KEY is in env", () => {
      const script = buildRunAgentScript({ ...base, webSearch: false, webSearchProvider: false });
      expect(script).toContain("--no-web-search");
      expect(script).not.toContain("--web-search-provider");
    });

    it("omits --no-web-search AND --web-search-provider when webSearch is true but no " +
      "provider was set (agentic-pi auto-detects from the forwarded *_API_KEY)", () => {
      const script = buildRunAgentScript({ ...base, webSearch: true, webSearchProvider: false });
      expect(script).not.toContain("--no-web-search");
      expect(script).not.toContain("--web-search-provider");
    });

    it('emits --web-search-provider "$5" (and omits --no-web-search) when webSearch is ' +
      "true and a provider was set", () => {
      const script = buildRunAgentScript({ ...base, webSearch: true, webSearchProvider: true });
      expect(script).not.toContain("--no-web-search");
      expect(script).toContain('--web-search-provider "$5"');
    });

    it("never emits --web-search-provider when webSearch is false, even if a provider " +
      "was (nonsensically) marked set", () => {
      const script = buildRunAgentScript({ ...base, webSearch: false, webSearchProvider: true });
      expect(script).toContain("--no-web-search");
      expect(script).not.toContain("--web-search-provider");
    });
  });

  describe("artifact-upload block", () => {
    it("appends the tar+curl upload block after the agent exits when artifactUpload is true", () => {
      const script = buildRunAgentScript({ ...base, artifactUpload: true });
      expect(script).toContain("rc=$?");
      expect(script).toContain("tar -czf - .lastlight");
      expect(script).toContain("curl -sf -X POST");
      expect(script).toContain("Authorization: Bearer $LASTLIGHT_ARTIFACT_TOKEN");
      expect(script).toContain('"$2/internal/sandbox-artifacts"');
      expect(script).toContain("|| true");
      expect(script.trim().endsWith("exit $rc")).toBe(true);
    });

    it("omits the upload block entirely when artifactUpload is false", () => {
      const script = buildRunAgentScript({ ...base, artifactUpload: false });
      expect(script).not.toContain("tar -czf");
      expect(script).not.toContain("curl -sf -X POST");
      expect(script).not.toContain(".lastlight");
    });

    it("never runs the agent as a bare exec — the real exit code must be capturable so " +
      "the upload can't mask a failed run", () => {
      const script = buildRunAgentScript({ ...base, artifactUpload: true });
      expect(script.trim().startsWith("exec ")).toBe(false);
    });
  });

  describe("injection safety — model/endpoint/profile/thinking/provider stay argv-only", () => {
    it("the script text only ever references untrusted values via $1..$5 positions, " +
      "never as literal, interpolated text (the builder's input type has no field for " +
      "the actual model/endpoint/profile/thinking/provider strings — only booleans " +
      "deciding whether each flag appears)", () => {
      const script = buildRunAgentScript({
        profile: true,
        skillDirs: ["/lastlight-skills/pr-review"],
        thinking: true,
        webSearch: true,
        webSearchProvider: true,
        artifactUpload: true,
      });
      expect(script).toMatch(/--model\s+"\$1"/);
      expect(script).not.toMatch(/--model\s+(?!"\$1")\S/);
      expect(script).toMatch(/--profile\s+"\$3"/);
      expect(script).not.toMatch(/--profile\s+(?!"\$3")\S/);
      expect(script).toMatch(/--thinking\s+"\$4"/);
      expect(script).not.toMatch(/--thinking\s+(?!"\$4")\S/);
      expect(script).toMatch(/--web-search-provider\s+"\$5"/);
      expect(script).not.toMatch(/--web-search-provider\s+(?!"\$5")\S/);
      expect(script).toMatch(/\$2\/internal\/sandbox-artifacts/);
    });
  });
});
