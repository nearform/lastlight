// tiny-case@2.4.0
export function kebab(input) {
  return String(input).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
