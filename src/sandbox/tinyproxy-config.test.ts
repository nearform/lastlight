import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  renderOpenConf,
  renderOpenFilterList,
  renderStrictConf,
  renderStrictFilterList,
  TINYPROXY_PORT,
  TINYPROXY_PRIVATE_DESTINATION_PATTERNS,
} from "./tinyproxy-config.js";
import { DEFAULT_ALLOWLIST } from "./egress-allowlist.js";

describe("tinyproxy strict config", () => {
  const conf = renderStrictConf();

  it("listens on the published port", () => {
    expect(conf).toMatch(new RegExp(`^Port ${TINYPROXY_PORT}$`, "m"));
  });

  it("does not use client-side Deny CIDRs to gate destinations", () => {
    // Previous implementation tried to block private destinations with
    // `Deny <CIDR>` directives. Those are client-side ACLs (who may
    // CONNECT to the proxy), not destination filters. Make sure we don't
    // regress to that misleading pattern.
    expect(conf).not.toMatch(/^Deny\s+10\./m);
    expect(conf).not.toMatch(/^Deny\s+127\./m);
    expect(conf).not.toMatch(/^Deny\s+192\.168/m);
    expect(conf).not.toMatch(/^Deny\s+169\.254/m);
    expect(conf).not.toMatch(/^Deny\s+172\.16/m);
  });

  it("locks CONNECT to port 443 so the agent can't tunnel other services", () => {
    expect(conf).toMatch(/^ConnectPort 443$/m);
  });

  it("enables the destination filter in allowlist mode", () => {
    expect(conf).toMatch(/^FilterDefaultDeny\s+Yes$/m);
    expect(conf).toMatch(/^Filter\s+".*filter-strict\.txt"$/m);
  });
});

describe("tinyproxy open config — private-IP toggle on", () => {
  const conf = renderOpenConf({ blockPrivateIps: true });

  it("does not use client-side Deny CIDRs (the previous bug)", () => {
    expect(conf).not.toMatch(/^Deny\s+10\./m);
    expect(conf).not.toMatch(/^Deny\s+127\./m);
    expect(conf).not.toMatch(/^Deny\s+192\.168/m);
    expect(conf).not.toMatch(/^Deny\s+169\.254/m);
    expect(conf).not.toMatch(/^Deny\s+172\.16/m);
  });

  it("enables destination denylist via FilterDefaultDeny=No", () => {
    expect(conf).toMatch(/^FilterDefaultDeny\s+No$/m);
    expect(conf).toMatch(/^Filter\s+".*filter-open\.txt"$/m);
  });

  it("still locks CONNECT to port 443", () => {
    expect(conf).toMatch(/^ConnectPort 443$/m);
  });
});

describe("tinyproxy open config — private-IP toggle off", () => {
  const conf = renderOpenConf({ blockPrivateIps: false });

  it("omits the Filter directive entirely (no denylist)", () => {
    expect(conf).not.toMatch(/^Filter\s+"/m);
    expect(conf).not.toMatch(/^FilterDefaultDeny\s+/m);
  });

  it("documents the disabled state in a comment", () => {
    expect(conf).toContain("Private-IP blocking disabled");
  });

  it("still locks CONNECT to port 443 (independent of the toggle)", () => {
    expect(conf).toMatch(/^ConnectPort 443$/m);
  });
});

describe("strict-mode filter list (allowlist)", () => {
  const text = renderStrictFilterList();

  it("emits one regex per allowlisted host", () => {
    for (const host of DEFAULT_ALLOWLIST) {
      const escaped = host.replaceAll(".", "\\.");
      expect(text).toContain(`(^|\\.)${escaped}$`);
    }
  });

  it("anchors each pattern at end-of-host to block suffix-confusion attacks", () => {
    // A bare 'api.github.com' must NOT match 'api.github.com.evil.example.com'.
    // The anchored regex form `$` enforces this.
    const lines = text
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    for (const line of lines) {
      expect(line.endsWith("$")).toBe(true);
    }
  });
});

describe("open-mode filter list (denylist)", () => {
  const text = renderOpenFilterList();

  function patternMatches(host: string): boolean {
    return TINYPROXY_PRIVATE_DESTINATION_PATTERNS.some((p) =>
      new RegExp(p, "i").test(host),
    );
  }

  it("rejects RFC1918 IPv4 literals", () => {
    for (const ip of ["10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
      expect(patternMatches(ip)).toBe(true);
    }
  });

  it("rejects loopback IPv4 literals", () => {
    expect(patternMatches("127.0.0.1")).toBe(true);
    expect(patternMatches("127.42.0.1")).toBe(true);
  });

  it("rejects link-local and cloud metadata literals", () => {
    expect(patternMatches("169.254.169.254")).toBe(true); // AWS / GCP / Azure
    expect(patternMatches("169.254.1.1")).toBe(true);
    expect(patternMatches("metadata.google.internal")).toBe(true);
    expect(patternMatches("metadata")).toBe(true);
  });

  it("rejects IPv6 loopback and link-local in CONNECT bracket form", () => {
    expect(patternMatches("::1")).toBe(true);
    expect(patternMatches("[::1]")).toBe(true);
    expect(patternMatches("fe80::1")).toBe(true);
    expect(patternMatches("[fe80::1]")).toBe(true);
  });

  it("does NOT reject public IP literals or normal hostnames", () => {
    for (const host of [
      "8.8.8.8",
      "1.1.1.1",
      "172.15.0.1",        // just outside 172.16/12
      "172.32.0.1",        // just past 172.31
      "169.253.0.1",       // just outside link-local
      "11.0.0.1",          // just outside 10/8
      "api.github.com",
      "example.com",
      "metadata.example.com",   // not the GCP literal
    ]) {
      expect(patternMatches(host)).toBe(false);
    }
  });

  it("file text contains every pattern (one per non-comment line)", () => {
    const lines = text
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    expect(lines).toEqual([...TINYPROXY_PRIVATE_DESTINATION_PATTERNS]);
  });
});

describe("LASTLIGHT_BLOCK_PRIVATE_IPS env toggle (default applied at render time)", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.LASTLIGHT_BLOCK_PRIVATE_IPS;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LASTLIGHT_BLOCK_PRIVATE_IPS;
    else process.env.LASTLIGHT_BLOCK_PRIVATE_IPS = original;
  });

  it("treats unset as enabled (open.conf gets the denylist Filter)", () => {
    delete process.env.LASTLIGHT_BLOCK_PRIVATE_IPS;
    expect(renderOpenConf()).toMatch(/^Filter\s+".*filter-open\.txt"$/m);
  });

  it("treats 0/false/no as disabled (no Filter directive)", () => {
    for (const value of ["0", "false", "no", "FALSE"]) {
      process.env.LASTLIGHT_BLOCK_PRIVATE_IPS = value;
      const out = renderOpenConf();
      expect(out).not.toMatch(/^Filter\s+"/m);
      expect(out).toContain("Private-IP blocking disabled");
    }
  });

  it("treats other values as enabled", () => {
    process.env.LASTLIGHT_BLOCK_PRIVATE_IPS = "1";
    expect(renderOpenConf()).toMatch(/^Filter\s+".*filter-open\.txt"$/m);
  });
});
