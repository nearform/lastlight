import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

describe("agentic-pi dependency metadata", () => {
  it("pins all workspaces to the 0.2.4 range and lockfile resolution", () => {
    const rootPackage = readJson<{ dependencies: Record<string, string> }>("package.json");
    const dashboardPackage = readJson<{ dependencies: Record<string, string> }>("dashboard/package.json");
    const lockfile = readJson<{
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    }>("package-lock.json");

    expect(rootPackage.dependencies["agentic-pi"]).toBe("^0.2.4");
    expect(dashboardPackage.dependencies["agentic-pi"]).toBe("^0.2.4");
    expect(lockfile.packages[""].dependencies?.["agentic-pi"]).toBe("^0.2.4");
    expect(lockfile.packages["dashboard"].dependencies?.["agentic-pi"]).toBe("^0.2.4");
    expect(lockfile.packages["node_modules/agentic-pi"].version).toBe("0.2.4");
    expect(lockfile.packages["node_modules/agentic-pi"].dependencies?.["@ff-labs/pi-fff"]).toBeDefined();
    expect(lockfile.packages["node_modules/@ff-labs/pi-fff"].version).toBeTruthy();
  });
});
