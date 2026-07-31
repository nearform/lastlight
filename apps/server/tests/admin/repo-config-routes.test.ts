import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";
import { setRuntimeConfig, resetRuntimeConfigForTests, type LastLightConfig } from "#src/config/config.js";
import type { RepoLayer } from "#src/config/repo-config.js";

/**
 * `GET /repos/:owner/:repo/config` — the per-repo config view (issue #180).
 *
 * The fetch half of `repo-config.ts` is stubbed (it owns the GitHub round-trip
 * and the TTL cache, covered in tests/config/repo-config.test.ts); everything
 * the ROUTE owns — the managed-repo gate, the redaction, the resolve, the
 * asset enumeration, and the `?refresh=1` force path — runs for real.
 */
const repoConfig = vi.hoisted(() => ({
  fetchRepoLayer: vi.fn(),
  refreshRepoLayer: vi.fn(),
  getCachedRepoLayer: vi.fn(),
}));

vi.mock("#src/config/repo-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/config/repo-config.js")>();
  return { ...actual, ...repoConfig };
});

const mockDb = {
  runs: { distinctRepos: vi.fn(() => []) },
} as unknown as StateDb;

const mockSessions = {} as unknown as SessionReader;

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    // Empty password ⇒ auth off, so these tests don't have to mint tokens.
    adminPassword: "",
    adminSecret: "test-secret",
    ...overrides,
  };
}

function runtimeConfig(overrides: Record<string, unknown> = {}): LastLightConfig {
  return {
    stateDir: "/tmp",
    managedRepos: ["acme/widget"],
    models: { default: "anthropic/claude-sonnet-4-6", triage: "anthropic/claude-haiku-4-5" },
    variants: { architect: "high" },
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    approval: { post_architect: true },
    repoConfig: {
      enabled: true,
      allowKeys: ["models", "variants", "disabled.workflows", "disabled.crons", "approval"],
      allowedModels: null,
      allowAssets: true,
    },
    publicConfig: {
      default: {},
      overlay: null,
      merged: {},
      sources: { models: { default: "default", triage: "overlay" } },
    },
    ...overrides,
  } as unknown as LastLightConfig;
}

/** A layer as `fetchRepoLayer` would return it — `root` need not exist unless assets matter. */
function layer(over: Partial<RepoLayer> = {}): RepoLayer {
  return {
    repo: "acme/widget",
    defaultBranch: "main",
    treeSha: "tree-1",
    fetchedAt: "2026-07-31T09:00:00.000Z",
    root: "/nonexistent/repo-layer",
    config: {},
    assets: [],
    warnings: [],
    ...over,
  };
}

async function get(app: ReturnType<typeof createAdminRoutes>, path: string) {
  return app.fetch(new Request(`http://localhost${path}`));
}

interface RepoConfigResponse {
  repo: string;
  merged: { models: Record<string, string>; variants: Record<string, string>; approval: Record<string, boolean> };
  sources: { models: Record<string, string>; variants: Record<string, string> };
  repoLayer?: Record<string, unknown>;
  warnings: { code: string; path: string; message: string }[];
  assets: { type: string; name: string; shadowsDefault: boolean }[];
  policy: { enabled: boolean; allowKeys: string[] };
  fetchedAt: string | null;
  treeSha: string | null;
  defaultBranch: string | null;
}

beforeEach(() => {
  repoConfig.fetchRepoLayer.mockReset().mockResolvedValue(undefined);
  repoConfig.refreshRepoLayer.mockReset().mockResolvedValue(undefined);
  repoConfig.getCachedRepoLayer.mockReset().mockReturnValue(undefined);
  setRuntimeConfig(runtimeConfig());
});

afterEach(() => resetRuntimeConfigForTests());

