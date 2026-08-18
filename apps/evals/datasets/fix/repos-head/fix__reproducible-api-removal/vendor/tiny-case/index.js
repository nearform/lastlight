// tiny-case@3.0.0 — `kebab` was renamed to `kebabCase` in 3.0.0.
export function kebabCase(input) {
  return String(input).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
