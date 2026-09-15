import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadConfig,
  defaultFixConfig,
  defaultGateConfig,
  defaultSandboxTimeouts,
  resetRuntimeConfigForTests,
} from "#src/config/config.js";
import { DIAGNOSIS_CLASSES } from "#src/engine/fix-markers.js";

// config.ts logs these boot-time warnings via the pino LoggerPort instead of
// console. Mock the logger so the suite's stderr stays free of real pino
// JSON, and expose warn as a hoisted spy so `said()` below can inspect the
// structured fields (previously a `console.warn` string).
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

/**
 * The OPERATOR's half of the `fix:` policy block — `loadConfig`'s normaliser.
 *
 * The repo layer's clamps are covered in `repo-config.test.ts`; these are the
 * two places the two halves had drifted apart (#256):
 *
 *   - `maxAttempts` accepted any positive number here while the repo clamp
 *     required a whole number, so `2.5` left the two layers disagreeing about
 *     the same leaf; and
 *   - `retryableClasses` accepted any non-empty string, so a typo turned every
 *     diagnosis into a `not-retryable` escalation on the second dispatch with
 *     nothing said anywhere.
 *
 * Both degrade rather than throw — a malformed leaf must never take the harness
 * down at boot — so the WARNING is the contract, and it is asserted here.
 */
function overlayWith(block: string): string {
  const dir = mkdtempSync(join(tmpdir(), "policy-boot-"));
  writeFileSync(join(dir, "config.yaml"), block);
  return dir;
}

describe("loadConfig — the fix policy block", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
    warnSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  const said = () =>
    warnSpy.mock.calls
      .map((call) => {
        const [msg, fields] = call as [string, unknown];
        return `${msg} ${fields ? JSON.stringify(fields) : ""}`;
      })
      .join(" ");

  describe("whole-number budgets", () => {
    it("rejects a fractional maxAttempts, loudly", () => {
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("fix:\n  maxAttempts: 2.5\n"));

      const cfg = loadConfig();

      expect(cfg.fix.maxAttempts).toBe(defaultFixConfig().maxAttempts);
      expect(said()).toContain("fix.maxAttempts");
      expect(said()).toContain("whole number");
    });

    it("applies the same rule to localIterations and maxFlakyDeferrals", () => {
      vi.stubEnv(
        "LASTLIGHT_OVERLAY_DIR",
        overlayWith("fix:\n  localIterations: 1.5\n  maxFlakyDeferrals: 0.5\n"),
      );

      const cfg = loadConfig();

      expect(cfg.fix.localIterations).toBe(defaultFixConfig().localIterations);
      expect(cfg.fix.maxFlakyDeferrals).toBe(defaultFixConfig().maxFlakyDeferrals);
      expect(said()).toContain("fix.localIterations");
      expect(said()).toContain("fix.maxFlakyDeferrals");
    });

    it("keeps 0 for maxFlakyDeferrals — a real value, not a fallback trigger", () => {
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("fix:\n  maxFlakyDeferrals: 0\n"));

      expect(loadConfig().fix.maxFlakyDeferrals).toBe(0);
      expect(said()).not.toContain("maxFlakyDeferrals");
    });

    it("maps the deprecated fix.gateTimeoutSeconds onto gate.timeoutSeconds — still a duration (#385)", () => {
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("fix:\n  gateTimeoutSeconds: 90.5\n"));

      const config = loadConfig();
      expect(config.gate.timeoutSeconds).toBe(90.5);
      expect(config.fix).not.toHaveProperty("gateTimeoutSeconds");
    });
  });

  describe("retryableClasses against the closed enum", () => {
    it("drops a misspelt class and names the five", () => {
      vi.stubEnv(
        "LASTLIGHT_OVERLAY_DIR",
        overlayWith("fix:\n  retryableClasses: [reproducable, env-mismatch]\n"),
      );

      const cfg = loadConfig();

      expect(cfg.fix.retryableClasses).toEqual(["env-mismatch"]);
      expect(said()).toContain("reproducable");
      for (const cls of DIAGNOSIS_CLASSES) expect(said()).toContain(cls);
    });

    it("warns that an all-unknown list turns retries off entirely", () => {
      // The consequence is invisible from the config file: every diagnosis
      // escalates `not-retryable` on the second dispatch and the PR is labelled
      // `requires-human`. Worth one line at boot.
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("fix:\n  retryableClasses: [nonsense]\n"));

      const cfg = loadConfig();

      expect(cfg.fix.retryableClasses).toEqual([]);
      expect(said()).toContain("no PR will be retried");
    });

    it("warns for an explicitly empty list too, and keeps it", () => {
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("fix:\n  retryableClasses: []\n"));

      const cfg = loadConfig();

      expect(cfg.fix.retryableClasses).toEqual([]);
      expect(said()).toContain("no PR will be retried");
    });

    it("passes a valid list through in silence", () => {
      vi.stubEnv(
        "LASTLIGHT_OVERLAY_DIR",
        overlayWith("fix:\n  retryableClasses: [flaky, upstream-broken]\n"),
      );

      const cfg = loadConfig();

      expect(cfg.fix.retryableClasses).toEqual(["flaky", "upstream-broken"]);
      expect(said()).not.toContain("retryableClasses");
    });

    it("falls back to the shipped default when the key is absent or not a list", () => {
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("fix:\n  retryableClasses: nope\n"));

      expect(loadConfig().fix.retryableClasses).toEqual(defaultFixConfig().retryableClasses);
    });
  });
});

