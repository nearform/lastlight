import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Drift guard for the committed sandbox agentic-pi pin.
 *
 * The sandbox images install agentic-pi from `sandbox/agentic-pi.pin` (two
 * lines: version, sha512 integrity) rather than COPYing the whole
 * package-lock.json — the lockfile's hash changes on every release and busted
 * the sandbox's agentic-pi layer (and, downstream, sandbox-qa's Chromium) on
 * every version bump. This test asserts the committed pin still matches the
 * lockfile, so a forgotten `scripts/agentic-pi-pin.sh` regeneration fails CI
 * instead of silently installing a stale agentic-pi into the sandbox.
 */
describe("sandbox/agentic-pi.pin", () => {
  it("matches the agentic-pi version + integrity in package-lock.json", () => {
    const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf-8"));
    const pkg = lock.packages?.["node_modules/agentic-pi"];
    expect(pkg, "agentic-pi missing from lockfile").toBeTruthy();

    const expected = `${pkg.version}\n${pkg.integrity}\n`;
    const actual = readFileSync(resolve("sandbox/agentic-pi.pin"), "utf-8");

    expect(
      actual,
      "sandbox/agentic-pi.pin is out of date — run scripts/agentic-pi-pin.sh",
    ).toBe(expected);
  });
});
