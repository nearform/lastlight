/**
 * DECLARED DIRECT DEPENDENCIES, per ecosystem.
 *
 * **Why this file exists at all**, measured on the 50-case corpus: keycloak's
 * root manifest is Maven and discourse's is a Gemfile — *neither repo has a root
 * `package.json`* — so `deps` degraded outright on ~19 of 50 cases. grafana
 * (`package.json` + `go.mod`) and sentry (`package.json` + `pyproject.toml`)
 * were worse than that, because they degraded on nothing: they reported the JS
 * half and looked complete.
 *
 * **What this deliberately is NOT.** It reads what a manifest DECLARES, at the
 * version it declares. It does not resolve, does not walk a lockfile graph, does
 * not evaluate a `build.gradle`, does not expand a Maven parent POM. Per-
 * ecosystem resolution semantics is a rabbit hole with no bottom and the
 * question on the table is only *"what did this PR change?"* — which the
 * declaration answers exactly. Every parser here is regex over text, for the
 * same reason `deps.ts`'s import scan is: this must work on tier 3, where there
 * is no project and no parser for the language.
 *
 * **The scope mapping is lossy on purpose.** Every ecosystem's own vocabulary
 * (`test`, `provided`, `testImplementation`, `:development`, an extra) is folded
 * onto npm's four names so a single `changes[]` array is comparable across a PR
 * that touches `package.json` AND `go.mod` — grafana does exactly that. The
 * question the field answers is "is this a build-time dependency", and the raw
 * string answers it differently in every ecosystem.
 */
import { basename } from "node:path";
import type { DepChange, Ecosystem } from "./schema.js";

export type Scope = DepChange["scope"];

export interface Declared {
  /** As written in the manifest — `^1.2.3`, `v1.2.3`, `~> 7.0`, or `null`. */
  version: string | null;
  scope: Scope;
}

export type DeclaredMap = Map<string, Declared>;

/**
 * Which ecosystem a manifest path belongs to, by BASENAME.
 *
 * `null` for anything else, which is what scopes the diff scan: a PR touching
 * 300 files contributes only the handful whose basename is on this list.
 */
export function ecosystemOf(path: string): Ecosystem | null {
  const name = basename(path);
  if (name === "package.json") return "npm";
  if (name === "go.mod") return "go";
  if (name === "pom.xml") return "maven";
  if (name === "build.gradle" || name === "build.gradle.kts") return "gradle";
  if (name === "Gemfile" || name === "Gemfile.lock") return "bundler";
  if (name === "pyproject.toml") return "pypi";
  // `requirements-dev.txt` / `requirements/base.txt` are as common as the bare
  // spelling and identical in shape.
  if (/^requirements[\w.-]*\.txt$/.test(name)) return "pypi";
  return null;
}

/**
 * The manifests to look for at the REPO ROOT when the diff touched none.
 *
 * The root is always scanned even when untouched, because a dependency delta is
 * still worth reporting from a PR that only changed source — and because the
 * root manifest is where a non-JS repo declares everything.
 */
export const ROOT_MANIFEST_NAMES = [
  "package.json",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "Gemfile.lock",
  "pyproject.toml",
  "requirements.txt",
];

/** Parse one manifest's declared direct dependencies. `null` = unreadable. */
export function parseManifest(
  ecosystem: Ecosystem,
  raw: string | null,
  path: string,
): DeclaredMap | null {
  if (raw === null) return null;
  try {
    switch (ecosystem) {
      case "npm":
        return parseNpm(raw);
      case "go":
        return parseGoMod(raw);
      case "maven":
        return parsePom(raw);
      case "gradle":
        return parseGradle(raw);
      case "bundler":
        return basename(path) === "Gemfile.lock" ? parseGemfileLock(raw) : parseGemfile(raw);
      case "pypi":
        return basename(path) === "pyproject.toml" ? parsePyproject(raw) : parseRequirements(raw);
    }
  } catch {
    // A manifest that will not parse is INDISTINGUISHABLE from one with no
    // dependencies unless the caller is told, so this must not be `new Map()`.
    return null;
  }
}

