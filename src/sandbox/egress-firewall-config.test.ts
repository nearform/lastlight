import { describe, it, expect } from "vitest";
import {
  COREDNS_OPEN_IP,
  COREDNS_STRICT_IP,
  NGINX_OPEN_IP,
  NGINX_STRICT_IP,
  OTEL_COLLECTOR_IP,
  OTEL_COLLECTOR_OTLP_GRPC_PORT,
  OTEL_COLLECTOR_OTLP_HTTP_PORT,
  OTEL_COLLECTOR_SANDBOX_ENDPOINT,
  renderCorefileOpen,
  renderCorefileStrict,
  renderNginxOpenConf,
  renderNginxStrictConf,
  renderOtelCollectorConfig,
  SANDBOX_EGRESS_SUBNET,
} from "./egress-firewall-config.js";
import { DEFAULT_ALLOWLIST } from "./egress-allowlist.js";
import { parse as parseYaml } from "yaml";

describe("static IP constants", () => {
  it("all four service IPs sit inside the sandbox-egress subnet", () => {
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
    expect(conf).toMatch(/default\s+127\.0\.0\.1:1;/);
  });

  it("emits a leading-dot map entry per allowlist host (apex+subdomain match)", () => {
    for (const host of DEFAULT_ALLOWLIST) {
      // nginx's `.foo.com` syntax matches `foo.com` and any subdomain.
      // Upstream is the live SNI value, not pinned at config time.
      expect(conf).toContain(`.${host} $ssl_preread_server_name:443;`);
    }
  });

  it("uses docker's embedded DNS as the upstream resolver", () => {
    expect(conf).toMatch(/resolver\s+127\.0\.0\.11/);
  });

  it("declares `hostnames` in the map block so leading-dot wildcards work", () => {
    // Without `hostnames;`, nginx's `map` does exact string match only —
    // `.github.com` becomes a literal key that never matches anything.
    // We hit this in prod: every allowlisted host fell through to the
    // black-hole default. Pin the contract so it can't regress.
    expect(conf).toMatch(/map\s+\$ssl_preread_server_name\s+\$upstream_target\s*\{\s*\n\s*hostnames;/);
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

  it("uses a SINGLE template block with one match line per allowlist host", () => {
    // CoreDNS only honours one `template` block per (class, type, zone) —
    // multiple blocks silently shadow each other. Catching a regression
    // matters because we hit this exact bug in prod.
    const templateBlocks = conf.match(/template\s+IN\s+A\s*\{/g) || [];
    expect(templateBlocks.length).toBe(1);

    for (const host of DEFAULT_ALLOWLIST) {
      const escaped = host.replaceAll(".", "\\.");
      expect(conf).toContain(`(^|\\.)${escaped}\\.$`);
    }
  });

  it("answers with the nginx-strict IP", () => {
    expect(conf).toContain(`IN A ${NGINX_STRICT_IP}`);
  });

  it("catches every unmatched query with an NXDOMAIN template", () => {
    expect(conf).toMatch(/template\s+IN\s+ANY\s*\{[\s\S]*rcode\s+NXDOMAIN[\s\S]*\}/);
  });
});

describe("coredns open Corefile", () => {
  const conf = renderCorefileOpen();

  it("returns the nginx-open IP for arbitrary A queries", () => {
    expect(conf).toContain(`IN A ${NGINX_OPEN_IP}`);
  });

  it("hard-denies cloud metadata literals even in unrestricted mode", () => {
    // Each hard-deny host gets its own zone block so CoreDNS's
    // longest-suffix routing intercepts the apex + subdomains before
    // the catch-all `.` zone sees them.
    expect(conf).toMatch(/metadata\.google\.internal:53\s*\{[\s\S]*?rcode\s+NXDOMAIN/);
    expect(conf).toMatch(/169\.254\.169\.254:53\s*\{[\s\S]*?rcode\s+NXDOMAIN/);
  });

  it("returns NOERROR / empty for AAAA so IPv6 doesn't accidentally bypass us", () => {
    expect(conf).toMatch(/template\s+IN\s+AAAA\s*\{[\s\S]*rcode\s+NOERROR[\s\S]*\}/);
  });
});

describe("otel collector config", () => {
  // Most tests run with forwarding active; the gating tests below cover inactive.
  const renderActive = (env: NodeJS.ProcessEnv) => parseYaml(renderOtelCollectorConfig({ active: true, env })) as any;

  it("sandbox endpoint points at the collector's static IP + OTLP/HTTP port", () => {
    expect(OTEL_COLLECTOR_SANDBOX_ENDPOINT).toBe(`http://${OTEL_COLLECTOR_IP}:${OTEL_COLLECTOR_OTLP_HTTP_PORT}`);
  });

  it("receives OTLP on both http and grpc, on all interfaces", () => {
    const cfg = renderActive({});
    expect(cfg.receivers.otlp.protocols.http.endpoint).toBe(`0.0.0.0:${OTEL_COLLECTOR_OTLP_HTTP_PORT}`);
    expect(cfg.receivers.otlp.protocols.grpc.endpoint).toBe(`0.0.0.0:${OTEL_COLLECTOR_OTLP_GRPC_PORT}`);
  });

  it("re-exports to the generic endpoint (as a base URL) with parsed auth headers on every signal", () => {
    const cfg = renderActive({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "api-key=secret-123,x-tenant=acme",
    });
    for (const signal of ["traces", "metrics", "logs"]) {
      const exp = cfg.exporters[`otlphttp/${signal}`];
      // Generic endpoint → `endpoint` field (collector appends /v1/<signal>).
      expect(exp.endpoint).toBe("https://collector.example.com:4318");
      expect(exp[`${signal}_endpoint`]).toBeUndefined();
      expect(exp.headers).toEqual({ "api-key": "secret-123", "x-tenant": "acme" });
      expect(cfg.service.pipelines[signal].exporters).toEqual([`otlphttp/${signal}`]);
    }
  });

  it("routes per-signal endpoints to their own pipeline (no fallback-chain misrouting)", () => {
    // The bug the reviewer flagged: separate traces/metrics endpoints must not
    // both export to whichever one won a `||` chain.
    const cfg = renderActive({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example.com/v1/metrics",
    });
    // Signal-specific endpoints are used verbatim via `<signal>_endpoint`.
    expect(cfg.exporters["otlphttp/traces"].traces_endpoint).toBe("https://traces.example.com/v1/traces");
    expect(cfg.exporters["otlphttp/metrics"].metrics_endpoint).toBe("https://metrics.example.com/v1/metrics");
    expect(cfg.service.pipelines.traces.exporters).toEqual(["otlphttp/traces"]);
    expect(cfg.service.pipelines.metrics.exporters).toEqual(["otlphttp/metrics"]);
    // logs had no endpoint configured → debug, not silently misrouted.
    expect(cfg.service.pipelines.logs.exporters).toEqual(["debug"]);
    expect(cfg.exporters.debug).toBeDefined();
  });

  it("honours a logs-only endpoint instead of dropping it (the silent-drop case)", () => {
    const cfg = renderActive({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example.com/v1/logs",
    });
    expect(cfg.exporters["otlphttp/logs"].logs_endpoint).toBe("https://logs.example.com/v1/logs");
    expect(cfg.service.pipelines.logs.exporters).toEqual(["otlphttp/logs"]);
    expect(cfg.service.pipelines.traces.exporters).toEqual(["debug"]);
    expect(cfg.service.pipelines.metrics.exporters).toEqual(["debug"]);
  });

  it("lets a signal-specific endpoint override the generic one for just that signal", () => {
    const cfg = renderActive({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.example.com",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example.com/v1/traces",
    });
    // traces → verbatim specific URL; metrics/logs → generic base.
    expect(cfg.exporters["otlphttp/traces"].traces_endpoint).toBe("https://traces.example.com/v1/traces");
    expect(cfg.exporters["otlphttp/metrics"].endpoint).toBe("https://generic.example.com");
    expect(cfg.exporters["otlphttp/logs"].endpoint).toBe("https://generic.example.com");
  });

  it("applies per-signal header overrides, falling back to generic headers", () => {
    const cfg = renderActive({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.example.com",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=generic",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=traces-only",
    });
    expect(cfg.exporters["otlphttp/traces"].headers.authorization).toBe("traces-only");
    expect(cfg.exporters["otlphttp/metrics"].headers.authorization).toBe("generic");
  });

  it("supports a non-443 / custom-port HTTPS backend the strict SNI firewall could not reach", () => {
    // This is the case the reviewer flagged for the old direct-forward path.
    // It now works because the collector dials the backend on its trusted
    // outbound leg, not through ssl_preread.
    const cfg = renderActive({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.internal:4318" });
    expect(cfg.exporters["otlphttp/traces"].endpoint).toBe("https://otel.internal:4318");
  });

  it("preserves '=' inside header values (bearer tokens survive intact)", () => {
    const cfg = renderActive({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://b.example.com",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer abc=def==",
    });
    expect(cfg.exporters["otlphttp/traces"].headers.authorization).toBe("Bearer abc=def==");
  });

  it("falls back to a debug exporter (no data leaves) when active but no backend is configured", () => {
    const cfg = renderActive({});
    expect(cfg.exporters.debug).toBeDefined();
    expect(cfg.exporters["otlphttp/traces"]).toBeUndefined();
    for (const signal of ["traces", "metrics", "logs"]) {
      expect(cfg.service.pipelines[signal].exporters).toEqual(["debug"]);
    }
  });

  it("produces valid YAML even with quote/backslash-bearing header values", () => {
    // Crucially, a single quote in a header value no longer fails anything:
    // it lives in the host-side collector config, never a sandbox shell wrap.
    const cfg = renderActive({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://b.example.com",
      OTEL_EXPORTER_OTLP_HEADERS: `x-quote=it's "quoted" \\ backslash`,
    });
    expect(cfg.exporters["otlphttp/traces"].headers["x-quote"]).toBe(`it's "quoted" \\ backslash`);
  });

  it("drops CR/LF-bearing header pairs (no header injection, no broken YAML) but keeps the rest", () => {
    // A newline in a header value would be header injection on the
    // collector→backend leg and would also break the YAML scalar.
    const raw = renderOtelCollectorConfig({
      active: true,
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://b.example.com",
        OTEL_EXPORTER_OTLP_HEADERS: "x-good=ok,x-bad=line1\nline2",
      },
    });
    expect(() => parseYaml(raw)).not.toThrow();
    const cfg = parseYaml(raw) as any;
    expect(cfg.exporters["otlphttp/traces"].headers).toEqual({ "x-good": "ok" });
  });

  describe("forwarding gate (security floor)", () => {
    it("when inactive, drops every signal to debug and emits no backend endpoint or credential", () => {
      const raw = renderOtelCollectorConfig({
        active: false,
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://real-backend.example.com",
          OTEL_EXPORTER_OTLP_HEADERS: "authorization=super-secret-token",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example.com",
        },
      });
      // No backend URL or secret leaks into the generated file at all.
      expect(raw).not.toContain("real-backend.example.com");
      expect(raw).not.toContain("super-secret-token");
      expect(raw).not.toContain("traces.example.com");
      expect(raw).not.toContain("otlphttp");
      const cfg = parseYaml(raw) as any;
      expect(cfg.exporters.debug).toBeDefined();
      for (const signal of ["traces", "metrics", "logs"]) {
        expect(cfg.service.pipelines[signal].exporters).toEqual(["debug"]);
      }
      // Receiver still listens so sandboxes don't get connection errors.
      expect(cfg.receivers.otlp.protocols.http.endpoint).toBe(`0.0.0.0:${OTEL_COLLECTOR_OTLP_HTTP_PORT}`);
    });
  });
});

describe("apex + subdomain match sanity", () => {
  // Pin behaviour: a bare entry like "github.com" must match both
  // the apex and any subdomain in both backends.

  it("'github.com' generates an nginx leading-dot map entry", () => {
    const conf = renderNginxStrictConf();
    expect(conf).toMatch(/\s\.github\.com\s+\$ssl_preread_server_name:443;/);
  });

  it("'github.com' generates a CoreDNS pattern matching apex + subdomains", () => {
    const conf = renderCorefileStrict();
    // (^|\.)github\.com\.$ matches both "github.com." and "api.github.com."
    // in FQDN-with-trailing-dot form.
    expect(conf).toContain("(^|\\.)github\\.com\\.$");
  });
});