/**
 * `review.analysis.maxBodyComments` — the body-side attention budget. The
 * nullable idiom is `fix.maxCostUsd`'s: an explicit `null` is the documented
 * "unlimited body overflow" value (the legacy funnel), distinct from an
 * absent/typo'd key, which falls back to the shipped `5` (a bounded overflow).
 */
describe("loadConfig — review.analysis.maxBodyComments", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("defaults to 5 when the key is absent — a bounded body overflow", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("review:\n  analysis:\n    enabled: true\n"));

    expect(loadConfig().review.analysis.maxBodyComments).toBe(5);
  });

  it("keeps an explicit null — the documented 'unlimited' value, not a fallback trigger", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("review:\n  analysis:\n    maxBodyComments: null\n"),
    );

    expect(loadConfig().review.analysis.maxBodyComments).toBeNull();
  });

  it("keeps an explicit 0 and a positive cap", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("review:\n  analysis:\n    maxBodyComments: 3\n"),
    );
    expect(loadConfig().review.analysis.maxBodyComments).toBe(3);

    resetRuntimeConfigForTests();
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("review:\n  analysis:\n    maxBodyComments: 0\n"),
    );
    expect(loadConfig().review.analysis.maxBodyComments).toBe(0);
  });

  it("falls back to the shipped 5 on garbage — a typo must not open the funnel", () => {
    for (const bad of ["unlimited", "-2"]) {
      resetRuntimeConfigForTests();
      vi.stubEnv(
        "LASTLIGHT_OVERLAY_DIR",
        overlayWith(`review:\n  analysis:\n    maxBodyComments: ${bad}\n`),
      );
      expect(loadConfig().review.analysis.maxBodyComments, bad).toBe(5);
    }
  });
});

/**
 * Issue #385 — every timeout comes from config, with no numeric default in
 * code. `config/default.yaml` is the single source; a missing or invalid key
 * FAILS the boot naming the key, instead of resolving to a number buried in a
 * backend.
 */
