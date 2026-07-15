import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
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
/** Walk upward from `start` to the directory holding the workspace lockfile. */
function findWorkspaceRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, "pnpm-lock.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-lock.yaml not found above ${start}`);
    dir = parent;
  }
  return dir;
}

describe("sandbox/agentic-pi.pin", () => {
  it("matches the agentic-pi version + integrity in pnpm-lock.yaml", () => {
    // The single pnpm-lock.yaml lives at the MONOREPO root; this package's
    // importer key is its path relative to that root (e.g. "apps/server").
    const packageRoot = resolve(".");
    const workspaceRoot = findWorkspaceRoot(packageRoot);
    const importer = relative(workspaceRoot, packageRoot) || ".";
    const lock = parse(readFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "utf-8"));
    const dep = lock.importers?.[importer]?.dependencies?.["agentic-pi"];
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