// ── npm ──────────────────────────────────────────────────────────────────────

const NPM_SCOPES: Scope[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export function parseNpm(raw: string): DeclaredMap {
  const parsed = JSON.parse(raw) as Partial<Record<Scope, Record<string, string>>>;
  const out: DeclaredMap = new Map();
  for (const scope of NPM_SCOPES) {
    for (const [name, version] of Object.entries(parsed?.[scope] ?? {})) {
      // First scope wins: a package in both `dependencies` and `devDependencies`
      // ships, and that is the more consequential of the two readings.
      if (!out.has(name)) out.set(name, { version, scope });
    }
  }
  return out;
}

// ── go ───────────────────────────────────────────────────────────────────────

/**
 * `go.mod`. Single-line `require x v1` and the `require ( … )` block.
 *
 * `// indirect` is EXCLUDED: it is a transitive pin the toolchain wrote, not a
 * declaration this PR made, and including it turns a routine `go mod tidy` into
 * two hundred "changes" that bury the one line a human typed.
 */
export function parseGoMod(raw: string): DeclaredMap {
  const out: DeclaredMap = new Map();
  const add = (line: string): void => {
    const text = line.trim();
    if (!text || text.startsWith("//")) return;
    if (/\/\/\s*indirect\b/.test(text)) return;
    const match = /^(\S+)\s+(\S+)/.exec(text.replace(/\/\/.*$/, "").trim());
    if (!match) return;
    out.set(match[1], { version: match[2], scope: "dependencies" });
  };

  let inBlock = false;
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (inBlock) {
      if (text === ")") inBlock = false;
      else add(text);
      continue;
    }
    if (/^require\s*\($/.test(text)) {
      inBlock = true;
      continue;
    }
    if (text.startsWith("require ")) add(text.slice("require ".length));
  }
  return out;
}

// ── maven ────────────────────────────────────────────────────────────────────

/**
 * `pom.xml`. `<dependency>` → `groupId:artifactId` at `<version>`.
 *
 * `${property}` versions are resolved one level against `<properties>`, which is
 * not completeness creeping in — it is the DOMINANT Maven idiom (keycloak pins
 * essentially everything that way), and without it the `bumped` detection this
 * extractor exists for misses the exact line the PR changed.
 *
 * `<dependencyManagement>` entries are read too, and deduplicated by
 * coordinate with a version preferred over none: a version bump in a
 * multi-module build almost always lands there rather than in the module POM.
 */
export function parsePom(raw: string): DeclaredMap {
  const properties = new Map<string, string>();
  for (const block of raw.matchAll(/<properties\b[^>]*>([\s\S]*?)<\/properties>/g)) {
    for (const property of block[1].matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) {
      properties.set(property[1], property[2].trim());
    }
  }
  const expand = (value: string | null): string | null => {
    if (!value) return value;
    return value.replace(/\$\{([\w.-]+)\}/g, (whole, key: string) => properties.get(key) ?? whole);
  };

  const out: DeclaredMap = new Map();
  for (const dependency of raw.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g)) {
    const body = dependency[1];
    const tag = (name: string): string | null =>
      new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1].trim() ?? null;
    const group = tag("groupId");
    const artifact = tag("artifactId");
    if (!group || !artifact) continue;
    const name = `${group}:${artifact}`;
    const version = expand(tag("version"));
    const scope = mavenScope(tag("scope"));
    const existing = out.get(name);
    if (existing && existing.version && !version) continue;
    out.set(name, { version, scope });
  }
  return out;
}

function mavenScope(scope: string | null): Scope {
  if (scope === "test" || scope === "provided") return "devDependencies";
  if (scope === "runtime" || scope === "compile" || scope === null) return "dependencies";
  if (scope === "import") return "peerDependencies";
  return "dependencies";
}

// ── gradle ───────────────────────────────────────────────────────────────────