describe("loadConfig — timeouts and the gate block (#385)", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
    warnSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  const warned = (needle: string) =>
    warnSpy.mock.calls.some((call) => String((call as [string])[0]).includes(needle));

  it("resolves the packaged values from config/default.yaml", () => {
    const config = loadConfig();
    expect(config.sandboxTimeouts).toEqual({
      agentTimeoutSeconds: 1800,
      commandTimeoutSeconds: 300,
      untilBashTimeoutSeconds: 30,
    });
    expect(config.gate).toEqual({ timeoutSeconds: 900, maxTimeoutSeconds: 1500, phaseTimeoutSeconds: 2400 });
    // The pre-boot fallbacks are the SAME file through the SAME normaliser.
    expect(defaultSandboxTimeouts()).toEqual(config.sandboxTimeouts);
    expect(defaultGateConfig()).toEqual(config.gate);
  });

  it("lets the overlay override a timeout", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("sandbox:\n  agentTimeoutSeconds: 3600\ngate:\n  timeoutSeconds: 1200\n"));
    const config = loadConfig();
    expect(config.sandboxTimeouts.agentTimeoutSeconds).toBe(3600);
    expect(config.gate.timeoutSeconds).toBe(1200);
  });

  it.each([
    ["sandbox:\n  agentTimeoutSeconds: null\n", /sandbox\.agentTimeoutSeconds.*the key is missing/],
    ["sandbox:\n  commandTimeoutSeconds: 0\n", /sandbox\.commandTimeoutSeconds/],
    ["sandbox:\n  untilBashTimeoutSeconds: soon\n", /sandbox\.untilBashTimeoutSeconds/],
    ["gate:\n  maxTimeoutSeconds: null\n", /gate\.maxTimeoutSeconds/],
    ["review:\n  triage:\n    timeoutSeconds: null\n", /review\.triage\.timeoutSeconds/],
    ["review:\n  analysis:\n    seedTimeoutSeconds: -1\n", /review\.analysis\.seedTimeoutSeconds/],
  ])("fails loud, naming the key, on a missing or invalid timeout: %s", (yaml, message) => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith(yaml));
    expect(() => loadConfig()).toThrow(message);
  });

  it("rejects gate.timeoutSeconds above gate.maxTimeoutSeconds", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("gate:\n  timeoutSeconds: 1600\n"));
    expect(() => loadConfig()).toThrow(/gate\.timeoutSeconds \(1600\) must not exceed gate\.maxTimeoutSeconds \(1500\)/);
  });

  it("rejects a gate.phaseTimeoutSeconds that does not exceed gate.maxTimeoutSeconds", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("gate:\n  phaseTimeoutSeconds: 1500\n"));
    expect(() => loadConfig()).toThrow(/gate\.phaseTimeoutSeconds \(1500\) must exceed gate\.maxTimeoutSeconds/);
  });

  it("accepts timeoutSeconds == maxTimeoutSeconds (the bound is inclusive)", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("gate:\n  timeoutSeconds: 1500\n"));
    expect(loadConfig().gate.timeoutSeconds).toBe(1500);
  });

  it("maps the deprecated fix.gateTimeoutSeconds alias and warns", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("fix:\n  gateTimeoutSeconds: 600\n"));
    const config = loadConfig();
    expect(config.gate.timeoutSeconds).toBe(600);
    expect(warned("fix.gateTimeoutSeconds is deprecated")).toBe(true);
    // Provenance credits the overlay, where the operator actually wrote it.
    const sources = config.publicConfig.sources as { gate?: { timeoutSeconds?: string } };
    expect(sources.gate?.timeoutSeconds).toBe("overlay");
  });

  it("ignores the alias (with a warning) when gate.timeoutSeconds is also set", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("fix:\n  gateTimeoutSeconds: 600\ngate:\n  timeoutSeconds: 700\n"));
    expect(loadConfig().gate.timeoutSeconds).toBe(700);
    expect(warned("ignored")).toBe(true);
  });

  it("says nothing when the alias is not used", () => {
    loadConfig();
    expect(warned("gateTimeoutSeconds")).toBe(false);
  });
});
