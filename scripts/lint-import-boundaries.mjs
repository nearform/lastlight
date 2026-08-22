#!/usr/bin/env node
/**
 * The package boundary gate — what dependency-cruiser used to enforce.
 *
 * dependency-cruiser was dropped when the workspace moved to TypeScript 7: it
 * refuses to parse TS >= 7 ("Support for typescript@>=7 will follow when its
 * API is published and stable") and, worse, it says so on stderr and then
 * EXITS 0. A gate that cannot see the sources but still reports success is
 * worse than no gate, because the green tick is a lie.
 *
 * These three rules only ever looked at module specifiers, never at types, so
 * they need no compiler API at all — which also means this script does not bind
 * to TS 7's explicitly-unstable API surface the way lint-floating-promises.mjs
 * has to.
 *
 *   node scripts/lint-import-boundaries.mjs server
 *   node scripts/lint-import-boundaries.mjs engine
 *   node scripts/lint-import-boundaries.mjs code-facts
 *   node scripts/lint-import-boundaries.mjs cli
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RULE_SETS = {
  server: {
    root: join(repoRoot, "apps/server/src"),
    rules: [
      {
        name: "engine-barrel-only",
        // The engine is a package; its export surface is the contract. Reach
        // past the barrel into dist/core|ports and the contract stops meaning
        // anything.
        test: (spec) => /^lastlight-workflow-engine\/dist\/(core|ports)\//.test(spec),
        message:
          "import lastlight-workflow-engine via its barrel (or /test-support) — never a deep dist/core|ports path",
      },
    ],
  },
  engine: {
    root: join(repoRoot, "packages/workflow-engine/src"),
    rules: [
      {
        name: "engine-externals-zod-only",
        // zod is the engine's only runtime external; everything else is an
        // app-layer concern that belongs behind a port.
        test: (spec) =>
          !spec.startsWith(".") &&
          !spec.startsWith("/") &&
          !isBuiltin(spec.replace(/^node:/, "")) &&
          spec !== "zod" &&
          !spec.startsWith("zod/"),
        message:
          "the workflow engine's only allowed external is zod (+ node built-ins) — everything else belongs behind a port",
      },
      {
        name: "engine-self-contained",
        test: (spec, file) =>
          spec.startsWith(".") &&
          !resolve(dirname(file), spec).startsWith(join(repoRoot, "packages/workflow-engine/src")),
        message: "the workflow engine must not reach outside its own src/ tree",
      },
    ],
  },
  "code-facts": {
    root: join(repoRoot, "packages/code-facts/src"),
    rules: [
      {
        // A LEAF, like agentic-pi: no workspace edges in either direction, so
        // vendoring it into the sandbox image (WP2) never drags the workspace
        // along. That is also why `log.ts` re-declares LoggerPort rather than
        // importing the engine's.
        name: "code-facts-leaf",
        test: (spec) => /^lastlight(-|$)/.test(spec) || spec.startsWith("agentic-pi"),
        message:
          "code-facts is a leaf package — it must not depend on any other workspace package",
      },
      {
        // NARROWED 2026-08-22 (`docs/plans/fact-engine/`). The rule used to ban
        // `typescript` outright, on the premise that TS 7 had no programmatic
        // API. It has one — `typescript/unstable/*` — and code-facts is
        // migrating onto it, so a blanket ban now bans the engine itself.
        //
        // What the rule was really protecting is UNCHANGED and is the reason
        // the narrow form still exists: the compiler must come from THIS
        // package's pinned dependency, never from the repo under review. That
        // half is enforced structurally by `tests/compiler-isolation.test.ts`
        // (no `require.resolve("typescript", { paths: [repoDir] })`), and this
        // rule keeps the stable public entry points out — importing plain
        // `typescript` would pull the classic API surface the package does not
        // use and must not start depending on.
        name: "code-facts-no-typescript",
        test: (spec) =>
          spec === "typescript" ||
          (spec.startsWith("typescript/") && !spec.startsWith("typescript/unstable/")),
        message:
          "only `typescript/unstable/*` (the tsgo API) may be imported — never the classic " +
          "surface, and never `typescript` resolved from the repo under review",
      },
      {
        name: "code-facts-self-contained",
        test: (spec, file) =>
          spec.startsWith(".") &&
          !resolve(dirname(file), spec).startsWith(join(repoRoot, "packages/code-facts/src")),
        message: "code-facts must not reach outside its own src/ tree",
      },
    ],
  },
  cli: {
    root: join(repoRoot, "packages/cli/src"),
    rules: [
      {
        // The invariant the whole `lastlight-shared` package exists to serve:
        // the CLI is the lean global bin, and an edge to core would drag the
        // harness, both Drizzle schemas and every driver into a `npm i -g`.
        name: "cli-never-imports-core",
        test: (spec) => spec === "lastlight-core" || spec.startsWith("lastlight-core/"),
        message:
          "the CLI must never gain an edge to lastlight-core — put the shared logic in lastlight-shared",
      },
    ],
  },
};

const mode = process.argv[2];
const set = RULE_SETS[mode];
if (!set) {
  console.error(`usage: lint-import-boundaries.mjs <${Object.keys(RULE_SETS).join("|")}>`);
  process.exit(2);
}

/**
 * Comments are stripped before matching, because a doc comment saying
 * `... from "a fresh run reusing an old PR dir"` is prose, not an import, and a
 * boundary gate that cries wolf on prose gets switched off.
 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");

/** Every module specifier: static, side-effect, re-export, dynamic, require. */
const SPECIFIER_RES = [
  /^[ \t]*import[\s\S]*?\bfrom\s*["']([^"']+)["']/gm, // import x from "y"
  /^[ \t]*import\s*["']([^"']+)["']/gm, //               import "y"
  /^[ \t]*export[\s\S]*?\bfrom\s*["']([^"']+)["']/gm, // export … from "y"
  /\bimport\s*\(\s*["']([^"']+)["']/g, //                import("y")
  /\brequire\s*\(\s*["']([^"']+)["']/g, //               require("y")
];

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx|mts|cts)$/.test(full) && !full.endsWith(".d.ts") ? [full] : [];
  });

let violations = 0;
for (const file of walk(set.root)) {
  const source = stripComments(readFileSync(file, "utf8"));
  for (const re of SPECIFIER_RES) {
    for (const match of source.matchAll(re)) {
      const spec = match[1];
      for (const rule of set.rules) {
        if (!rule.test(spec, file)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        console.error(
          `${relative(repoRoot, file)}:${line}  [${rule.name}] "${spec}" — ${rule.message}`,
        );
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} boundary violation(s).`);
  process.exit(1);
}
console.log(`boundaries (${mode}): clean`);
