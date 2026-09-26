/**
 * Per-run command policy: allow, log or block classes of bash command
 * (lastlight#403).
 *
 * Review-pipeline agents installed dependencies and ran test suites in phases
 * that have no budget for it and should not execute code at all — 71 install or
 * test calls over 32 case-runs, all but 2 outside the one phase built to execute
 * code. The orchestrator knows which phase may do what; this module lets it say
 * so per run: `{ install: "block", test: "log" }`.
 *
 * A pattern guard, NOT a security boundary. `sh -c "$(…)"`, a script file, or a
 * package.json script under another name gets past it. It stops the habitual
 * behaviour; the sandbox and egress policy remain the boundary, and `log` mode
 * is what tells us whether evasion happens in practice.
 *
 * Deliberately dependency-free (node:path only) so a host can import the env
 * name and the parser without pulling in the agent runtime — the same reason
 * `providers.ts` is.
 */

import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * The env var the policy travels on to a run inside a container, where the
 * orchestrator controls the environment rather than the flags. Imported by
 * Last Light rather than repeated as a literal.
 */
export const COMMAND_POLICY_ENV = "AGENTIC_PI_COMMAND_POLICY";

/**
 * `host` (lastlight#404) is the one class about WHERE a command looks rather
 * than what it runs: a bash call reaching outside the agent's workspace — a
 * scan rooted at `/` or `~`, a read of a global install or package-manager
 * cache, a `PATH` pointing outside, a `require` of an outside absolute path.
 */
export const COMMAND_CLASSES = ["install", "install-scratch", "test", "host"] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];

export const COMMAND_POLICY_MODES = ["allow", "log", "block"] as const;
export type CommandPolicyMode = (typeof COMMAND_POLICY_MODES)[number];

/**
 * One mode per class; an absent class is `allow`, except `install-scratch`,
 * which falls back to `install` — so `{ install: block }` blocks every install
 * and only a caller that means to let scratch-dir installs through has to say
 * so. `reason` replaces the model-facing text a blocked call returns.
 */
export type CommandPolicy = Partial<Record<CommandClass, CommandPolicyMode>> & { reason?: string };

/**
 * Parse the `--command-policy` flag / `AGENTIC_PI_COMMAND_POLICY` env value.
 * Throws on an unknown class or mode: a typo that silently allowed everything
 * would look exactly like a policy that is working.
 */
export function parseCommandPolicy(raw: string, label: string): CommandPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} must be JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateCommandPolicy(parsed, label);
}

