/**
 * Single source of truth for sandbox HTTP egress allowlists.
 *
 * Both sandbox backends consume this list:
 *   - gondolin: passed verbatim to `agenticRun({ allowedHttpHosts })` so the
 *     QEMU-layer HTTP interceptor 502s anything off-list.
 *   - docker: nginx-egress + coredns configs are generated from these hosts
 *     at harness boot. Sandbox containers spawn with `--dns <coredns-ip>`;
 *     coredns sinkholes allowlisted hostnames to the nginx firewall IP,
 *     which peeks SNI and tunnels to the real upstream. See
 *     `src/sandbox/egress-firewall-config.ts` for the full architecture.
 *
 * The lists are intentionally split so callers can compose tighter policies
 * (e.g. a read-only profile that doesn't need package registries). The
 * everyday default is `DEFAULT_ALLOWLIST`.
 *
 * ## Wildcard syntax
 *
 * A leading dot (`.github.com`) denotes "this domain and any subdomain":
 *
 *     "api.github.com"   → matches exactly api.github.com
 *     ".github.com"      → matches github.com, api.github.com, foo.bar.github.com, …
 *
 * The leading-dot convention matches nginx's own `map` directive syntax,
 * keeps the generated configs minimal, and is unambiguous (a real hostname
 * can never start with a dot).
 *
 * A workflow phase can declare `unrestricted_egress: true` to bypass the
 * allowlist entirely — see `src/workflows` for the phase schema.
 */

/** GitHub HTTPS endpoints used by `git`, `gh`, and agentic-pi's github tools. */
export const GITHUB_HOSTS: readonly string[] = [
  // Leading dot covers github.com plus every subdomain we care about
  // (api, codeload, raw, objects, gist, …) without listing each one.
  ".github.com",
  // *.githubusercontent.com — release artifacts, raw blobs, avatars.
  ".githubusercontent.com",
];

/**
 * LLM provider hosts.
 *
 * Required for the docker backend because `agentic-pi run` executes inside
 * the sandbox container there (`src/sandbox/docker.ts` runs `agentic-pi run
 * --sandbox none`), so the LLM HTTP call originates from inside the
 * container. The gondolin backend runs agentic-pi in the harness process,
 * so the call originates from the host and these hosts aren't strictly
 * required inside the VM — they're kept here so a single allowlist can
 * cover both paths without surprises.
 */
export const PROVIDER_HOSTS: readonly string[] = [
  "api.anthropic.com",
  "api.openai.com",
  "openrouter.ai",
];

/** Public package registries the executor may hit during `npm install`, etc. */
export const PACKAGE_REGISTRY_HOSTS: readonly string[] = [
  // npm / yarn / pnpm
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // Rust
  ".crates.io",
  // Go modules
  "proxy.golang.org",
  "sum.golang.org",
  // Ruby
  "rubygems.org",
  // Alpine apk + Debian apt
  "dl-cdn.alpinelinux.org",
  "deb.debian.org",
  "security.debian.org",
];

/**
 * Combined allowlist used by both backends when a phase has not opted into
 * unrestricted egress. Order is preserved across imports so generated
 * configs are stable.
 *
 * Entries may be exact hostnames or wildcard patterns with a leading dot
 * (see the file docstring).
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  ...GITHUB_HOSTS,
  ...PROVIDER_HOSTS,
  ...PACKAGE_REGISTRY_HOSTS,
];

/**
 * Sentinel value recognized by agentic-pi/gondolin (post the `"*"` patch)
 * meaning "allow every host". Used when a phase sets `unrestricted_egress`.
 *
 * On the docker backend, unrestricted egress routes through the open
 * nginx-egress + coredns-open pair — this sentinel is for gondolin only.
 */
export const ALLOW_ALL_SENTINEL = "*";

/**
 * Returns true if `entry` is a wildcard match (leading-dot form).
 * Helper for the egress-firewall config generator.
 */
export function isWildcardHost(entry: string): boolean {
  return entry.startsWith(".");
}
