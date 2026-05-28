import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import {
  COREDNS_OPEN_IP,
  COREDNS_STRICT_IP,
  NGINX_OPEN_IP,
  NGINX_STRICT_IP,
  SANDBOX_EGRESS_SUBNET,
} from "./egress-firewall-config.js";

/**
 * Regression test for the sandbox egress network topology.
 *
 * Two contracts pinned here:
 *
 * 1. **Static IPs match the constants the harness bakes into generated
 *    configs.** If compose and `egress-firewall-config.ts` drift on
 *    which IP belongs to which service, sandboxes will dial nowhere.
 *
 * 2. **The egress firewalls don't bridge into the harness's `internal`
 *    network.** If they did, docker DNS would resolve compose service
 *    names (`agent`, `caddy`) from the firewall's perspective, and an
 *    unrestricted sandbox could ride the firewall into harness services.
 *    The firewalls live on `sandbox-egress` (ingress from sandboxes) and
 *    `proxy-egress` (outbound to internet) — never `internal`.
 */

interface ComposeService {
  // Networks can be a short array (`[a, b]`) or a long-form object with
  // per-network config (`{a: {ipv4_address: ...}, b: {}}`).
  networks?: string[] | Record<string, unknown>;
}
interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, unknown>;
}

const compose: ComposeFile = parse(
  readFileSync(resolve(__dirname, "../../docker-compose.yml"), "utf-8"),
);

const FIREWALL_SERVICES = [
  "nginx-egress-strict",
  "nginx-egress-open",
  "coredns-strict",
  "coredns-open",
] as const;
const HARNESS_SERVICES = ["agent", "caddy"] as const;

function networkNamesOf(service: string): string[] {
  const nets = compose.services[service]?.networks;
  if (!nets) return [];
  if (Array.isArray(nets)) return nets;
  return Object.keys(nets);
}

function ipv4OnNetwork(service: string, net: string): string | undefined {
  const nets = compose.services[service]?.networks;
  if (!nets || Array.isArray(nets)) return undefined;
  const cfg = nets[net];
  if (cfg && typeof cfg === "object" && "ipv4_address" in cfg) {
    return String((cfg as { ipv4_address: unknown }).ipv4_address);
  }
  return undefined;
}

describe("docker-compose egress topology", () => {
  it("declares the three expected networks", () => {
    expect(Object.keys(compose.networks).sort()).toEqual(
      ["internal", "proxy-egress", "sandbox-egress"].sort(),
    );
  });

  it("marks sandbox-egress as internal: true with the expected static subnet", () => {
    const net = compose.networks["sandbox-egress"] as {
      internal?: boolean;
      ipam?: { config?: Array<{ subnet?: string }> };
    };
    expect(net?.internal).toBe(true);
    // Subnet must match SANDBOX_EGRESS_SUBNET so the constants in
    // egress-firewall-config.ts are valid IPs in that range.
    const subnet = net?.ipam?.config?.[0]?.subnet;
    expect(subnet).toBe(SANDBOX_EGRESS_SUBNET);
  });

  it("proxy-egress is a regular bridge (no internal: true) so firewalls can reach the internet", () => {
    const net = compose.networks["proxy-egress"] as
      | { internal?: boolean }
      | null
      | undefined;
    // YAML `proxy-egress:` parses to null when no fields are set.
    expect(net == null || net.internal !== true).toBe(true);
  });

  for (const svc of FIREWALL_SERVICES) {
    describe(svc, () => {
      const nets = networkNamesOf(svc);

      it("does NOT attach to the harness `internal` network", () => {
        // Security-critical: if regressed, an unrestricted sandbox can
        // bridge into compose-internal services via the firewall.
        expect(nets).not.toContain("internal");
      });

      it("attaches to sandbox-egress (so sandboxes can reach it)", () => {
        expect(nets).toContain("sandbox-egress");
      });
    });
  }

  it("nginx firewalls attach to proxy-egress (so they can reach the public internet)", () => {
    for (const svc of ["nginx-egress-strict", "nginx-egress-open"]) {
      expect(networkNamesOf(svc)).toContain("proxy-egress");
    }
  });

  it("coredns containers do NOT attach to proxy-egress (no internet needed)", () => {
    // CoreDNS only synthesises answers from its config; it never recurses.
    // Keeping it off proxy-egress is defence in depth.
    for (const svc of ["coredns-strict", "coredns-open"]) {
      expect(networkNamesOf(svc)).not.toContain("proxy-egress");
    }
  });

  it("static IPs match the constants the harness bakes into the generated configs", () => {
    expect(ipv4OnNetwork("coredns-strict", "sandbox-egress")).toBe(COREDNS_STRICT_IP);
    expect(ipv4OnNetwork("coredns-open", "sandbox-egress")).toBe(COREDNS_OPEN_IP);
    expect(ipv4OnNetwork("nginx-egress-strict", "sandbox-egress")).toBe(NGINX_STRICT_IP);
    expect(ipv4OnNetwork("nginx-egress-open", "sandbox-egress")).toBe(NGINX_OPEN_IP);
  });

  for (const svc of HARNESS_SERVICES) {
    it(`harness service \`${svc}\` does NOT attach to proxy-egress or sandbox-egress`, () => {
      // Keeps the egress fabric isolated from anything carrying secrets.
      const nets = networkNamesOf(svc);
      expect(nets).not.toContain("proxy-egress");
      expect(nets).not.toContain("sandbox-egress");
    });
  }

  it("proxy-egress contains exactly the two nginx firewalls", () => {
    const onProxyEgress = Object.keys(compose.services)
      .filter((name) => networkNamesOf(name).includes("proxy-egress"))
      .sort();
    expect(onProxyEgress).toEqual(["nginx-egress-open", "nginx-egress-strict"]);
  });
});