export function validateCommandPolicy(value: unknown, label: string): CommandPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object of class → ${COMMAND_POLICY_MODES.join("|")}`);
  }
  const out: CommandPolicy = {};
  for (const [key, mode] of Object.entries(value as Record<string, unknown>)) {
    if (key === "reason") {
      if (typeof mode !== "string" || !mode.trim()) throw new Error(`${label}.reason must be a non-empty string`);
      out.reason = mode;
      continue;
    }
    if (!(COMMAND_CLASSES as readonly string[]).includes(key)) {
      throw new Error(`${label}: unknown command class '${key}' (expected ${COMMAND_CLASSES.join(", ")})`);
    }
    if (!(COMMAND_POLICY_MODES as readonly string[]).includes(mode as string)) {
      throw new Error(`${label}.${key} must be one of ${COMMAND_POLICY_MODES.join("|")} (got ${JSON.stringify(mode)})`);
    }
    out[key as CommandClass] = mode as CommandPolicyMode;
  }
  return out;
}

export function modeFor(policy: CommandPolicy, cls: CommandClass): CommandPolicyMode {
  if (cls === "install-scratch") return policy["install-scratch"] ?? policy.install ?? "allow";
  return policy[cls] ?? "allow";
}

// ── Pattern table ─────────────────────────────────────────────────────

// Package-manager verbs may follow flags (`pnpm --filter pkg test`,
// `npm --prefix dir ci`). Lazy, so backtracking hands the verb its word back.
const F = String.raw`(?: --?[\w-]+(?:[= ](?!-)\S+)?)*?`;
const PM = `(?:npm|pnpm|yarn|bun)`;
// Language-level runners that wrap the real command.
const W = `(?:(?:uv|poetry|pipenv|pdm|hatch) run${F} |bundle exec${F} )?`;
// A bin path prefix, for `node_modules/.bin/vitest` or `vendor/bin/phpunit`.
const BIN = String.raw`(?:\S*/)?`;
const PY = String.raw`python(?:3(?:\.\d+)?)?`;

interface Rule {
  cls: "install" | "test";
  id: string;
  re: RegExp;
}

const rule = (cls: Rule["cls"], id: string, src: string): Rule => ({ cls, id, re: new RegExp(`^(?:${src})`) });

/**
 * Every pattern is anchored at the start of one normalised command segment
 * (see {@link classifyCommand}), so a pattern word inside an argument
 * (`echo "run npm test later"`, `grep -r pytest .`) never matches.
 */
export const COMMAND_RULES: readonly Rule[] = [
  // ── install ──
  rule(
    "install",
    "js-install",
    String.raw`${PM}${F} (?:install|i|isntall|ci|clean-install|add|it|install-test|cit|install-ci-test)\b`,
  ),
  // Bare `yarn` IS an install; `yarn --version` is not.
  rule(
    "install",
    "yarn-bare",
    `yarn(?: --(?:frozen-lockfile|immutable|pure-lockfile|prefer-offline|offline|ignore-scripts|silent))*$`,
  ),
  rule("install", "js-dlx", String.raw`(?:(?:pnpm|yarn)${F} dlx|bunx|bun${F} x)\b`),
  // `npx` only FETCHES when told to or given a version; `npx vitest` in an
  // installed tree is a test run (below), not an install.
  rule("install", "npx-fetch", String.raw`npx\b.*(?: -y\b| --yes\b| -p\b| --package\b| (?:@[\w.-]+/)?[\w.-]+@(?:[\d^~<>=*]|latest\b|next\b))`),
  rule("install", "pip-install", String.raw`(?:pip3?|${PY} -m pip|uv pip)${F} install\b`),
  rule("install", "uv-sync", String.raw`uv${F} (?:add|sync)\b`),
  rule("install", "poetry-install", String.raw`(?:poetry${F} (?:install|add)|pipenv${F} install|pdm${F} (?:install|add|sync))\b`),
  rule("install", "conda-install", String.raw`(?:conda|mamba|micromamba)${F} install\b`),
  rule("install", "ruby-install", String.raw`(?:bundle${F} install|gem${F} install)\b`),
  rule("install", "cargo-install", String.raw`cargo${F} (?:install|fetch|add)\b`),
  rule("install", "go-install", String.raw`go${F} (?:get|install|mod download)\b`),
  rule("install", "composer-install", String.raw`composer${F} (?:install|require|update)\b`),
  rule("install", "dotnet-restore", String.raw`(?:dotnet${F} (?:restore|add${F} package)|nuget${F} install)\b`),
  rule("install", "maven-install", String.raw`(?:mvn|\./mvnw)\b.* (?:install|dependency:\S+)\b`),
  rule("install", "gradle-refresh", String.raw`(?:gradle|\./gradlew)\b.* --refresh-dependencies\b`),
  rule("install", "system-install", String.raw`(?:apt-get|apt|yum|dnf|apk|brew)${F} (?:install|add)\b`),
  // ── test ──
  // `npm test`, `npm it`, and the project-gate scripts: `run test*`, `run lint*`,
  // `run typecheck*`. The measured habit is re-creating CI by hand
  // (`npm run lint:check && npm test`), and the answer is the same for all of
  // them: cite CI. A direct `eslint file.ts` or `tsc` stays unmatched — a
  // targeted check, not the suite.
  rule("test", "js-test", String.raw`${PM}${F} (?:test|t|tst|it|install-test|cit|install-ci-test)\b`),
  rule(
    "test",
    "js-run-gate",
    String.raw`(?:${PM}${F} run(?:-script)?|pnpm|yarn)${F} (?:test|lint|typecheck|type-check|check)(?:[:\w-]*)(?!\S)`,
  ),
  rule("test", "turbo-gate", String.raw`(?:(?:npx|pnpm|yarn)${F} )?turbo${F} (?:run${F} )?(?:test|lint|typecheck|check)\b`),
  rule(
    "test",
    "js-runner",
    String.raw`(?:(?:npx|pnpm${F} exec|yarn${F} exec|bunx|bun${F} x|pnpm|yarn)${F} )?${BIN}(?:vitest|jest|mocha|ava|tap|karma|jasmine|playwright test|cypress run)\b`,
  ),
  rule("test", "node-test", String.raw`(?:node|tsx|bun)${F} --test(?![\w-])`),
  rule(
    "test",
    "python-test",
    String.raw`${W}(?:${BIN}(?:pytest|py\.test|tox|nox)\b|${PY}${F} -m (?:pytest|unittest)\b)`,
  ),
  rule("test", "go-test", String.raw`go${F} test\b`),
  rule("test", "cargo-test", String.raw`cargo${F} (?:test|nextest|t)\b`),
  rule("test", "maven-test", String.raw`(?:mvn|\./mvnw)\b.* (?:test|verify|install)\b`),
  rule("test", "gradle-test", String.raw`(?:gradle|\./gradlew)\b.* (?:test|check)\b`),
  rule("test", "ruby-test", String.raw`${W}(?:${BIN}rspec|rake (?:test|spec)|rails test)\b`),
  rule("test", "php-test", String.raw`(?:${BIN}(?:phpunit|pest)|composer${F} test)\b`),
  rule("test", "dotnet-test", String.raw`dotnet${F} test\b`),
  rule("test", "make-test", String.raw`make${F} (?:test|check)\b`),
];

// ── Normalisation ─────────────────────────────────────────────────────

/**
 * Split a shell command into segments on `&&`, `||`, `;`, `|`, `&` and
 * newlines, outside quotes. `>&` / `&>` / `<&` are redirections, not
 * separators.
 */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < command.length) {
        cur += c + command[++i];
        continue;
      }
      if (c === quote) quote = undefined;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      // A backslash-newline is a line continuation, not a separator.
      cur += command[i + 1] === "\n" ? " " : c + command[i + 1];
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const prev = command[i - 1];
    const next = command[i + 1];
    const redirect = c === "&" && (prev === ">" || prev === "<" || next === ">");
    if (c === "\n" || c === ";" || c === "|" || (c === "&" && !redirect)) {
      out.push(cur);
      cur = "";
      if ((c === "|" || c === "&") && next === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const unquote = (w: string): string => w.replace(/^(['"])(.*)\1$/, "$2");

/**
 * Strip the wrappers that do not change WHAT runs: subshell / group openers,
 * env assignments, `env`, `timeout`, `time`, `nice`, `nohup`, `sudo`,
 * `command`, `exec`.
 */
export function stripPrefixes(words: string[]): string[] {
  const w = words.slice();
  const takeFlags = (withValue: RegExp = /^$/) => {
    while (w[0]?.startsWith("-")) {
      const flag = w.shift()!;
      if (withValue.test(flag) && !flag.includes("=")) w.shift();
    }
  };
  for (;;) {
    while (w[0] === "(" || w[0] === "{" || w[0] === "!") w.shift();
    if (w[0] && /^[({!]./.test(w[0])) {
      w[0] = w[0].slice(1);
      continue;
    }
    const head = w[0];
    if (head === undefined) return w;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      w.shift();
      continue;
    }
    if (head === "env") {
      w.shift();
      takeFlags(/^-(?:u|C|S)$|^--(?:unset|chdir|split-string)$/);
      continue;
    }
    if (head === "timeout") {
      w.shift();
      takeFlags(/^-(?:s|k)$|^--(?:signal|kill-after)$/);
      if (w[0] && /^\d/.test(w[0])) w.shift();
      continue;
    }
    if (head === "time" || head === "nohup" || head === "command" || head === "exec") {
      w.shift();
      takeFlags();
      continue;
    }
    if (head === "nice") {
      w.shift();
      takeFlags(/^-n$|^--adjustment$/);
      continue;
    }
    if (head === "sudo") {
      w.shift();
      takeFlags(/^-(?:u|g|C|D|h|p|r|t|U)$/);
      continue;
    }
    return w;
  }
}

// ── Classification ────────────────────────────────────────────────────

export interface CommandMatch {
  cls: CommandClass;
  /** The rule id that matched, e.g. `js-install` or `python-test`. */
  pattern: string;
  /** The normalised segment it matched in. */
  segment: string;
}

// Flags that point an install somewhere other than the current directory.
const INSTALL_DIR_FLAGS = /^(?:--prefix|-C|--dir|--cwd|--target|--root)$/;
const INSTALL_DIR_FLAG_EQ = /^(?:--prefix|--dir|--cwd|--target|--root)=(.+)$/;
const INSTALL_GLOBAL_FLAGS = /^(?:-g|--global|--user|--location=global)$/;

const HOME = "\0home";

/** True when `dir` is outside `root` (the agent's checkout). */
function isOutside(dir: string, root: string): boolean {
  if (dir.startsWith(HOME)) return true;
  const rel = relative(root, dir);
  return rel.startsWith("..") || isAbsolute(rel);
}

function resolveDir(from: string, arg: string | undefined): string | undefined {
  if (arg === undefined || arg === "~" || arg.startsWith("~/")) return HOME;
  // `cd -`, `cd "$DIR"`: unknowable — keep the current directory, which errs
  // toward treating an install as a repo install.
  if (arg === "-" || arg.includes("$") || arg.includes("`")) return undefined;
  if (from.startsWith(HOME)) return isAbsolute(arg) ? resolve(arg) : from;
  return resolve(from, arg);
}

