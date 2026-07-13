import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import * as cliServer from "#src/cli/cli-server.js";
import * as clack from "@clack/prompts";

const {
  startArgv,
  stopArgv,
  restartArgv,
  buildArgv,
  buildSandboxArgv,
  buildQaArgv,
  upArgv,
  restartSidecarsArgv,
  parseLsRemoteSha,
  resolveImageTag,
  IMAGE_REGISTRY,
  PUBLISHED_IMAGES,
  SIDECARS,
  resolveHomeAndLayout,
  syncComposeAssets,
  thinHostDrift,
  ensureLocalBuildAllowed,
} = cliServer;

type WorkingDirLayout = cliServer.WorkingDirLayout;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cli-server argv builders", () => {
  it("start: whole stack vs one service", () => {
    expect(startArgv()).toEqual(["up", "-d"]);
    expect(startArgv("caddy")).toEqual(["up", "-d", "caddy"]);
  });

  it("stop: down for the stack, stop for a service", () => {
    expect(stopArgv()).toEqual(["down"]);
    expect(stopArgv("agent")).toEqual(["stop", "agent"]);
  });

  it("restart: defaults to agent", () => {
    expect(restartArgv()).toEqual(["restart", "agent"]);
    expect(restartArgv("caddy")).toEqual(["restart", "caddy"]);
  });

  it("build wave 1: agent + shared sandbox-base, stamps GIT_SHA when present", () => {
    // sandbox-base is built here (wave 1); the leaf sandbox images that are
    // FROM it build in later waves, so a single parallel `compose build` can't
    // race the base.
    expect(buildArgv("abc123")).toEqual([
      "build", "agent", "sandbox-base", "--build-arg", "GIT_SHA=abc123",
    ]);
    expect(buildArgv("")).toEqual(["build", "agent", "sandbox-base"]);
  });

  it("build wave 2: lean sandbox (FROM the shared base)", () => {
    expect(buildSandboxArgv()).toEqual(["build", "sandbox"]);
  });

  it("build wave 3: browser-QA sandbox (FROM the shared base, non-fatal)", () => {
    expect(buildQaArgv()).toEqual(["build", "sandbox-qa"]);
  });

  it("up: recreates with --remove-orphans (matches deploy.sh)", () => {
    expect(upArgv()).toEqual(["up", "-d", "--remove-orphans"]);
  });

  it("restart sidecars: all egress + collector services", () => {
    expect(restartSidecarsArgv()).toEqual(["restart", ...SIDECARS]);
    expect(SIDECARS).toContain("coredns-strict");
    expect(SIDECARS).toContain("otel-collector");
  });
});

describe("resolveImageTag", () => {
  const prevEnv = process.env.LASTLIGHT_CORE_VERSION;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.LASTLIGHT_CORE_VERSION;
    else process.env.LASTLIGHT_CORE_VERSION = prevEnv;
  });

  it("falls back to `latest` when the overlay declares no pin", () => {
    delete process.env.LASTLIGHT_CORE_VERSION;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ll-noinstance-"));
    // No config.yaml → unpinned → latest.
    expect(resolveImageTag(dir)).toBe("latest");
  });

  it("uses the overlay's deploy.version pin as the image tag", () => {
    delete process.env.LASTLIGHT_CORE_VERSION;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ll-pin-"));
    fs.writeFileSync(path.join(dir, "config.yaml"), "deploy:\n  version: v0.11.0\n");
    expect(resolveImageTag(dir)).toBe("v0.11.0");
  });

  it("LASTLIGHT_CORE_VERSION overrides the file", () => {
    process.env.LASTLIGHT_CORE_VERSION = "v9.9.9";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ll-envpin-"));
    fs.writeFileSync(path.join(dir, "config.yaml"), "deploy:\n  version: v0.11.0\n");
    expect(resolveImageTag(dir)).toBe("v9.9.9");
  });
});

describe("PUBLISHED_IMAGES", () => {
  it("re-tags each GHCR repo to the LOCAL name compose + the harness expect", () => {
    const byRepo = Object.fromEntries(PUBLISHED_IMAGES.map((i) => [i.repo, i.localTag]));
    // The harness spawns sandboxes by these fixed names (src/sandbox/images.ts);
    // compose references `lastlight-agent`. A pull must land under exactly these.
    expect(byRepo["lastlight-agent"]).toBe("lastlight-agent");
    expect(byRepo["lastlight-sandbox"]).toBe("lastlight-sandbox:latest");
    expect(byRepo["lastlight-sandbox-qa"]).toBe("lastlight-sandbox-qa:latest");
    // Only sandbox-qa is optional (browser tier).
    expect(PUBLISHED_IMAGES.find((i) => i.repo === "lastlight-sandbox-qa")?.optional).toBe(true);
    expect(PUBLISHED_IMAGES.find((i) => i.repo === "lastlight-agent")?.optional).toBeUndefined();
    expect(IMAGE_REGISTRY).toBe("ghcr.io/nearform");
  });
});

