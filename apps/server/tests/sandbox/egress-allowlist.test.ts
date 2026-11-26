import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it, expect } from "vitest";
import { installProviderOverrides, resetProviderRegistry } from "#src/config/provider-registry.js";
import {
  ALLOW_ALL_SENTINEL,
  defaultAllowlist,
  dockerSandboxAllowlist,
  gatewayHostsStillAllowed,
  gondolinHostPatterns,
  GITHUB_HOSTS,
  PACKAGE_REGISTRY_HOSTS,
  providerHosts,
  mergeAllowlist,
  normalizeAllowlistHost,
} from "#src/sandbox/egress-allowlist.js";

describe("egress-allowlist source of truth", () => {
  it("groups are non-empty and disjoint", () => {
    for (const group of [GITHUB_HOSTS, providerHosts(), PACKAGE_REGISTRY_HOSTS]) {
      expect(group.length).toBeGreaterThan(0);
    }
    const all = [...GITHUB_HOSTS, ...providerHosts(), ...PACKAGE_REGISTRY_HOSTS];
    expect(new Set(all).size).toBe(all.length);
  });

  it("defaultAllowlist() is the union of the three groups in declaration order", () => {
    const expected = [...GITHUB_HOSTS, ...providerHosts(), ...PACKAGE_REGISTRY_HOSTS];
    expect([...defaultAllowlist()]).toEqual(expected);
  });

  it("covers the critical host categories the runtime depends on", () => {
    // GitHub apex covers api.github.com, codeload.github.com, raw.…
    expect(GITHUB_HOSTS).toContain("github.com");
    // Provider hosts — the docker backend dials these from inside the
    // sandbox container.
    expect(providerHosts()).toContain("openai.com");
    expect(providerHosts()).toContain("anthropic.com");
    // npm — covers registry.npmjs.org, auth.npmjs.org, www.npmjs.org.
    expect(PACKAGE_REGISTRY_HOSTS).toContain("npmjs.org");
  });

  it("entries are bare hostnames (no leading dot, no wildcard prefix)", () => {
    // Convention is "every entry matches apex+subdomains" — see file
    // docstring. The config generator emits the right syntax for each
    // backend. If someone tries to write `.github.com` or `*.github.com`
    // here, fail fast.
    for (const host of defaultAllowlist()) {
      expect(host).toMatch(/^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/);
      expect(host.startsWith(".")).toBe(false);
      expect(host.includes("*")).toBe(false);
    }
  });

  it("ALLOW_ALL_SENTINEL is the wildcard string the gondolin matcher honours", () => {
    expect(ALLOW_ALL_SENTINEL).toBe("*");
  });

  it("normalizes and merges extra allowlist hosts", () => {
    expect(normalizeAllowlistHost("https://Collector.Example.com:4318/v1/traces")).toBe("collector.example.com");
    expect(normalizeAllowlistHost("169.254.169.254")).toBeNull();
    expect(mergeAllowlist(["github.com"], ["GitHub.com", "otel.example.com"])).toEqual([
      "github.com",
      "otel.example.com",
    ]);
  });

  it("rejects private and internal collector endpoints", () => {
    for (const host of [
      "0.0.0.0",
      "127.0.0.1",
      "10.0.0.4",
      "172.16.0.1",
      "192.168.1.10",
      "http://[::1]:4318",
      "http://[fe80::1]:4318",
      "http://[fd00::1]:4318",
      "http://[::ffff:127.0.0.1]:4318",
      "metadata.google.internal",
      "localhost",
    ]) {
      expect(normalizeAllowlistHost(host), host).toBeNull();
    }
  });
});

describe("dockerSandboxAllowlist (model gateway)", () => {
  afterEach(() => resetProviderRegistry());

  it("drops a host only gateway providers use", () => {
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1", sandboxGateway: true } });
    expect(dockerSandboxAllowlist()).not.toContain("gw.example");
    expect(defaultAllowlist()).toContain("gw.example");
  });

  it("keeps a host another provider still calls directly", () => {
    installProviderOverrides({
      acme: { baseUrl: "https://gw.example/v1", sandboxGateway: true },
      other: { baseUrl: "https://gw.example/other/v1" },
    });
    expect(dockerSandboxAllowlist()).toContain("gw.example");
  });

  it("reports a gateway-only host that a direct provider's apex still covers", () => {
    installProviderOverrides({
      acme: { baseUrl: "https://api.gw.example/v1", sandboxGateway: true },
      other: { baseUrl: "https://gw.example/v1" },
    });
    expect(dockerSandboxAllowlist()).not.toContain("api.gw.example");
    expect(gatewayHostsStillAllowed()).toEqual([{ host: "api.gw.example", coveredBy: "gw.example" }]);
  });

  it("reports nothing when the gateway-only host is really dropped", () => {
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1", sandboxGateway: true } });
    expect(gatewayHostsStillAllowed()).toEqual([]);
  });

  it("equals defaultAllowlist when no provider uses the gateway", () => {
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1" } });
    expect(dockerSandboxAllowlist()).toEqual(defaultAllowlist());
  });
});

// gondolin's own hostname matcher. It is not exported from the package root,
// so load it from agentic-pi's copy of the package: the test then checks the
// patterns against the code that enforces them, at the version agentic-pi pins.
const agenticPiRequire = createRequire(new URL("../../../../packages/agentic-pi/package.json", import.meta.url));
const gondolinDir = dirname(agenticPiRequire.resolve("@earendil-works/gondolin/package.json"));
const { matchesAnyHost } = (await import(
  pathToFileURL(join(gondolinDir, "dist/src/host/patterns.js")).href
)) as { matchesAnyHost: (hostname: string, patterns: string[]) => boolean };

describe("gondolinHostPatterns (apex + subdomains on gondolin, issue #503)", () => {
  it("pairs each bare host with a *. pattern", () => {
    expect(gondolinHostPatterns(["crates.io", "npmjs.org"])).toEqual([
      "crates.io", "*.crates.io", "npmjs.org", "*.npmjs.org",
    ]);
  });

  it("leaves IP literals exact: a *. prefix on an address is meaningless", () => {
    expect(gondolinHostPatterns(["203.0.113.7", "[2001:db8::1]"])).toEqual(["203.0.113.7", "[2001:db8::1]"]);
  });

  it("admits registry subdomains through gondolin's matcher", () => {
    const patterns = gondolinHostPatterns(defaultAllowlist());
    for (const host of [
      "index.crates.io", "static.crates.io", "registry.npmjs.org",
      "files.pythonhosted.org", "proxy.golang.org", "api.github.com",
      "a.b.npmjs.org",
    ]) {
      expect(matchesAnyHost(host, patterns), host).toBe(true);
    }
  });

  it("keeps the apex hosts allowed", () => {
    const patterns = gondolinHostPatterns(defaultAllowlist());
    for (const host of ["crates.io", "npmjs.org", "github.com"]) {
      expect(matchesAnyHost(host, patterns), host).toBe(true);
    }
  });

  it("keeps off-list hosts and lookalikes blocked", () => {
    const patterns = gondolinHostPatterns(defaultAllowlist());
    for (const host of ["example.com", "evilcrates.io", "crates.io.evil.com", "x.crates.io.evil.com"]) {
      expect(matchesAnyHost(host, patterns), host).toBe(false);
    }
  });

  it("documents the bug: bare hosts alone match only the apex", () => {
    expect(matchesAnyHost("index.crates.io", ["crates.io"])).toBe(false);
  });
});