// ── host: reaching outside the workspace (lastlight#404) ─────────────
//
// Measured on the martian `oc-survey-glmf` arm, once #403 stopped installs: an
// agent that cannot import a dependency goes looking for one on the machine —
// `find / -type d -name dayjs`, `ls ~/.nvm/versions/node/<v>/lib/node_modules/`,
// `export PATH=".../lastlight/node_modules/.bin:$PATH"`, `find / -name SKILL.md`.
// A dependency found there is not the version the PR pins, and whole-disk scans
// are the unbudgeted CPU #403 exists to stop.

/**
 * Scratch space is never `host`: probes legitimately write to `/tmp`, and
 * `install-scratch` already governs installs into it. `/var/folders` is where
 * macOS puts `os.tmpdir()`.
 */
const SCRATCH_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/var/folders", "/private/var/folders"];

/** System bin dirs a `PATH=` may name without borrowing anyone's installs. */
const SYSTEM_BIN = new Set(["/bin", "/usr/bin", "/sbin", "/usr/sbin"]);

// Lookahead for "end of this path component".
const END = String.raw`(?=[/\s'":)]|$)`;
/**
 * Known host locations where installed packages live: version-manager trees,
 * package-manager caches, global prefixes. A reference to one in any argument
 * is `host`, whatever the command. `/opt/lastlight` is exempt — the harness's
 * own install, where the images put `lastlight-facts`.
 */
