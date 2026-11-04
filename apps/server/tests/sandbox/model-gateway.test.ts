/**
 * The model gateway (docker backend): the sandbox gets a placeholder key and
 * the gateway's URL for a `sandboxGateway` provider; the real key stays with
 * the gateway sidecar.
 */
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installProviderOverrides, resetProviderRegistry } from "#src/config/provider-registry.js";
import {
  applyModelGateway,
  gatewayEndpoints,
  MODEL_GATEWAY_KEY_PLACEHOLDER,
  modelGatewayBaseUrl,
  renderModelGatewayConf,
  writeModelGatewayConfig,
} from "#src/sandbox/model-gateway.js";

const REAL_KEY = "sk-test-not-a-real-key";

function wireFor(extra: Record<string, unknown> = {}) {
  return {
    acme: {
      baseUrl: "https://gw.example/v1",
      api: "openai-completions",
      apiKeyEnv: "ACME_API_KEY",
      headers: { "x-cmd-zdr": "1" },
      ...extra,
    },
  };
}

describe("model gateway", () => {
  beforeEach(() => {
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1", sandboxGateway: true } });
  });
  afterEach(() => resetProviderRegistry());

  it("exposes the gateway URL per provider prefix", () => {
    expect(modelGatewayBaseUrl("acme")).toBe("http://172.30.0.40/acme");
    expect(MODEL_GATEWAY_KEY_PLACEHOLDER).toBe("lastlight-model-gateway");
    expect(gatewayEndpoints().map((e) => e.prefix)).toEqual(["acme"]);
  });

  it("docker: the real key is replaced by the placeholder and the URL points at the gateway", () => {
    const { env, wire } = applyModelGateway({ ACME_API_KEY: REAL_KEY, GITHUB_TOKEN: "t" }, wireFor(), "docker");
    expect(env.ACME_API_KEY).toBe("lastlight-model-gateway");
    expect(env.GITHUB_TOKEN).toBe("t");
    expect(wire!.acme.baseUrl).toBe("http://172.30.0.40/acme");
    expect(wire!.acme.headers).toEqual({ "x-cmd-zdr": "1" });
    expect(JSON.stringify({ env, wire })).not.toContain(REAL_KEY);
  });

  it("docker: sets the placeholder even when the key was absent from env", () => {
    const { env } = applyModelGateway({}, wireFor(), "docker");
    expect(env.ACME_API_KEY).toBe("lastlight-model-gateway");
  });

  it("gondolin/none: unchanged (the model call is host-side)", () => {
    for (const backend of ["gondolin", "none"] as const) {
      const inEnv = { ACME_API_KEY: REAL_KEY };
      const inWire = wireFor();
      const { env, wire } = applyModelGateway(inEnv, inWire, backend);
      expect(env.ACME_API_KEY).toBe(REAL_KEY);
      expect(wire!.acme.baseUrl).toBe("https://gw.example/v1");
    }
  });

  it("a provider without sandboxGateway keeps its real key and URL", () => {
    resetProviderRegistry();
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1" } });
    const { env, wire } = applyModelGateway({ ACME_API_KEY: REAL_KEY }, wireFor(), "docker");
    expect(env.ACME_API_KEY).toBe(REAL_KEY);
    expect(wire!.acme.baseUrl).toBe("https://gw.example/v1");
  });

  it("does not mutate its inputs", () => {
    const inEnv = { ACME_API_KEY: REAL_KEY };
    const inWire = wireFor();
    applyModelGateway(inEnv, inWire, "docker");
    expect(inEnv.ACME_API_KEY).toBe(REAL_KEY);
    expect(inWire.acme.baseUrl).toBe("https://gw.example/v1");
  });
});

