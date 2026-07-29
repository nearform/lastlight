import type { EgressPolicy } from "../sandbox.js";

/** Pod/selector label choosing which egress policy applies. */
export const EGRESS_POLICY_LABEL = "egress-policy";

/** The two Cilium egress postures a sandbox pod can be labeled with — see
 *  {@link EGRESS_POLICY_LABEL}. Named once here so `pod.ts` and the adapter
 *  import it instead of retyping the bare union. */
export type EgressMode = "strict" | "open";

/** Single derivation point: the backend-agnostic intent-only {@link EgressPolicy}
 *  (`sandbox.ts`) → the k8s-specific {@link EgressMode} label value. */
export function egressModeFor(policy: EgressPolicy): EgressMode {
  return policy.unrestricted ? "open" : "strict";
}

/** Name of the CiliumNetworkPolicy applied to strict-egress sandbox pods. */
export const STRICT_POLICY_NAME = "lastlight-sandbox-egress-strict";
/** Name of the CiliumNetworkPolicy applied to open-egress sandbox pods. */
export const OPEN_POLICY_NAME = "lastlight-sandbox-egress-open";

/** Cilium CiliumNetworkPolicy CRD coordinates (client-node CustomObjectsApi). */
export const CILIUM_GROUP = "cilium.io";
export const CILIUM_VERSION = "v2";
export const CILIUM_CNP_PLURAL = "ciliumnetworkpolicies";

/**
 * Private / link-local / loopback ranges the OPEN policy excepts from its
 * broad `0.0.0.0/0` allow — the SSRF floor. RFC-1918 covers the cluster pod /
 * service CIDRs on the target cluster (all within 10/8), and 169.254.0.0/16
 * covers the cloud-metadata literal. Strict mode needs none of this: with only
 * DNS + toFQDNs rules, a strict pod can reach *only* an allowlisted FQDN's
 * resolved IP, so private space is unreachable by construction.
 */
const PRIVATE_CIDRS_V4 = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "127.0.0.0/8",
];
const PRIVATE_CIDRS_V6 = ["::1/128", "fc00::/7", "fe80::/10"];

/** Selects the in-cluster DNS service so Cilium's DNS proxy sees the queries. */
const KUBE_DNS_SELECTOR = {
  "k8s:io.kubernetes.pod.namespace": "kube-system",
  "k8s-app": "kube-dns",
};

/** One `toPorts` port entry — Cilium's wire format takes the port as a string. */
interface CiliumPort {
  port: string;
  protocol: "TCP" | "ANY";
}

/** DNS-proxy activation attached to a `toPorts` entry (see `dnsEgressRule`). */
interface CiliumDnsRules {
  dns: Array<{ matchPattern: string }>;
}

/** One `toPorts` entry: the allowed ports, plus optional DNS-proxy activation. */
interface CiliumToPorts {
  ports: CiliumPort[];
  rules?: CiliumDnsRules;
}

/** Cilium identity selector — labels an endpoint must carry (`toEndpoints`). */
interface CiliumEndpointSelector {
  matchLabels: Record<string, string>;
}

/** One FQDN allow entry — either the exact apex or a `*.`-prefixed subdomain wildcard. */
export type CiliumFqdnMatch = { matchName: string } | { matchPattern: string };

/** One `toCIDRSet` entry — a CIDR block with its exception list. */
interface CiliumCidrRange {
  cidr: string;
  except: string[];
}

/**
 * Minimal shape of a Cilium egress rule — the closed set this file emits: an
 * identity allow (`toEndpoints`), an FQDN allowlist (`toFQDNs`), or a CIDR
 * allow-with-exceptions (`toCIDRSet`), each optionally paired with `toPorts`.
 * Properties are optional so each rule literal sets only the ones it needs;
 * this exists to reject a *misspelled* property at compile time (a `toFQDN`
 * typo, say), not to enforce which combination of properties is valid.
 */
export interface CiliumEgressRule {
  toEndpoints?: CiliumEndpointSelector[];
  toFQDNs?: CiliumFqdnMatch[];
  toCIDRSet?: CiliumCidrRange[];
  toPorts?: CiliumToPorts[];
}

/**
 * DNS egress rule shared by both policies: allow port 53 to kube-dns AND turn
 * on the DNS proxy (`rules.dns: [{ matchPattern: "*" }]`). WITHOUT this rule
 * `toFQDNs` never learns any IP and every connection is denied — Cilium only
 * permits connecting to an IP it was allowed to resolve. This is the mechanism
 * that closes the private-IP SSRF gap the docker SNI-peek admits it cannot.
 */