const HOST_LOCATION = new RegExp(
  String.raw`(?:^|[\s=:'"(])(?:` +
    String.raw`(?:~|\$HOME|\$\{HOME\}|/(?:home|Users)/[^/\s'"]+|/root)/\.(?:nvm|npm|cache|yarn|pnpm-store|volta|bun|local/share/pnpm)${END}` +
    `|/usr/(?:local/)?lib/node_modules${END}` +
    `|/opt(?!/lastlight(?:/|$))${END}` +
    ")",
);

/** Commands that walk or list a tree — `host` when rooted outside the workspace. */
const SCAN_COMMANDS = new Set(["find", "ls", "du", "tree", "grep", "egrep", "fgrep", "rgrep", "rg"]);

// Flags whose NEXT word is a value, not an operand.
const GREP_VALUE_SHORT = "efmABCdD";
const GREP_VALUE_LONG =
  /^--(?:regexp|file|include|exclude|exclude-dir|max-count|context|after-context|before-context|devices|directories)$/;
const RG_VALUE_SHORT = "efgtTmABCjMdE";
const RG_VALUE_LONG =
  /^--(?:regexp|file|glob|iglob|type|type-not|type-add|max-count|context|after-context|before-context|threads|max-depth|max-filesize|sort|sortr|color|colors|encoding|replace)$/;

/** Drop shell redirections (`2>/dev/null`, `> out`, `2>&1`) — they are not operands. */
function dropRedirections(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/^(?:\d*|&)(?:>>?|<<?)&?$/.test(w)) {
      i++;
      continue;
    }
    if (/^(?:\d*|&)(?:>>?|<<?)/.test(w)) continue;
    out.push(w);
  }
  return out;
}

