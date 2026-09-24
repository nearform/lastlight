import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveRetrySettings,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
} from "../src/retry.js";

describe("resolveRetrySettings (precedence: flag > file > default)", () => {
  test("no flags, no file → agentic-pi defaults, enabled", () => {
    const r = resolveRetrySettings({}, undefined);
    assert.equal(r.enabled, true);
    assert.equal(r.maxRetries, DEFAULT_MAX_RETRIES);
    assert.equal(r.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
  });

  test("operator settings.json wins over our defaults", () => {
    const r = resolveRetrySettings({}, { maxRetries: 10, baseDelayMs: 1000 });
    assert.equal(r.maxRetries, 10);
    assert.equal(r.baseDelayMs, 1000);
  });

  test("CLI flags win over both file and defaults", () => {
    const r = resolveRetrySettings(
      { maxRetries: 2, baseDelayMs: 500 },
      { maxRetries: 10, baseDelayMs: 1000 },
    );
    assert.equal(r.maxRetries, 2);
    assert.equal(r.baseDelayMs, 500);
  });

  test("flags and file mix per-field", () => {
    const r = resolveRetrySettings({ maxRetries: 7 }, { baseDelayMs: 3000 });
    assert.equal(r.maxRetries, 7); // from flag
    assert.equal(r.baseDelayMs, 3000); // from file
  });

  test("maxRetries: 0 (disable) is respected, not treated as unset", () => {
    const r = resolveRetrySettings({ maxRetries: 0 }, undefined);
    assert.equal(r.maxRetries, 0);
  });

  test("preserves operator's enabled:false and provider sub-settings", () => {
    const r = resolveRetrySettings(
      {},
      { enabled: false, provider: { maxRetries: 0, maxRetryDelayMs: 60000 } },
    );
    assert.equal(r.enabled, false);
    assert.deepEqual(r.provider, { maxRetries: 0, maxRetryDelayMs: 60000 });
    // unset numeric fields still fall back to our defaults
    assert.equal(r.maxRetries, DEFAULT_MAX_RETRIES);
  });

  test("default schedule rides out a ~60s window (final wait >= 60s)", () => {
    const r = resolveRetrySettings({}, undefined);
    const scheduled = r.baseDelayMs! * 2 ** (r.maxRetries! - 1);
    const finalDelayMs = Math.min(scheduled, r.maxAgentDelayMs!);
    assert.ok(finalDelayMs >= 60_000, `final wait ${finalDelayMs}ms should clear a 60s window`);
  });

  test("Pi's per-wait cap never truncates our schedule", () => {
    const r = resolveRetrySettings({}, undefined);
    assert.equal(r.maxAgentDelayMs, r.baseDelayMs! * 2 ** (r.maxRetries! - 1));
  });

  test("a short schedule keeps Pi's default cap", () => {
    const r = resolveRetrySettings({ maxRetries: 1, baseDelayMs: 1000 }, undefined);
    assert.equal(r.maxAgentDelayMs, 60_000);
  });

  test("operator's maxAgentDelayMs wins", () => {
    const r = resolveRetrySettings({}, { maxAgentDelayMs: 5000 });
    assert.equal(r.maxAgentDelayMs, 5000);
  });
});