describe("resolveHomeAndLayout", () => {
  const makeDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ll-layout-"));
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.splice(0, cleanup.length);
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const setupPackage = (dir: string, name = "lastlight") => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }), "utf8");
  };

  it("classifies checkout layout when .git is present", () => {
    const dir = makeDir();
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, ".git"));
    setupPackage(dir);
    const result = resolveHomeAndLayout({ home: dir });
    expect(result.home).toBe(path.resolve(dir));
    expect(result.layout).toBe("checkout");
  });

  it("classifies thin layout when compose artefacts exist without git", () => {
    const dir = makeDir();
    cleanup.push(dir);
    setupPackage(dir);
    fs.mkdirSync(path.join(dir, "instance"));
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), "services: {}\n");
    const result = resolveHomeAndLayout({ home: dir });
    expect(result.layout).toBe("thin");
  });

  it("exits when the package name does not match", () => {
    const dir = makeDir();
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, ".git"));
    setupPackage(dir, "not-lastlight");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as any);
    const errorSpy = vi.spyOn(clack.log, "error");
    expect(() => resolveHomeAndLayout({ home: dir })).toThrowError(/exit 1/);
    expect(errorSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe("syncComposeAssets", () => {
  const makeDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ll-sync-"));
  const cleanup: string[] = [];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    cleanup.splice(0, cleanup.length);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const dir of cleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetches compose assets for the resolved ref", async () => {
    const dir = makeDir();
    cleanup.push(dir);
    const composeBody = "version: '3'\nservices: {}\n";
    const caddyBody = ":80 {\n  reverse_proxy localhost:8644\n}\n";
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(composeBody, { status: 200 }))
      .mockResolvedValueOnce(new Response(caddyBody, { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await syncComposeAssets({ home: dir, ref: "v0.12.0" });

    expect(fetchSpy).toHaveBeenNthCalledWith(1,
      "https://raw.githubusercontent.com/nearform/lastlight/v0.12.0/docker-compose.yml",
      expect.any(Object),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(2,
      "https://raw.githubusercontent.com/nearform/lastlight/v0.12.0/Caddyfile",
      expect.any(Object),
    );
    expect(fs.readFileSync(path.join(dir, "docker-compose.yml"), "utf8")).toBe(composeBody);
    expect(fs.readFileSync(path.join(dir, "Caddyfile"), "utf8")).toBe(caddyBody);
  });

  it("maps latest to main when fetching", async () => {
    const dir = makeDir();
    cleanup.push(dir);
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response("compose", { status: 200 }))
      .mockResolvedValueOnce(new Response("caddy", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await syncComposeAssets({ home: dir, ref: "latest" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/nearform/lastlight/main/docker-compose.yml",
      expect.any(Object),
    );
  });

  it("throws when a fetch fails", async () => {
    const dir = makeDir();
    cleanup.push(dir);
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(syncComposeAssets({ home: dir, ref: "v0.12.0" })).rejects.toThrow();
  });
});

describe("thinHostDrift", () => {
  const overlayDrift = { current: "abc", latest: "abc", behind: false };

  it("derives drift from docker inspect + ls-remote", async () => {
    const inspect = vi.fn().mockResolvedValue({
      Config: { Labels: { "org.opencontainers.image.revision": "deadbeef" } },
    });
    const lsRemote = vi.fn().mockResolvedValue("feedface\tHEAD");
    const result = await thinHostDrift("/tmp/home", "/tmp/instance", {
      inspectImage: inspect,
      lsRemote,
      overlay: async () => ({ overlay: overlayDrift, pin: null }),
    });
    expect(inspect).toHaveBeenCalled();
    expect(lsRemote).toHaveBeenCalledWith("https://github.com/nearform/lastlight.git", "HEAD");
    expect(result.core.current).toBe("deadbeef");
    expect(result.core.latest).toBe("feedface");
    expect(result.core.behind).toBe(true);
    expect(result.overlay).toEqual(overlayDrift);
  });

  it("returns unknown when the agent image is absent", async () => {
    const lsRemote = vi.fn().mockResolvedValue("feedface\tHEAD");
    const result = await thinHostDrift("/tmp/home", "/tmp/instance", {
      inspectImage: vi.fn().mockResolvedValue(null),
      lsRemote,
      overlay: async () => ({ overlay: overlayDrift, pin: null }),
    });
    expect(result.core.current).toBeNull();
    expect(result.core.behind).toBe(false);
  });
});

describe("ensureLocalBuildAllowed", () => {
  it("allows checkout layouts", () => {
    expect(() => ensureLocalBuildAllowed("checkout", "server build")).not.toThrow();
  });

  it("rejects thin-host local builds", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as any);
    const errorSpy = vi.spyOn(clack.log, "error");
    expect(() => ensureLocalBuildAllowed("thin", "server build")).toThrow(/exit 1/);
    expect(errorSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe("parseLsRemoteSha", () => {
  it("extracts the leading SHA", () => {
    expect(parseLsRemoteSha("9c2eabcde1234567890\tHEAD")).toBe("9c2eabcde1234567890");
  });
  it("returns null for junk / empty", () => {
    expect(parseLsRemoteSha("")).toBeNull();
    expect(parseLsRemoteSha("not-a-sha\tHEAD")).toBeNull();
  });
});