/** The path operands of a scan command (default `.`), or `[]` for a non-recursive grep. */
function scanRoots(head: string, args: string[]): string[] {
  if (head === "find") {
    let i = 0;
    while (args[i] && /^-(?:[HLP]|O\d|D)$/.test(args[i]!)) i += args[i] === "-D" ? 2 : 1;
    const roots: string[] = [];
    // Roots end at the first expression token: `-name`, `(`, `\(`, `!`.
    for (; i < args.length && !/^(?:-|\(|!|\\\()/.test(args[i]!); i++) roots.push(args[i]!);
    return roots.length ? roots : ["."];
  }
  if (head === "ls" || head === "du" || head === "tree") {
    const roots = args.filter((a) => !a.startsWith("-"));
    return roots.length ? roots : ["."];
  }
  // grep family and rg: the first operand is the pattern unless -e/-f gave it.
  const rg = head === "rg";
  const valueShort = rg ? RG_VALUE_SHORT : GREP_VALUE_SHORT;
  const valueLong = rg ? RG_VALUE_LONG : GREP_VALUE_LONG;
  let recursive = rg || head === "rgrep";
  let patternGiven = false;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (/^--(?:recursive|dereference-recursive)$/.test(a)) recursive = true;
      if (/^--(?:regexp|file)(?:=|$)/.test(a) || (rg && a === "--files")) patternGiven = true;
      if (valueLong.test(a)) i++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const cluster = a.slice(1);
      if (!rg && /[rR]/.test(cluster)) recursive = true;
      if (/[ef]/.test(cluster)) patternGiven = true;
      if (valueShort.includes(cluster[cluster.length - 1]!)) i++;
      continue;
    }
    operands.push(a);
  }
  if (!recursive) return [];
  const paths = patternGiven ? operands : operands.slice(1);
  return paths.length ? paths : ["."];
}

/**
 * Resolve a path operand for the host test: `~`, `$HOME` and `${HOME}` are the
 * home dir; any other expansion is unknowable (`undefined`, left alone).
 */
function resolvePath(from: string, arg: string): string | undefined {
  if (/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.test(arg)) return HOME;
  if (arg.includes("$") || arg.includes("`")) return undefined;
  return resolveDir(from, arg);
}

/** Scratch space, plus the harness's own install in the images (`lastlight-facts`). */
const EXEMPT_ROOTS = [...SCRATCH_ROOTS, "/opt/lastlight"];

function isExempt(p: string): boolean {
  return !p.startsWith(HOME) && EXEMPT_ROOTS.some((r) => p === r || p.startsWith(`${r}/`));
}

/** True when a resolved path is outside the host root and not exempt. */
function reachesHost(p: string | undefined, hostRoot: string): boolean {
  return p !== undefined && !isExempt(p) && isOutside(p, hostRoot);
}

