import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import {
  COREDNS_OPEN_IP,
  COREDNS_STRICT_IP,
  NGINX_OPEN_IP,
  NGINX_STRICT_IP,
  OTEL_COLLECTOR_IP,
  OTEL_COLLECTOR_UID,
  SANDBOX_EGRESS_SUBNET,
} from "#src/sandbox/egress-firewall-config.js";
import { MODEL_GATEWAY_IP } from "#src/sandbox/model-gateway.js";

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
  user?: string;
  command?: string[] | string;
  volumes?: unknown[];
}
interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, unknown>;
}

const compose: ComposeFile = parse(
  readFileSync(resolve("docker-compose.yml"), "utf-8"),
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

  describe("otel-collector", () => {
    const nets = networkNamesOf("otel-collector");

    it("is dual-homed on sandbox-egress (ingress from sandboxes) + proxy-egress (outbound to backend)", () => {
      expect(nets).toContain("sandbox-egress");
      expect(nets).toContain("proxy-egress");
    });

    it("does NOT attach to the harness `internal` network (can't bridge a sandbox into harness services)", () => {
      expect(nets).not.toContain("internal");
    });

    it("uses the static IP the harness bakes into the sandbox OTLP endpoint", () => {
      expect(ipv4OnNetwork("otel-collector", "sandbox-egress")).toBe(OTEL_COLLECTOR_IP);
    });

    it("does NOT force root — runs as the image's non-root UID", () => {
      // The harness writes the mode-0600 config as UID OTEL_COLLECTOR_UID (its
      // `lastlight` user is pinned to it), so the collector reads it as owner
      // without root. If this ever regresses to `user: "0:0"`, we'd be running
      // a sandbox-facing service as root unnecessarily.
      expect(compose.services["otel-collector"]?.user).toBeUndefined();
    });
  });

  it("pins the harness `lastlight` UID to the collector image UID so it can read the 0600 config", () => {
    // The collector reads the harness-written mode-0600 OTLP config as its
    // owner. That only works if the harness writes it as the collector's UID,
    // so the Dockerfile must `useradd -u <OTEL_COLLECTOR_UID> lastlight`. If
    // the collector image's UID ever changes, this test fails loudly to force
    // bumping both together.
    const dockerfile = readFileSync(resolve("Dockerfile"), "utf-8");
    expect(dockerfile).toMatch(new RegExp(`useradd[^\\n]*-u\\s+${OTEL_COLLECTOR_UID}\\s+lastlight`));
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

  it("proxy-egress contains exactly the two nginx firewalls, the otel-collector and the model gateway", () => {
    // These are the only services allowed an outbound path: the firewalls
    // tunnel sandbox HTTPS, and the collector re-exports sandbox telemetry.
    // None touch `internal`, so none can bridge a sandbox into harness
    // services. Any other service appearing here is a regression.
    const onProxyEgress = Object.keys(compose.services)
      .filter((name) => networkNamesOf(name).includes("proxy-egress"))
      .sort();
    expect(onProxyEgress).toEqual(["model-gateway", "nginx-egress-open", "nginx-egress-strict", "otel-collector"]);
  });

  describe("model-gateway", () => {
    const nets = networkNamesOf("model-gateway");

    it("is dual-homed on sandbox-egress (172.30.0.40) + proxy-egress", () => {
      expect(nets).toContain("sandbox-egress");
      expect(nets).toContain("proxy-egress");
    });

    it("does NOT attach to the harness `internal` network", () => {
      expect(nets).not.toContain("internal");
    });

    it("static IP matches MODEL_GATEWAY_IP", () => {
      expect(ipv4OnNetwork("model-gateway", "sandbox-egress")).toBe(MODEL_GATEWAY_IP);
    });

    it("mounts only the proxy config directory, read-only — not the whole agent-data volume", () => {
      // The gateway holds the provider key; it must not also see sessions,
      // clones, or the credential store under /app/data.
      const volumes = compose.services["model-gateway"]?.volumes ?? [];
      expect(volumes).toHaveLength(1);
      expect(volumes[0]).toMatchObject({
        type: "volume",
        source: "agent-data",
        target: "/app/data/proxy",
        read_only: true,
        volume: { subpath: "proxy" },
      });
    });

    it("is opt-in behind the model-gateway profile (no config to load without a gateway provider)", () => {
      expect((compose.services["model-gateway"] as { profiles?: string[] })?.profiles).toEqual(["model-gateway"]);
    });

    it("runs nginx with /app/data/proxy/model-gateway.conf", () => {
      expect(compose.services["model-gateway"]?.command).toEqual([
        "nginx", "-c", "/app/data/proxy/model-gateway.conf", "-g", "daemon off;",
      ]);
    });
  });

  it("egress-init also writes the model gateway config", () => {
    const command = JSON.stringify(compose.services["egress-init"]?.command);
    expect(command).toContain("writeModelGatewayConfig(d,process.env,c.sandbox)");
  });
});
