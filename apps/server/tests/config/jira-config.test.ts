import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";

// The Jira connector config (issue #501): non-secret behaviour from the YAML
// `jira:` block (fail-soft), credentials from `JIRA_*` env (fail-hard when
// enabled). Default is inert.

function overlayWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lastlight-jira-config-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  return dir;
}

function stubCreds(): void {
  vi.stubEnv("JIRA_SITE_URL", "https://acme.atlassian.net/");
  vi.stubEnv("JIRA_EMAIL", "bot@acme.com");
  vi.stubEnv("JIRA_API_TOKEN", "tok-123");
  vi.stubEnv("JIRA_WEBHOOK_SECRET", "whsecret");
}

describe("loadConfig — jira", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("LASTLIGHT_MODEL", "");
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", "");
    vi.stubEnv("JIRA_SITE_URL", "");
    vi.stubEnv("JIRA_EMAIL", "");
    vi.stubEnv("JIRA_API_TOKEN", "");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "");
    vi.stubEnv("JIRA_CLOUD_ID", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("is inert by default — no overlay, no env", () => {
    expect(loadConfig().jira).toBeUndefined();
  });

  it("stays inert when enabled is not set, even with credentials present", () => {
    stubCreds();
    expect(loadConfig().jira).toBeUndefined();
  });

  it("assembles from env + YAML when enabled, trimming the site-url slash", () => {
    stubCreds();
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith(
        "jira:\n" +
          "  enabled: true\n" +
          "  triggerLabel: ll\n" +
          "  allowedAccountIds: [acc-1, acc-2]\n" +
          "  projects:\n" +
          "    PROJ: { repo: acme/api, components: { Backend: acme/svc } }\n" +
          "  transitions: { started: In Progress, merged: Done }\n" +
          "  webhook: { url: https://ll.example/webhooks/jira, autoSync: true }\n",
      ),
    );
    const jira = loadConfig().jira;
    expect(jira).toBeDefined();
    expect(jira!.siteUrl).toBe("https://acme.atlassian.net");
    expect(jira!.email).toBe("bot@acme.com");
    expect(jira!.apiToken).toBe("tok-123");
    expect(jira!.webhookSecret).toBe("whsecret");
    expect(jira!.triggerLabel).toBe("ll");
    expect(jira!.allowedAccountIds).toEqual(["acc-1", "acc-2"]);
    expect(jira!.projects).toEqual({ PROJ: { repo: "acme/api", components: { Backend: "acme/svc" } } });
    expect(jira!.transitions).toEqual({ started: "In Progress", merged: "Done" });
    expect(jira!.webhook).toEqual({ url: "https://ll.example/webhooks/jira", autoSync: true });
    // cloudId is only for the scoped-token gateway path — absent here.
    expect(jira!.cloudId).toBeUndefined();
  });

  it("carries JIRA_CLOUD_ID when set (the scoped-token path)", () => {
    stubCreds();
    vi.stubEnv("JIRA_CLOUD_ID", "cid-abc");
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("jira:\n  enabled: true\n"));
    expect(loadConfig().jira!.cloudId).toBe("cid-abc");
  });

  it("defaults the trigger label when the YAML omits it", () => {
    stubCreds();
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("jira:\n  enabled: true\n"));
    expect(loadConfig().jira!.triggerLabel).toBe("lastlight");
  });

  it("fails the boot when enabled with a credential missing", () => {
    vi.stubEnv("JIRA_SITE_URL", "https://acme.atlassian.net");
    vi.stubEnv("JIRA_EMAIL", "bot@acme.com");
    vi.stubEnv("JIRA_API_TOKEN", "tok-123");
    // JIRA_WEBHOOK_SECRET deliberately unset.
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("jira:\n  enabled: true\n"));
    expect(() => loadConfig()).toThrow(/JIRA_WEBHOOK_SECRET/);
  });

  it("drops malformed non-secret entries rather than failing boot (fail-soft)", () => {
    stubCreds();
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith(
        "jira:\n" +
          "  enabled: true\n" +
          "  allowedAccountIds: [good, 42, '']\n" +
          "  projects:\n" +
          "    GOOD: { repo: acme/api }\n" +
          "    NOREPO: { components: { X: acme/x } }\n",
      ),
    );
    const jira = loadConfig().jira!;
    // The numeric and empty entries are dropped; the string one survives.
    expect(jira.allowedAccountIds).toEqual(["good"]);
    // The repo-less project is dropped; the valid one survives.
    expect(jira.projects).toEqual({ GOOD: { repo: "acme/api" } });
  });
});
