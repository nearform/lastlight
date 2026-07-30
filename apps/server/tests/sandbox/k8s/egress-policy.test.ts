import { describe, it, expect } from "vitest";
import {
  EGRESS_POLICY_LABEL,
  STRICT_POLICY_NAME,
  OPEN_POLICY_NAME,
  CILIUM_GROUP,
  CILIUM_VERSION,
  CILIUM_CNP_PLURAL,
  fqdnRulesFor,
  renderStrictEgressPolicy,
  renderOpenEgressPolicy,
  renderEgressPolicies,
} from "#src/sandbox/k8s/egress-policy.js";
import { DEFAULT_ALLOWLIST } from "#src/sandbox/egress-allowlist.js";

describe("fqdnRulesFor", () => {
  it("expands each bare host to apex matchName + subdomain matchPattern", () => {
    expect(fqdnRulesFor(["github.com"])).toEqual([
      { matchName: "github.com" },
      { matchPattern: "*.github.com" },
    ]);
  });
  it("preserves order and covers every allowlist host", () => {
    const rules = fqdnRulesFor(DEFAULT_ALLOWLIST);
    for (const host of DEFAULT_ALLOWLIST) {
      expect(rules).toContainEqual({ matchName: host });
      expect(rules).toContainEqual({ matchPattern: `*.${host}` });
    }
  });
});

describe("renderStrictEgressPolicy", () => {
  const pol = renderStrictEgressPolicy({
    namespace: "lastlight-sandboxes",
    hosts: ["github.com", "openai.com"],
  });

  it("is a namespaced CiliumNetworkPolicy selecting the strict label", () => {
    expect(pol.apiVersion).toBe(`${CILIUM_GROUP}/${CILIUM_VERSION}`);
    expect(pol.kind).toBe("CiliumNetworkPolicy");
    expect(pol.metadata.name).toBe(STRICT_POLICY_NAME);
    expect(pol.metadata.namespace).toBe("lastlight-sandboxes");
    expect(pol.spec.endpointSelector.matchLabels).toEqual({ [EGRESS_POLICY_LABEL]: "strict" });
  });

  it("exposes the CRD coordinates the CustomObjectsApi caller needs", () => {
    expect(CILIUM_CNP_PLURAL).toBe("ciliumnetworkpolicies");
  });

  it("allows DNS to kube-dns with a wildcard dns-proxy rule (so toFQDNs can resolve)", () => {
    const dns = pol.spec.egress.find(
      (r: any) =>
        r.toEndpoints?.[0]?.matchLabels?.["k8s:io.kubernetes.pod.namespace"] === "kube-system",
    ) as any;
    expect(dns.toEndpoints[0].matchLabels["k8s-app"]).toBe("kube-dns");
    expect(dns.toPorts[0].ports).toContainEqual({ port: "53", protocol: "ANY" });
    expect(dns.toPorts[0].rules.dns).toEqual([{ matchPattern: "*" }]);
  });

  it("allows the allowlist FQDNs on 443/TCP and nothing else (default-deny elsewhere)", () => {
    const fqdn = pol.spec.egress.find((r: any) => r.toFQDNs) as any;
    expect(fqdn.toFQDNs).toContainEqual({ matchName: "github.com" });
    expect(fqdn.toFQDNs).toContainEqual({ matchPattern: "*.openai.com" });
    expect(fqdn.toPorts[0].ports).toEqual([{ port: "443", protocol: "TCP" }]);
    // strict has exactly DNS + FQDN rules — no CIDR hole.
    expect(pol.spec.egress.some((r: any) => r.toCIDRSet)).toBe(false);
  });
});

