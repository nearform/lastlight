import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  defaultAutonomyConfig,
  getAutonomyConfig,
  isAutonomousRepo,
  loadConfig,
  resetRuntimeConfigForTests,
} from "#src/config/config.js";

// config.ts logs its boot-time warnings through the pino LoggerPort; mock it so
// this suite's stderr stays free of real pino JSON (same shape as
// policy-blocks-boot.test.ts).
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

/**
 * The OPERATOR's `autonomy:` block as `loadConfig` normalises it.
 *
 * The block is spend — a label on an issue turns into an agent run on the
 * operator's budget — so every one of these cases pins a FAILURE DIRECTION, not
 * a value: a malformed key must leave the deployment doing less, never more.
 * And because `getAutonomyConfig()` sits on the router's `issue.labeled` path,
 * none of it may throw and all of it must answer before boot.
 */
function overlayWith(block: string): string {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-boot-"));
  writeFileSync(join(dir, "config.yaml"), block);
  return dir;
}

describe("the packaged autonomy block", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("ships INERT — no repo is listed, so no issue label routes anywhere", () => {
    expect(defaultAutonomyConfig().repos).toEqual([]);
  });

  it("ships the `build` stage, gated, parking the PR for a human", () => {
    const build = defaultAutonomyConfig().stages.build;
    expect(build.enter).toBe("ready-for-agent");
    expect(build.running).toBe("agent-building");
    expect(build.workflow).toBe("build");
    expect(build.gates).toEqual({ post_architect: true, post_reviewer: true });
    expect(build.on_merge).toBe("none");
  });

  it("answers before any config is loaded — the router cannot wait for boot", () => {
    resetRuntimeConfigForTests();
    expect(() => getAutonomyConfig()).not.toThrow();
    expect(getAutonomyConfig()).toEqual(defaultAutonomyConfig());
    expect(getAutonomyConfig().repos).toEqual([]);
  });

  it("hands out a copy — a caller mutating a gate map cannot poison the cache", () => {
    defaultAutonomyConfig().stages.build.gates.post_reviewer = false;
    expect(defaultAutonomyConfig().stages.build.gates.post_reviewer).toBe(true);
  });
});

describe("loadConfig — the autonomy block", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("drops a stage with no `enter` label — it could never fire", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("autonomy:\n  stages:\n    ghost:\n      running: agent-building\n      workflow: build\n"),
    );

    expect(loadConfig().autonomy.stages).not.toHaveProperty("ghost");
  });

  it("coerces an unknown on_merge to `none` rather than enabling a merge", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("autonomy:\n  stages:\n    build:\n      enter: ready-for-agent\n      on_merge: yolo\n"),
    );

    expect(loadConfig().autonomy.stages.build.on_merge).toBe("none");
  });

  it("keeps the three legal on_merge values", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith(
        "autonomy:\n  stages:\n    build:\n      enter: ready-for-agent\n      on_merge: auto\n" +
          "    later:\n      enter: ready-for-later\n      on_merge: auto-low-impact\n",
      ),
    );

    const stages = loadConfig().autonomy.stages;
    expect(stages.build.on_merge).toBe("auto");
    expect(stages.later.on_merge).toBe("auto-low-impact");
  });

  it("keeps only boolean gate leaves — a non-boolean is not an approval decision", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith(
        "autonomy:\n  stages:\n    build:\n      enter: ready-for-agent\n      gates:\n" +
          "        post_architect: false\n        post_reviewer: \"yes\"\n",
      ),
    );

    expect(loadConfig().autonomy.stages.build.gates).toEqual({ post_architect: false });
  });

  it("falls back to the packaged budget for a negative or non-numeric value", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("autonomy:\n  budget:\n    dailyUsd: -5\n    maxConcurrentBuilds: lots\n"),
    );

    const budget = loadConfig().autonomy.budget;
    const packaged = defaultAutonomyConfig().budget;
    expect(budget.dailyUsd).toBe(packaged.dailyUsd);
    expect(budget.maxConcurrentBuilds).toBe(packaged.maxConcurrentBuilds);
    for (const value of Object.values(budget)) expect(value).toBeGreaterThanOrEqual(0);
  });

  it("keeps an explicit 0 — 'refuse everything' is a real setting", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("autonomy:\n  budget:\n    maxConcurrentBuilds: 0\n"));

    expect(loadConfig().autonomy.budget.maxConcurrentBuilds).toBe(0);
  });

  it("drops a non-string repos entry instead of stringifying it", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith('autonomy:\n  repos:\n    - "owner/repo"\n    - 5\n    - null\n    - ""\n'),
    );

    expect(loadConfig().autonomy.repos).toEqual(["owner/repo"]);
  });

  it("degrades a non-array repos value to the inert empty list", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("autonomy:\n  repos: owner/repo\n"));

    expect(loadConfig().autonomy.repos).toEqual([]);
  });
});

describe("isAutonomousRepo", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("matches exactly — no prefixes, and no globs, ever", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith('autonomy:\n  repos:\n    - "owner/repo"\n'));
    loadConfig();

    expect(isAutonomousRepo("owner/repo")).toBe(true);
    expect(isAutonomousRepo("owner/repo2")).toBe(false);
    expect(isAutonomousRepo("owner/*")).toBe(false);
    expect(isAutonomousRepo("other/repo")).toBe(false);
  });

  it("is false for everything when nothing is configured", () => {
    resetRuntimeConfigForTests();
    expect(isAutonomousRepo("owner/repo")).toBe(false);
  });
});
