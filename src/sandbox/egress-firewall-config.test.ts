import { describe, it, expect } from "vitest";
import {
  COREDNS_OPEN_IP,
  COREDNS_STRICT_IP,
  NGINX_OPEN_IP,
  NGINX_STRICT_IP,
  renderCorefileOpen,
  renderCorefileStrict,
  renderNginxOpenConf,
  renderNginxStrictConf,
  SANDBOX_EGRESS_SUBNET,
} from "./egress-firewall-config.js";
import { DEFAULT_ALLOWLIST, isWildcardHost } from "./egress-allowlist.js";

describe("static IP constants", () => {
  it("all four service IPs sit inside the sandbox-egress subnet", () => {
    // Cheap CIDR check: subnet is 172.30.0.0/24, so every IP must start
    // with 172.30.0.
    const prefix = SANDBOX_EGRESS_SUBNET.split("/")[0].split(".").slice(0, 3).join(".");
    for (const ip of [COREDNS_STRICT_IP, COREDNS_OPEN_IP, NGINX_STRICT_IP, NGINX_OPEN_IP]) {
      expect(ip.startsWith(prefix + ".")).toBe(true);
    }
  });

  it("strict and open IPs are distinct in both pairs", () => {
    expect(COREDNS_STRICT_IP).not.toBe(COREDNS_OPEN_IP);
    expect(NGINX_STRICT_IP).not.toBe(NGINX_OPEN_IP);
  });
});

describe("nginx strict config", () => {
  const conf = renderNginxStrictConf();

  it("listens on 443 with ssl_preread enabled", () => {
    expect(conf).toMatch(/listen\s+443;/);
    expect(conf).toMatch(/ssl_preread\s+on;/);
  });

  it("defaults unknown SNIs to a black-hole upstream (instant reset)", () => {
    // Anything not in the map is sunk to 127.0.0.1:1 — a port nothing is
    // listening on. The connection resets immediately; no bytes leave.
    expect(conf).toMatch(/default\s+127\.0\.0\.1:1;/);
  });

  it("emits a map entry per allowlist host", () => {
    for (const entry of DEFAULT_ALLOWLIST) {
      if (isWildcardHost(entry)) {
        // Wildcard: leading-dot form, upstream uses the live SNI.
        expect(conf).toContain(`${entry} $ssl_preread_server_name:443;`);
      } else {
        // Exact: pin the upstream hostname (defence in depth).
        expect(conf).toContain(`${entry} ${entry}:443;`);
      }
    }
  });

  it("has at least one wildcard entry (else the test is vacuous)", () => {
    expect(DEFAULT_ALLOWLIST.some(isWildcardHost)).toBe(true);
  });

  it("uses docker's embedded DNS as the upstream resolver", () => {
    expect(conf).toMatch(/resolver\s+127\.0\.0\.11/);
  });
});

describe("nginx open config", () => {
  const conf = renderNginxOpenConf();

  it("tunnels whatever SNI was sent — no allowlist map", () => {
    expect(conf).toMatch(/proxy_pass\s+\$ssl_preread_server_name:443;/);
    expect(conf).not.toMatch(/map\s+\$ssl_preread_server_name/);
  });

  it("still listens on 443 with ssl_preread enabled", () => {
    expect(conf).toMatch(/listen\s+443;/);
    expect(conf).toMatch(/ssl_preread\s+on;/);
  });
});

describe("coredns strict Corefile", () => {
  const conf = renderCorefileStrict();

  it("emits a template block per allowlist host pointing at nginx-strict", () => {
    for (const entry of DEFAULT_ALLOWLIST) {
      const bare = isWildcardHost(entry) ? entry.slice(1) : entry;
      // The generated regex escapes dots as `\.` (one backslash + dot
      // in the literal config file). In a JS string that's "\\.".
      const escaped = bare.replaceAll(".", "\\.");
      expect(conf).toContain(escaped);
    }
    expect(conf).toContain(`IN A ${NGINX_STRICT_IP}`);
  });

  it("catches every unmatched query with an NXDOMAIN template", () => {
    expect(conf).toMatch(/template\s+IN\s+ANY\s*\{[\s\S]*rcode\s+NXDOMAIN[\s\S]*\}/);
  });

  it("wildcard entries get the `(^|\\.)` prefix; exact entries get `^`", () => {
    for (const entry of DEFAULT_ALLOWLIST) {
      const bare = isWildcardHost(entry) ? entry.slice(1) : entry;
      const escaped = bare.replaceAll(".", "\\.");
      if (isWildcardHost(entry)) {
        expect(conf).toContain(`(^|\\.)${escaped}\\.$`);
      } else {
        expect(conf).toContain(`^${escaped}\\.$`);
      }
    }
  });
});

describe("coredns open Corefile", () => {
  const conf = renderCorefileOpen();

  it("returns the nginx-open IP for arbitrary A queries", () => {
    expect(conf).toContain(`IN A ${NGINX_OPEN_IP}`);
  });

  it("hard-denies cloud metadata literals even in unrestricted mode", () => {
    // Two patterns we always block regardless of mode.
    expect(conf).toContain("metadata\\.google\\.internal");
    expect(conf).toContain("169\\.254\\.169\\.254");
    expect(conf).toMatch(/rcode\s+NXDOMAIN/);
  });

  it("returns NOERROR / empty for AAAA so IPv6 doesn't accidentally bypass us", () => {
    expect(conf).toMatch(/template\s+IN\s+AAAA\s*\{[\s\S]*rcode\s+NOERROR[\s\S]*\}/);
  });
});

describe("wildcard expansion sanity", () => {
  // The whole point of the wildcard support is *.github.com etc.
  // Pin behaviour with a hand-checked example.

  it("'.github.com' generates a wildcard nginx map entry", () => {
    const conf = renderNginxStrictConf();
    // Leading-dot form is nginx's native subdomain wildcard. Both the
    // apex and every subdomain match this single line.
    expect(conf).toMatch(/\s\.github\.com\s+\$ssl_preread_server_name:443;/);
  });

  it("'.github.com' generates a CoreDNS pattern matching apex + subdomains", () => {
    const conf = renderCorefileStrict();
    // The regex (^|\.)github\.com\.$ matches both "github.com." and
    // "api.github.com." in dnssec-aware FQDN form.
    expect(conf).toContain("(^|\\.)github\\.com\\.$");
  });
});