function dnsEgressRule(): CiliumEgressRule {
  return {
    toEndpoints: [{ matchLabels: KUBE_DNS_SELECTOR }],
    toPorts: [
      { ports: [{ port: "53", protocol: "ANY" }], rules: { dns: [{ matchPattern: "*" }] } },
    ],
  };
}

/** The harness Pod the sandbox may reach for the skill fetch (design §4/§7). */
export interface HarnessSelector {
  namespace: string;
  labels: Record<string, string>;
  port: number;
}

/** Permit sandbox→harness only, by Cilium identity (namespace + labels), on the
 *  harness port — an identity rule, not a CIDR hole. Carries the Section 7 skill
 *  fetch under both strict and open. */
function harnessEgressRule(h: HarnessSelector): CiliumEgressRule {
  return {
    toEndpoints: [
      { matchLabels: { "k8s:io.kubernetes.pod.namespace": h.namespace, ...h.labels } },
    ],
    toPorts: [{ ports: [{ port: String(h.port), protocol: "TCP" }] }],
  };
}

/** Minimal shape of a Cilium `CiliumNetworkPolicy` custom resource. */
export interface CiliumNetworkPolicy {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string };
  spec: { endpointSelector: { matchLabels: Record<string, string> }; egress: CiliumEgressRule[] };
}

/**
 * Expand each bare allowlist host to the two Cilium FQDN forms it needs:
 * `matchName` for the apex, `matchPattern: "*.host"` for every subdomain
 * (the pattern alone excludes the apex). Mirrors nginx's `.host` and CoreDNS's
 * `(^|\.)host\.$` — same apex+subdomain convention, one shared source list.
 */
export function fqdnRulesFor(hosts: readonly string[]): CiliumFqdnMatch[] {
  const rules: CiliumFqdnMatch[] = [];
  for (const host of hosts) {
    rules.push({ matchName: host });
    rules.push({ matchPattern: `*.${host}` });
  }
  return rules;
}

function policy(
  name: string,
  namespace: string,
  value: EgressMode,
  egress: CiliumEgressRule[],
): CiliumNetworkPolicy {
  return {
    apiVersion: `${CILIUM_GROUP}/${CILIUM_VERSION}`,
    kind: "CiliumNetworkPolicy",
    metadata: { name, namespace },
    spec: { endpointSelector: { matchLabels: { [EGRESS_POLICY_LABEL]: value } }, egress },
  };
}

/** Strict = DNS + the allowlist FQDNs on 443/TCP; everything else default-denied. */
export function renderStrictEgressPolicy(opts: {
  namespace: string;
  hosts: readonly string[];
  harness?: HarnessSelector;
}): CiliumNetworkPolicy {
  const egress: CiliumEgressRule[] = [
    dnsEgressRule(),
    { toFQDNs: fqdnRulesFor(opts.hosts), toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }] },
  ];
  if (opts.harness) egress.push(harnessEgressRule(opts.harness));
  return policy(STRICT_POLICY_NAME, opts.namespace, "strict", egress);
}

/** Open = DNS + broad 80/443 egress minus the private-CIDR SSRF floor. */
export function renderOpenEgressPolicy(opts: {
  namespace: string;
  harness?: HarnessSelector;
}): CiliumNetworkPolicy {
  const egress: CiliumEgressRule[] = [
    dnsEgressRule(),
    {
      toCIDRSet: [
        { cidr: "0.0.0.0/0", except: PRIVATE_CIDRS_V4 },
        { cidr: "::/0", except: PRIVATE_CIDRS_V6 },
      ],
      toPorts: [{ ports: [{ port: "443", protocol: "TCP" }, { port: "80", protocol: "TCP" }] }],
    },
  ];
  if (opts.harness) egress.push(harnessEgressRule(opts.harness));
  return policy(OPEN_POLICY_NAME, opts.namespace, "open", egress);
}

/** Render the strict/open CiliumNetworkPolicy pair for one sandbox namespace. */
export function renderEgressPolicies(opts: {
  namespace: string;
  hosts: readonly string[];
  harness?: HarnessSelector;
}): { strict: CiliumNetworkPolicy; open: CiliumNetworkPolicy } {
  return {
    strict: renderStrictEgressPolicy(opts),
    open: renderOpenEgressPolicy({ namespace: opts.namespace, harness: opts.harness }),
  };
}
