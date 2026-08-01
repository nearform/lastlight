import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LOG_EXCERPT_BYTES,
  MAX_LOG_EXCERPT_BYTES,
  MIN_LOG_EXCERPT_BYTES,
  excerptJobLog,
} from "../../../src/extensions/github/log-excerpt.js";

const ts = (n: number) => `2026-07-24T06:04:${String(n).padStart(2, "0")}.000Z`;

describe("excerptJobLog", () => {
  test("strips Actions' per-line ISO timestamps", () => {
    const out = excerptJobLog(`${ts(1)} error: something went wrong\n`);
    assert.match(out.text, /error: something went wrong/);
    assert.doesNotMatch(out.text, /\d{4}-\d{2}-\d{2}T/);
  });

  test("anchors on the error line and keeps surrounding context", () => {
    const log = [
      `${ts(0)} info: start`,
      `${ts(1)} info: running build`,
      `${ts(2)} error: Cannot find module 'postcss-import'`,
      `${ts(3)} info: done`,
    ].join("\n");
    const out = excerptJobLog(log);
    assert.match(out.text, /Cannot find module 'postcss-import'/);
    assert.match(out.text, /info: start/);
  });

  test("prefers a real error line over the 'Process completed' noise line", () => {
    const log = [
      `${ts(1)} error: real failure here`,
      `${ts(2)} Process completed with exit code 1`,
    ].join("\n");
    assert.match(excerptJobLog(log).text, /real failure here/);
  });

  test("still surfaces something when the log is noise only", () => {
    const out = excerptJobLog(`${ts(2)} Process completed with exit code 1\n`);
    assert.ok(out.text.trim().length > 0);
  });

  test("falls back to the tail when there are no error lines", () => {
    const log = Array.from({ length: 200 }, (_, i) => `${ts(0)} info: line ${i}`).join("\n");
    const out = excerptJobLog(log);
    assert.match(out.text, /line 199/);
    assert.doesNotMatch(out.text, /line 0\b/);
  });

  test("reports untruncated when the whole log fits", () => {
    const log = "error: tiny";
    const out = excerptJobLog(log);
    assert.equal(out.truncated, false);
    assert.equal(out.bytes, out.originalBytes);
    assert.ok(!out.text.startsWith("[truncated"));
  });

  test("hard-caps a megabyte log and says so", () => {
    // 20k error lines ≈ 700 KB — the shape that would blow the context window.
    const log = Array.from({ length: 20_000 }, (_, i) => `${ts(0)} error: failure ${i}`).join("\n");
    const out = excerptJobLog(log);

    assert.equal(out.truncated, true);
    assert.ok(out.bytes <= DEFAULT_LOG_EXCERPT_BYTES, `bytes ${out.bytes} over cap`);
    assert.ok(out.originalBytes > 500_000);
    assert.match(out.text, /^\[truncated — showing \d+ of \d+ bytes/);
    // Capped from the END, so the last failure — the one that stopped the job —
    // survives and the first does not.
    assert.match(out.text, /failure 19999/);
    assert.doesNotMatch(out.text, /failure 0\b/);
  });

  test("honours an explicit max_bytes", () => {
    const log = Array.from({ length: 5_000 }, (_, i) => `${ts(0)} error: failure ${i}`).join("\n");
    const out = excerptJobLog(log, 2_000);
    assert.ok(out.bytes <= 2_000, `bytes ${out.bytes} over the requested cap`);
    assert.equal(out.truncated, true);
  });

  test("clamps an absurd max_bytes at both ends", () => {
    const log = Array.from({ length: 20_000 }, (_, i) => `${ts(0)} error: failure ${i}`).join("\n");
    // The agent cannot opt out of the cap by asking for everything…
    assert.ok(excerptJobLog(log, Number.MAX_SAFE_INTEGER).bytes <= MAX_LOG_EXCERPT_BYTES);
    // …nor render the tool useless by asking for nothing.
    assert.ok(excerptJobLog(log, 1).bytes >= MIN_LOG_EXCERPT_BYTES - 200);
  });

  test("never leaves a partial multi-byte character at the cut", () => {
    const log = Array.from({ length: 5_000 }, (_, i) => `${ts(0)} error: café ${i} ✓`).join("\n");
    const out = excerptJobLog(log, 2_000);
    assert.doesNotMatch(out.text, /�/);
  });
});
