/**
 * The Postgres drivers must not be reachable from any module's TOP-LEVEL graph.
 *
 * `pg` and `@neondatabase/serverless` are runtime dependencies, so a SQLite
 * deployment installs them — but it must never LOAD them, and a node-postgres
 * deployment must never load the Neon driver (or vice-versa). That property is
 * carried entirely by four `await import()`s, and a well-meaning refactor that
 * hoists any of them to a static import breaks it while every test still
 * passes and the app still works. Nothing else would notice.
 *
 * So the phase doc's manual grep lives here instead, where CI runs it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** `import … from "x"` / `import "x"` — the static forms. `await import("x")` is not one. */
const STATIC_IMPORT_RE =
  /^\s*import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']|^\s*export\s+[\s\S]*?\sfrom\s+["']([^"']+)["']/gm;

const DRIVER_SPECIFIERS = [
  "pg",
  "@neondatabase/serverless",
  "drizzle-orm/node-postgres",
  "drizzle-orm/node-postgres/migrator",
  "drizzle-orm/neon-serverless",
  "drizzle-orm/neon-serverless/migrator",
];

describe("Postgres driver isolation", () => {
  it("no module under src/ statically imports a Postgres driver", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(STATIC_IMPORT_RE)) {
        const specifier = match[1] ?? match[2];
        if (DRIVER_SPECIFIERS.includes(specifier)) {
          offenders.push(`${file.slice(SRC.length + 1)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * `schema/pg.ts` is a pure table declaration with no driver in it, but it is
   * only *needed* on the Postgres path — and `tablesOf()` reads the schema back
   * off the client, so a module that imports it is a module that was about to
   * drive a Postgres client. Confining it to `pg-client.ts` (itself only
   * reachable through a dynamic import) is what keeps that whole branch out of
   * a SQLite deployment.
   */
  it("only pg-client.ts imports the Postgres schema", () => {
    const importers = sourceFiles(SRC).filter((file) =>
      /from\s+["'][^"']*schema\/pg\.js["']/.test(readFileSync(file, "utf8")),
    );
    expect(importers.map((f) => f.slice(SRC.length + 1))).toEqual(["state/pg-client.ts"]);
  });
});