const GRADLE_CONFIGURATIONS =
  /^\s*(\w+)\s*[( ]\s*['"]([^'"\s]+:[^'"\s:]+(?::[^'"\s]+)?)['"]/;

/**
 * `build.gradle` / `build.gradle.kts` — `implementation("g:a:1.2")` and its
 * dozen spellings.
 *
 * Groovy and Kotlin DSL, quoted-coordinate form only. A version-catalog
 * reference (`implementation(libs.foo.bar)`) carries no version HERE — the
 * version lives in `gradle/libs.versions.toml` — so it is deliberately not
 * reported rather than reported with a wrong version: this file's contract is
 * "declared version", and `libs.foo.bar` is not one.
 */
export function parseGradle(raw: string): DeclaredMap {
  const out: DeclaredMap = new Map();
  for (const line of raw.split("\n")) {
    const match = GRADLE_CONFIGURATIONS.exec(line.replace(/\/\/.*$/, ""));
    if (!match) continue;
    const configuration = match[1];
    if (!/implementation|api|compileOnly|runtimeOnly|annotationProcessor|kapt|ksp|classpath|compile$|runtime$/i.test(configuration)) {
      continue;
    }
    const parts = match[2].split(":");
    if (parts.length < 2) continue;
    const name = `${parts[0]}:${parts[1]}`;
    const version = parts[2] ?? null;
    const scope: Scope = /test|androidTest/i.test(configuration)
      ? "devDependencies"
      : /compileOnly|provided/i.test(configuration)
        ? "peerDependencies"
        : "dependencies";
    const existing = out.get(name);
    if (existing && existing.version && !version) continue;
    out.set(name, { version, scope });
  }
  return out;
}

// ── bundler ──────────────────────────────────────────────────────────────────

/** `Gemfile` — `gem "rails", "~> 7.0"`, with `group :development do … end`. */
export function parseGemfile(raw: string): DeclaredMap {
  const out: DeclaredMap = new Map();
  const groups: string[] = [];
  for (const line of raw.split("\n")) {
    const text = line.replace(/#.*$/, "").trim();
    const group = /^group\s+(.+?)\s+do\b/.exec(text);
    if (group) {
      groups.push(group[1]);
      continue;
    }
    if (text === "end" && groups.length > 0) {
      groups.pop();
      continue;
    }
    const gem = /^gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?(.*)$/.exec(text);
    if (!gem) continue;
    const inline = /:group\s*=>\s*(.+)$|group:\s*(.+)$/.exec(gem[3] ?? "");
    const context = `${groups.join(",")},${inline?.[1] ?? inline?.[2] ?? ""}`;
    out.set(gem[1], {
      version: gem[2] ?? null,
      scope: /:?\b(development|test)\b/.test(context) ? "devDependencies" : "dependencies",
    });
  }
  return out;
}

/**
 * `Gemfile.lock` — the `DEPENDENCIES` section is the DIRECT set (the `GEM
 * specs:` tree above it is the resolved graph, transitives and all), and the
 * resolved version is looked up in that tree because the `DEPENDENCIES` entry
 * carries only a constraint, if anything.
 */
export function parseGemfileLock(raw: string): DeclaredMap {
  const resolved = new Map<string, string>();
  for (const spec of raw.matchAll(/^ {4}(\S+) \(([^)]+)\)$/gm)) resolved.set(spec[1], spec[2]);

  const out: DeclaredMap = new Map();
  const section = /^DEPENDENCIES$\n([\s\S]*?)(?:\n\n|$)/m.exec(raw);
  for (const line of (section?.[1] ?? "").split("\n")) {
    const match = /^\s{2}(\S+?)(!)?(?: \(([^)]+)\))?$/.exec(line);
    if (!match) continue;
    out.set(match[1], {
      version: resolved.get(match[1]) ?? match[3] ?? null,
      scope: "dependencies",
    });
  }
  return out;
}

// ── python ───────────────────────────────────────────────────────────────────

/** `foo[extra] >= 1.0, <2 ; python_version<"3.9"` → name `foo`, version the rest. */
export function parseRequirement(text: string): { name: string; version: string | null } | null {
  const body = text.split(";")[0].trim();
  const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(body);
  if (!match || !match[1]) return null;
  const version = match[2].trim();
  return { name: match[1], version: version.length > 0 ? version : null };
}

/**
 * `pyproject.toml`. PEP 621 (`[project]`), PEP 735 (`[dependency-groups]`) and
 * Poetry, because all three are live in the corpus. Regex over the sections
 * rather than a TOML parser — one more dependency on the CLI's install to read
 * two array shapes.
 */
export function parsePyproject(raw: string): DeclaredMap {
  const out: DeclaredMap = new Map();
  const put = (name: string, version: string | null, scope: Scope): void => {
    if (name.toLowerCase() === "python") return; // the interpreter, not a dep
    if (!out.has(name)) out.set(name, { version, scope });
  };

  for (const [header, body] of sections(raw)) {
    const isProject = header === "project";
    const isOptional = header === "project.optional-dependencies";
    const isGroups = header === "dependency-groups";
    const poetryMain = header === "tool.poetry.dependencies";
    const poetryGroup = /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(header);

    if (isProject || isOptional || isGroups) {
      // `dependencies = ["a>=1", "b"]`, or `dev = [...]` under a group table.
      for (const array of body.matchAll(/^[ \t]*([\w.-]+)[ \t]*=[ \t]*\[/gm)) {
        if (isProject && array[1] !== "dependencies") continue;
        const scope: Scope = isProject
          ? "dependencies"
          : isOptional
            ? "optionalDependencies"
            : "devDependencies";
        const open = array.index + array[0].length - 1;
        for (const item of body.slice(open, closingBracket(body, open)).matchAll(/["']([^"']+)["']/g)) {
          const requirement = parseRequirement(item[1]);
          if (requirement) put(requirement.name, requirement.version, scope);
        }
      }
      continue;
    }

    if (poetryMain || poetryGroup) {
      const scope: Scope = poetryMain ? "dependencies" : "devDependencies";
      for (const entry of body.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*(.+)$/gm)) {
        const value = entry[2].trim();
        const version = /^["']([^"']*)["']/.exec(value)?.[1] ?? extractTableVersion(value);
        put(entry[1], version, scope);
      }
    }
  }
  return out;
}

/**
 * The index just past the `]` that closes the `[` at `open`, tracking depth.
 *
 * A lazy `[\s\S]*?\]` stops at the FIRST `]`, and `"psycopg[binary]>=3"` — the
 * PEP 508 extras syntax, which is everywhere — puts one inside the first
 * string. That truncated the array mid-token, produced no parseable
 * requirement, and dropped the dependency silently.
 */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i + 1;
  }
  return text.length;
}

/** `{ version = "^1.2", optional = true }` — the inline-table Poetry form. */
function extractTableVersion(value: string): string | null {
  return /version\s*=\s*["']([^"']*)["']/.exec(value)?.[1] ?? null;
}

/** `[header]` … up to the next `[`-at-column-0. */
function* sections(raw: string): Generator<[string, string]> {
  const headers = [...raw.matchAll(/^\[([^\]]+)\]\s*$/gm)];
  for (let i = 0; i < headers.length; i++) {
    const from = headers[i].index + headers[i][0].length;
    const to = i + 1 < headers.length ? headers[i + 1].index : raw.length;
    yield [headers[i][1].trim(), raw.slice(from, to)];
  }
}

/** `requirements.txt`. `-r other.txt` and `-e .` are not declarations. */
export function parseRequirements(raw: string): DeclaredMap {
  const out: DeclaredMap = new Map();
  for (const line of raw.split("\n")) {
    const text = line.replace(/\s+#.*$/, "").trim();
    if (!text || text.startsWith("#") || text.startsWith("-")) continue;
    const requirement = parseRequirement(text);
    if (requirement) out.set(requirement.name, { version: requirement.version, scope: "dependencies" });
  }
  return out;
}