describe("GET /repos/:owner/:repo/config", () => {
  it("returns 200 and the inherited config for a repo with no .lastlight/", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await get(app, "/repos/acme/widget/config");
    const body = (await res.json()) as RepoConfigResponse;

    expect(res.status).toBe(200);
    expect(body.repo).toBe("acme/widget");
    expect(body.repoLayer).toBeUndefined();
    expect(body.warnings).toEqual([]);
    expect(body.assets).toEqual([]);
    expect(body.fetchedAt).toBeNull();
    expect(body.treeSha).toBeNull();
    expect(body.defaultBranch).toBeNull();
    // The whole point: no `.lastlight/` still answers "what runs for this repo".
    expect(body.merged.models.triage).toBe("anthropic/claude-haiku-4-5");
    expect(body.merged.approval).toEqual({ post_architect: true });
    // …and each leaf keeps the provenance it had at boot.
    expect(body.sources.models).toEqual({ default: "default", triage: "overlay" });
    expect(body.policy.enabled).toBe(true);
  });

  it("tags the leaves a repo overrides with the 'repo' source", async () => {
    repoConfig.fetchRepoLayer.mockResolvedValue(
      layer({ config: { models: { triage: "openai/gpt-5.5" }, variants: { architect: "max" } } }),
    );
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const body = (await (await get(app, "/repos/acme/widget/config")).json()) as RepoConfigResponse;

    expect(body.merged.models.triage).toBe("openai/gpt-5.5");
    expect(body.sources.models.triage).toBe("repo");
    expect(body.sources.variants.architect).toBe("repo");
    // Untouched leaves keep their instance provenance — the view has to make
    // "came from the repo" distinguishable from "inherited".
    expect(body.sources.models.default).toBe("default");
    expect(body.merged.models.default).toBe("anthropic/claude-sonnet-4-6");
    expect(body.repoLayer).toEqual({ models: { triage: "openai/gpt-5.5" }, variants: { architect: "max" } });
    expect(body.fetchedAt).toBe("2026-07-31T09:00:00.000Z");
    expect(body.defaultBranch).toBe("main");
  });

  it("reports out-of-bounds keys as warnings and keeps the inherited value", async () => {
    repoConfig.fetchRepoLayer.mockResolvedValue(
      layer({ config: { models: { triage: "not-a-provider-spec" }, port: 9999 } }),
    );
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const body = (await (await get(app, "/repos/acme/widget/config")).json()) as RepoConfigResponse;

    expect(body.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["unknown-provider", "key-not-allowed"]),
    );
    expect(body.merged.models.triage).toBe("anthropic/claude-haiku-4-5");
    expect(body.sources.models.triage).toBe("overlay");
    // The raw file is echoed back untouched so the repo can see what it wrote
    // next to the reason it was dropped.
    expect(body.repoLayer).toEqual({ models: { triage: "not-a-provider-spec" }, port: 9999 });
  });

  it("redacts secret-looking keys from the raw repo layer", async () => {
    repoConfig.fetchRepoLayer.mockResolvedValue(
      layer({
        config: {
          models: { triage: "openai/gpt-5.5" },
          apiKey: "sk-live-should-not-round-trip",
          nested: { webhookSecret: "shhh", harmless: "ok" },
        },
      }),
    );
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const body = (await (await get(app, "/repos/acme/widget/config")).json()) as RepoConfigResponse;

    expect(body.repoLayer).toEqual({
      models: { triage: "openai/gpt-5.5" },
      apiKey: "[redacted]",
      nested: { webhookSecret: "[redacted]", harmless: "ok" },
    });
    expect(JSON.stringify(body)).not.toContain("sk-live-should-not-round-trip");
    expect(JSON.stringify(body)).not.toContain("shhh");
  });

  it("rejects a repo that is not managed, without touching GitHub", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await get(app, "/repos/evil/repo/config");

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({
      error: "evil/repo is not a managed repository",
    });
    expect(repoConfig.fetchRepoLayer).not.toHaveBeenCalled();
    expect(repoConfig.refreshRepoLayer).not.toHaveBeenCalled();
  });

  it("?refresh=1 goes through refreshRepoLayer, bypassing the TTL cache", async () => {
    repoConfig.fetchRepoLayer.mockResolvedValue(layer({ config: { models: { triage: "openai/stale" } } }));
    repoConfig.refreshRepoLayer.mockResolvedValue(
      layer({ treeSha: "tree-2", config: { models: { triage: "openai/fresh" } } }),
    );
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());

    const cached = (await (await get(app, "/repos/acme/widget/config")).json()) as RepoConfigResponse;
    expect(cached.merged.models.triage).toBe("openai/stale");
    expect(repoConfig.refreshRepoLayer).not.toHaveBeenCalled();

    const fresh = (await (await get(app, "/repos/acme/widget/config?refresh=1")).json()) as RepoConfigResponse;
    expect(fresh.merged.models.triage).toBe("openai/fresh");
    expect(fresh.treeSha).toBe("tree-2");
    expect(repoConfig.refreshRepoLayer).toHaveBeenCalledWith("acme/widget", expect.anything());
    expect(repoConfig.fetchRepoLayer).toHaveBeenCalledTimes(1);
  });

  it("lists the layer's assets, flagging the ones that shadow an instance asset", async () => {
    const root = mkdtempSync(join(tmpdir(), "lastlight-admin-repo-layer-"));
    const coreRoot = mkdtempSync(join(tmpdir(), "lastlight-admin-core-"));
    const overlayDir = mkdtempSync(join(tmpdir(), "lastlight-admin-overlay-"));
    const write = (base: string, rel: string, body: string) => {
      mkdirSync(dirname(join(base, rel)), { recursive: true });
      writeFileSync(join(base, rel), body);
    };
    write(root, "workflows/prompts/triage.md", "# repo triage");
    write(root, "workflows/prompts/bespoke.md", "# repo only");
    write(root, "agent-context/house-rules.md", "# rules");
    write(coreRoot, "workflows/prompts/triage.md", "# built-in triage");
    // A repo asset can shadow an OVERLAY fork too, not just a built-in.
    write(overlayDir, "agent-context/house-rules.md", "# overlay rules");

    try {
      repoConfig.fetchRepoLayer.mockResolvedValue(layer({ root }));
      const app = createAdminRoutes(
        mockDb,
        mockSessions,
        mockSessions,
        makeConfig({ builtInRoot: coreRoot, overlayDir }),
      );
      const body = (await (await get(app, "/repos/acme/widget/config")).json()) as RepoConfigResponse;

      expect(body.assets).toEqual([
        { type: "prompt", name: "bespoke.md", shadowsDefault: false },
        { type: "prompt", name: "triage.md", shadowsDefault: true },
        { type: "agent-context", name: "house-rules.md", shadowsDefault: true },
      ]);
    } finally {
      for (const dir of [root, coreRoot, overlayDir]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects every repo when no config is loaded (empty managed list)", async () => {
    resetRuntimeConfigForTests();
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await get(app, "/repos/acme/widget/config");
    expect(res.status).toBe(404);
    expect(repoConfig.fetchRepoLayer).not.toHaveBeenCalled();
  });
});