describe("model gateway nginx config", () => {
  const env = { ACME_API_KEY: REAL_KEY };
  const install = (extra: Record<string, unknown> = {}) =>
    installProviderOverrides({
      acme: {
        baseUrl: "https://gw.example/provider/v1",
        sandboxGateway: true,
        headers: { "x-cmd-zdr": "1" },
        ...extra,
      },
    });
  afterEach(() => resetProviderRegistry());

  it("forwards only the allowed paths, everything else 404", () => {
    install();
    const conf = renderModelGatewayConf(env)!;
    expect(conf).toContain("location = /acme/chat/completions {");
    expect(conf).toContain("/provider/v1/chat/completions$is_args$args;");
    expect(conf).toContain("location = /acme/models {");
    expect(conf).toContain("/provider/v1/models$is_args$args;");
    // openai-completions never needs the anthropic paths
    expect(conf).not.toContain("location = /acme/v1/messages");
    expect(conf).toMatch(/location \/ \{\s*return 404;\s*\}/);
    expect(conf.match(/location = /g)).toHaveLength(2);
  });

  it("anthropic-messages: forwards the paths the Anthropic SDK appends (v1/messages, v1/models)", () => {
    install({ api: "anthropic-messages", baseUrl: "https://gw.example/provider" });
    const conf = renderModelGatewayConf(env)!;
    expect(conf).toContain("location = /acme/v1/messages {");
    expect(conf).toContain("/provider/v1/messages$is_args$args;");
    expect(conf).toContain("location = /acme/v1/models {");
    expect(conf).not.toContain("location = /acme/chat/completions");
  });

  it("replaces the client credential with the real one (openai-completions)", () => {
    install();
    const conf = renderModelGatewayConf(env)!;
    expect(conf).toContain(`proxy_set_header Authorization "Bearer ${REAL_KEY}";`);
    expect(conf).toContain('proxy_set_header x-api-key "";');
  });

  it("replaces the client credential with the real one (anthropic-messages)", () => {
    install({ api: "anthropic-messages", baseUrl: "https://gw.example/provider" });
    const conf = renderModelGatewayConf(env)!;
    expect(conf).toContain(`proxy_set_header x-api-key "${REAL_KEY}";`);
    expect(conf).toContain('proxy_set_header Authorization "";');
  });

  it("adds the provider's literal headers", () => {
    install();
    expect(renderModelGatewayConf(env)).toContain('proxy_set_header x-cmd-zdr "1";');
  });

  it("streams, allows big bodies, long reads, verified TLS", () => {
    install();
    const conf = renderModelGatewayConf(env)!;
    for (const line of [
      "proxy_buffering off;",
      "proxy_request_buffering off;",
      "client_max_body_size 64m;",
      "proxy_read_timeout 600s;",
      "proxy_send_timeout 600s;",
      "proxy_ssl_server_name on;",
      'proxy_ssl_name "gw.example";',
      "proxy_ssl_verify on;",
      "proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;",
      "proxy_http_version 1.1;",
      'proxy_set_header Host "gw.example";',
      "resolver 127.0.0.11 valid=30s ipv6=off;",
      "access_log off;",
    ]) {
      expect(conf).toContain(line);
    }
    expect(conf).toContain('set $upstream "https://gw.example";');
  });

  it("keeps a non-default upstream port", () => {
    install({ baseUrl: "https://gw.example:8443/v1" });
    const conf = renderModelGatewayConf(env)!;
    expect(conf).toContain('set $upstream "https://gw.example:8443";');
    expect(conf).toContain('proxy_set_header Host "gw.example:8443";');
    expect(conf).toContain('proxy_ssl_name "gw.example";');
  });

  it("listens on port 80 only", () => {
    install();
    const listens = renderModelGatewayConf(env)!.match(/^\s*listen .*$/gm)!;
    expect(listens.map((l) => l.trim())).toEqual(["listen 80;"]);
  });

  it("throws, naming the env var, when the key is missing or empty", () => {
    install();
    expect(() => renderModelGatewayConf({})).toThrow(/ACME_API_KEY/);
    expect(() => renderModelGatewayConf({ ACME_API_KEY: "" })).toThrow(/ACME_API_KEY/);
  });

  it("throws on a key value nginx would interpret, naming the var and never echoing the value", () => {
    install();
    for (const bad of ['a"b', "a\\b", "a$b", "a;b", "a{b", "a}b", "a b", "a\nb", "a\tb", "caf\u00e9"]) {
      const value = `sk-secret-${bad}`;
      let message = "";
      try {
        renderModelGatewayConf({ ACME_API_KEY: value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/ACME_API_KEY/);
      expect(message).not.toContain("sk-secret");
    }
  });

  it("throws on a header value nginx would interpret, naming the header", () => {
    // `;`, `{`, `}`, `"` and space pass the registry's header rules but would
    // break out of the nginx directive.
    for (const bad of ["a;b", "a{b", "a}b", 'a"b', "a b", "a\\b"]) {
      resetProviderRegistry();
      install({ headers: { "x-flag": bad } });
      expect(() => renderModelGatewayConf(env)).toThrow(/providers\.acme\.headers\.x-flag/);
    }
  });

  it("renders nothing without a gateway provider", () => {
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1" } });
    expect(renderModelGatewayConf(env)).toBeUndefined();
  });

  it("writer: 0600 file in <stateDir>/proxy", () => {
    install();
    const stateDir = mkdtempSync(join(tmpdir(), "ll-gw-"));
    const path = writeModelGatewayConfig(stateDir, env)!;
    expect(path).toBe(join(stateDir, "proxy", "model-gateway.conf"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("writer: tightens an existing file's mode to 0600", () => {
    install();
    const stateDir = mkdtempSync(join(tmpdir(), "ll-gw-"));
    mkdirSync(join(stateDir, "proxy"));
    writeFileSync(join(stateDir, "proxy", "model-gateway.conf"), "old", { mode: 0o644 });
    const path = writeModelGatewayConfig(stateDir, env)!;
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("writer: removes a stale model-gateway.conf when no provider uses the gateway", () => {
    install();
    const stateDir = mkdtempSync(join(tmpdir(), "ll-gw-"));
    const path = writeModelGatewayConfig(stateDir, env)!;
    resetProviderRegistry();
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1" } });
    expect(writeModelGatewayConfig(stateDir, env)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });
});
