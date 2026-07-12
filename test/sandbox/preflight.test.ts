import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { preflightGondolin } from "../../src/sandbox/preflight.js";

describe("preflightGondolin", () => {
  test("returns a structured ok|error result", () => {
    const r = preflightGondolin();
    assert.ok(r.ok === true || r.ok === false);
    if (r.ok) {
      assert.equal(typeof r.detail, "string");
      assert.match(r.detail, /qemu=/);
      assert.match(r.detail, /accel=/);
    } else {
      assert.ok(
        [
          "qemu-not-installed",
          "qemu-img-not-installed",
          "linux-no-kvm",
          "in-container-no-accel",
        ].includes(r.reason),
      );
      assert.equal(typeof r.hint, "string");
      assert.ok(r.hint.length > 0);
    }
  });
});
