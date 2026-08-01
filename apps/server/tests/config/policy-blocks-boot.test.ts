import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, defaultFixConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import { DIAGNOSIS_CLASSES } from "#src/engine/fix-markers.js";

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
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetRuntimeConfigForTests();
  });

  const said = () => warn.mock.calls.flat().join(" ");

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
