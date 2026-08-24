import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, defaultFixConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
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

    it("still accepts a fractional gateTimeoutSeconds — it is a duration, not a count", () => {
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("fix:\n  gateTimeoutSeconds: 90.5\n"));

      expect(loadConfig().fix.gateTimeoutSeconds).toBe(90.5);
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
 * absent/typo'd key, which falls back to the shipped `0` (no overflow).
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

  it("defaults to 0 when the key is absent — no body overflow", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("review:\n  analysis:\n    enabled: true\n"));

    expect(loadConfig().review.analysis.maxBodyComments).toBe(0);
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

  it("falls back to the shipped 0 on garbage — a typo must not open the funnel", () => {
    for (const bad of ["unlimited", "-2"]) {
      resetRuntimeConfigForTests();
      vi.stubEnv(
        "LASTLIGHT_OVERLAY_DIR",
        overlayWith(`review:\n  analysis:\n    maxBodyComments: ${bad}\n`),
      );
      expect(loadConfig().review.analysis.maxBodyComments, bad).toBe(0);
    }
  });
});