const REQUIRE_SPEC = /(?:\brequire(?:\.resolve)?\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)(['"`])([^'"`]+)\1/g;

/**
 * The `host` rule a segment matches, if any. `rawWords` still carries the
 * leading env assignments (`PATH=… cmd`) that {@link stripPrefixes} removes.
 */
function hostPattern(
  rawWords: string[],
  words: string[],
  segment: string,
  dir: string,
  hostRoot: string,
): string | undefined {
  // PATH / NODE_PATH naming a directory outside the workspace — a prefix
  // assignment, an `export`, or an `env` argument alike.
  for (const w of rawWords) {
    const m = /^(?:PATH|NODE_PATH)=(.*)$/.exec(w);
    if (!m) continue;
    for (const entry of unquote(m[1]!).split(":")) {
      if (!entry || /^\$(?:\{?(?:PATH|NODE_PATH)\}?)$/.test(entry) || SYSTEM_BIN.has(entry)) continue;
      if (reachesHost(resolvePath(dir, entry), hostRoot)) return "host-path";
    }
  }
  const head = words[0]!;
  const args = dropRedirections(words.slice(1));
  // The head is exempt: running a binary by absolute path
  // (`/opt/lastlight/bin/lastlight-facts`) is not a read of that location.
  if (args.some((a) => HOST_LOCATION.test(a))) return "host-location";
  if (SCAN_COMMANDS.has(head)) {
    for (const root of scanRoots(head, args)) {
      if (reachesHost(resolvePath(dir, root), hostRoot)) return "host-scan";
    }
  }
  if (/^(?:node|nodejs|tsx|bun|deno)$/.test(head.replace(/^.*\//, ""))) {
    for (const m of segment.matchAll(REQUIRE_SPEC)) {
      const spec = m[2]!.replace(/^file:\/\//, "");
      if (!/^(?:\/|~|\.\.?\/|\$HOME\b|\$\{HOME\})/.test(spec)) continue; // a bare package name
      if (reachesHost(resolvePath(dir, spec), hostRoot)) return "host-require";
    }
  }
  return undefined;
}

export interface ClassifyOptions {
  /**
   * What the `host` class measures "outside the workspace" against. Default:
   * the cwd's parent — on docker and `none` that is the workspace root, where
   * the skill bundle (`.lastlight-skills/`) and `AGENTS.md` are staged beside
   * the checkout, so they stay reachable. Under gondolin only the checkout is
   * mounted (the bundle is staged inside it), so the runner passes the guest
   * mount itself.
   */
  hostRoot?: string;
}

/**
 * Every class a bash command matches, segment by segment. An install whose
 * effective directory — the `cd` chain before it, or a `--prefix`/`-C`/`--dir`
 * flag, or a global install — lies outside `cwd` is `install-scratch`: the
 * `npm install fastify@5` in `/tmp/probe` a probe may legitimately need,
 * which a repo-root `npm ci` is not. A segment that reaches outside
 * {@link ClassifyOptions.hostRoot} — scratch dirs excepted — is `host`.
 */
export function classifyCommand(command: string, cwd: string, options: ClassifyOptions = {}): CommandMatch[] {
  const root = resolve(cwd);
  const hostRoot = resolve(options.hostRoot ?? dirname(root));
  let dir = root;
  const matches: CommandMatch[] = [];
  const add = (cls: CommandClass, pattern: string, segment: string) => {
    if (!matches.some((m) => m.cls === cls && m.segment === segment)) matches.push({ cls, pattern, segment });
  };
  for (const raw of splitSegments(command)) {
    const rawWords = raw.split(/\s+/).filter(Boolean);
    const words = stripPrefixes(rawWords).map(unquote);
    if (words.length === 0) continue;
    const segment = words.join(" ");
    const host = hostPattern(rawWords, words, segment, dir, hostRoot);
    if (words[0] === "cd" || words[0] === "pushd") {
      if (host) add("host", host, segment);
      const args = words.slice(1).filter((a) => !a.startsWith("-") || a === "-");
      dir = resolveDir(dir, args[0]) ?? dir;
      continue;
    }
    for (const r of COMMAND_RULES) {
      if (!r.re.test(segment)) continue;
      let cls: CommandClass = r.cls;
      if (cls === "install") {
        let target = dir;
        for (let i = 1; i < words.length; i++) {
          const w = words[i]!;
          if (INSTALL_GLOBAL_FLAGS.test(w)) target = HOME;
          const eq = INSTALL_DIR_FLAG_EQ.exec(w);
          if (eq) target = resolveDir(dir, eq[1]) ?? target;
          else if (INSTALL_DIR_FLAGS.test(w)) target = resolveDir(dir, words[i + 1]) ?? target;
        }
        if (isOutside(target, root)) cls = "install-scratch";
      }
      add(cls, r.id, segment);
    }
    if (host) add("host", host, segment);
  }
  return matches;
}

/** What a blocked install/test call returns when the caller configured no `reason`. */
export const DEFAULT_BLOCK_REASON =
  "This run does not install dependencies or run test suites. Use existing CI results, or state what " +
  "you would need to run and why.";

/** What a blocked `host` call returns when the caller configured no `reason`. */
export const DEFAULT_HOST_BLOCK_REASON =
  "This run stays inside its workspace: do not search or read the rest of the machine (/, ~, global " +
  "installs, package-manager caches) or point PATH outside it. If what you need is not in the workspace, " +
  "treat it as unavailable and say so; do not keep searching.";

export interface CommandPolicyDecision {
  action: "allow" | "log" | "block";
  /** Matches whose class is not `allow` — what the decision is about. */
  matches: CommandMatch[];
  /** Model-facing text for a blocked call. */
  reason?: string;
}

/** Decide one bash call: blocked if ANY matched class blocks, logged if any logs. */
export function decideCommand(
  policy: CommandPolicy,
  command: string,
  cwd: string,
  options: ClassifyOptions = {},
): CommandPolicyDecision {
  const matches = classifyCommand(command, cwd, options).filter((m) => modeFor(policy, m.cls) !== "allow");
  if (matches.length === 0) return { action: "allow", matches };
  const blocked = matches.filter((m) => modeFor(policy, m.cls) === "block");
  if (blocked.length === 0) return { action: "log", matches };
  const classes = [...new Set(blocked.map((m) => m.cls))];
  const defaults = [
    ...(classes.some((c) => c !== "host") ? [DEFAULT_BLOCK_REASON] : []),
    ...(classes.includes("host") ? [DEFAULT_HOST_BLOCK_REASON] : []),
  ].join(" ");
  return {
    action: "block",
    matches,
    reason: `Blocked by this phase's command policy (${classes.join(", ")}). ${policy.reason ?? defaults}`,
  };
}