describe("repo-config flags on the list endpoints", () => {
  it("GET /managed-repos reports hasRepoConfig + fetchedAt per effective repo", async () => {
    setRuntimeConfig(runtimeConfig({ managedRepos: ["acme/widget", "acme/other"] }));
    repoConfig.getCachedRepoLayer.mockImplementation((repo: string) =>
      repo === "acme/widget" ? layer() : undefined,
    );
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const body = (await (await get(app, "/managed-repos")).json()) as {
      repoConfig: { repo: string; hasRepoConfig: boolean; fetchedAt: string | null }[];
    };

    expect(body.repoConfig).toEqual([
      { repo: "acme/widget", hasRepoConfig: true, fetchedAt: "2026-07-31T09:00:00.000Z" },
      { repo: "acme/other", hasRepoConfig: false, fetchedAt: null },
    ]);
  });

  it("GET /repos marks the repos with a cached .lastlight/ layer", async () => {
    repoConfig.getCachedRepoLayer.mockImplementation((repo: string) =>
      repo === "acme/widget" ? layer() : undefined,
    );
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const body = (await (await get(app, "/repos")).json()) as {
      repos: { repo: string; hasRepoConfig: boolean }[];
    };

    expect(body.repos).toEqual([
      expect.objectContaining({ repo: "acme/widget", hasRepoConfig: true }),
    ]);
  });
});
