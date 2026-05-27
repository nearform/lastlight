// Preloaded into the sandbox `node` process via NODE_OPTIONS='--import ...'.
//
// Node 22's built-in fetch (undici) does NOT honor HTTP_PROXY / HTTPS_PROXY
// env vars by default — every HTTP client built on global fetch (the OpenAI
// SDK, the Anthropic SDK, agentic-pi) ignores them and dials direct. In a
// sandbox attached to an `internal: true` docker network, that means
// every LLM call times out with a generic "Connection error" because the
// only path off-network is via the tinyproxy sidecar.
//
// Register undici's EnvHttpProxyAgent as the global dispatcher so fetch
// reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY from the environment. This
// is the documented escape hatch for the "fetch doesn't see env proxies"
// problem and Node may surface it as a flag in a future release
// (see `node --use-env-proxy`).
//
// Only activates when HTTP_PROXY or HTTPS_PROXY is actually set, so this
// is a no-op outside the sandbox.

if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
    if (process.env.LASTLIGHT_PROXY_INIT_DEBUG) {
      console.error(`[proxy-init] EnvHttpProxyAgent installed (HTTPS_PROXY=${process.env.HTTPS_PROXY || process.env.https_proxy || "unset"})`);
    }
  } catch (err) {
    // Don't crash the process if undici isn't reachable — agentic-pi vendors
    // it as a dependency so this should always resolve, but a stricter
    // resolver setting or a stripped image would surface here.
    console.error(`[proxy-init] failed to install EnvHttpProxyAgent: ${err?.message ?? err}`);
  }
}
