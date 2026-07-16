/**
 * `@lastlight/shared` — the light modules shared by the published `lastlight`
 * CLI and `@lastlight/core`. Node built-ins + `yaml` / `@clack/prompts` /
 * `chalk` / `@earendil-works/pi-ai` (oauth subpath) / `@lastlight/workflow-engine`
 * (workflow schema) only — no heavy runtime deps (better-sqlite3, slack,
 * octokit, hono, otel, agentic-pi) are ever reachable from here (fence F4).
 *
 * Invariant: no edge from `shared` back to `@lastlight/core`.
 *
 * `./oauth` and `./workflow-loader` are also exposed as dedicated subpaths so
 * core can keep thin re-export shims at their original file paths (preserving
 * `vi.mock` targets + module-singleton identity) without leaking the whole
 * barrel through those paths.
 */

export * from "./providers.js";
export * from "./oauth.js";
export * from "./overlay-bootstrap.js";
export * from "./overlay-assets.js";
export * from "./core-pin.js";
export * from "./workflow-loader.js";
export * from "./config-types.js";