describe("renderOpenEgressPolicy", () => {
  const pol = renderOpenEgressPolicy({ namespace: "lastlight-sandboxes" });

  it("selects the open label and keeps the DNS rule", () => {
    expect(pol.metadata.name).toBe(OPEN_POLICY_NAME);
    expect(pol.spec.endpointSelector.matchLabels).toEqual({ [EGRESS_POLICY_LABEL]: "open" });
    expect(pol.spec.egress.some((r: any) => r.toPorts?.[0]?.rules?.dns)).toBe(true);
  });

  it("allows broad egress but excepts private + link-local + loopback (the SSRF floor)", () => {
    const cidr = pol.spec.egress.find((r: any) => r.toCIDRSet) as any;
    const v4 = cidr.toCIDRSet.find((c: any) => c.cidr === "0.0.0.0/0");
    expect(v4.except).toEqual(
      expect.arrayContaining([
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "127.0.0.0/8",
      ]),
    );
    const v6 = cidr.toCIDRSet.find((c: any) => c.cidr === "::/0");
    expect(v6.except).toEqual(expect.arrayContaining(["::1/128", "fc00::/7", "fe80::/10"]));
    expect(cidr.toPorts[0].ports).toEqual(
      expect.arrayContaining([{ port: "443", protocol: "TCP" }, { port: "80", protocol: "TCP" }]),
    );
  });
});

describe("renderEgressPolicies", () => {
  it("returns the strict/open pair for a namespace", () => {
    const { strict, open } = renderEgressPolicies({ namespace: "ns", hosts: ["github.com"] });
    expect(strict.metadata.name).toBe(STRICT_POLICY_NAME);
    expect(open.metadata.name).toBe(OPEN_POLICY_NAME);
    expect(strict.metadata.namespace).toBe("ns");
    expect(open.metadata.namespace).toBe("ns");
  });
});

const harness = {
  namespace: "lastlight",
  labels: { "app.kubernetes.io/name": "lastlight" },
  port: 8644,
};

describe("toEndpoints harness rule", () => {
  it("strict permits sandbox→harness on the harness port (identity, not a CIDR hole)", () => {
    const pol = renderStrictEgressPolicy({ namespace: "ns", hosts: ["github.com"], harness });
    // DNS also uses toEndpoints (to kube-dns) — find the harness-labelled rule specifically.
    const rule = pol.spec.egress.find(
      (r: any) => r.toEndpoints?.[0]?.matchLabels?.["app.kubernetes.io/name"] === "lastlight",
    ) as any;
    expect(rule.toEndpoints[0].matchLabels).toMatchObject({
      "k8s:io.kubernetes.pod.namespace": "lastlight",
      "app.kubernetes.io/name": "lastlight",
    });
    expect(rule.toPorts[0].ports).toContainEqual({ port: "8644", protocol: "TCP" });
    // still no CIDR escape hatch in strict
    expect(pol.spec.egress.some((r: any) => r.toCIDRSet)).toBe(false);
  });

  it("open also carries the harness rule", () => {
    const pol = renderOpenEgressPolicy({ namespace: "ns", harness });
    expect(
      pol.spec.egress.some(
        (r: any) => r.toEndpoints?.[0]?.matchLabels?.["app.kubernetes.io/name"] === "lastlight",
      ),
    ).toBe(true);
  });

  it("renderEgressPolicies forwards harness to both strict and open", () => {
    const { strict, open } = renderEgressPolicies({
      namespace: "ns",
      hosts: ["github.com"],
      harness,
    });
    // DNS also uses toEndpoints (to kube-dns) — narrow to the harness-labelled
    // rule so this actually guards `harness` forwarding, not just DNS's presence.
    expect(
      strict.spec.egress.some(
        (r: any) => r.toEndpoints?.[0]?.matchLabels?.["app.kubernetes.io/name"] === "lastlight",
      ),
    ).toBe(true);
    expect(
      open.spec.egress.some(
        (r: any) => r.toEndpoints?.[0]?.matchLabels?.["app.kubernetes.io/name"] === "lastlight",
      ),
    ).toBe(true);
  });

  it("omitted harness renders no toEndpoints-for-harness rule (Task-6 closes this)", () => {
    const pol = renderStrictEgressPolicy({ namespace: "ns", hosts: ["github.com"] });
    // the DNS rule also uses toEndpoints, so assert specifically no harness-labelled rule
    const harnessRule = pol.spec.egress.find(
      (r: any) => r.toEndpoints?.[0]?.matchLabels?.["app.kubernetes.io/name"] === "lastlight",
    );
    expect(harnessRule).toBeUndefined();
  });
});
