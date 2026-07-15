import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

/**
 * Drift guard for the committed sandbox agentic-pi pin.
 *
 * The sandbox images install agentic-pi from `sandbox/agentic-pi.pin` (two
 * lines: version, sha512 integrity) rather than COPYing the whole
 * pnpm-lock.yaml — the lockfile's hash changes on every release and busted
 * the sandbox's agentic-pi layer (and, downstream, sandbox-qa's Chromium) on
 * every version bump. This test asserts the committed pin still matches the
 * lockfile, so a forgotten `scripts/agentic-pi-pin.sh` regeneration fails CI
 * instead of silently installing a stale agentic-pi into the sandbox.
 */
describe("sandbox/agentic-pi.pin", () => {
  it("matches the agentic-pi version + integrity in pnpm-lock.yaml", () => {
    const lock = parse(readFileSync(resolve("pnpm-lock.yaml"), "utf-8"));
    const dep = lock.importers?.["."]?.dependencies?.["agentic-pi"];
    expect(dep, "agentic-pi missing from lockfile").toBeTruthy();

    // The importer's resolved version may carry a peer-dependency suffix,
    // e.g. "0.2.16(ws@8.21.0)(zod@4.4.3)" — the bare version precedes it.
    const version = (dep.version as string).replace(/\(.*$/, "");
    const pkg = lock.packages?.[`agentic-pi@${version}`];
    expect(
      pkg?.resolution?.integrity,
      `agentic-pi@${version} resolution missing from lockfile`,
    ).toBeTruthy();

    const expected = `${version}\n${pkg.resolution.integrity}\n`;
    const actual = readFileSync(resolve("sandbox/agentic-pi.pin"), "utf-8");

    expect(
      actual,
      "sandbox/agentic-pi.pin is out of date — run scripts/agentic-pi-pin.sh",
    ).toBe(expected);
  });
});
