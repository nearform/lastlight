#!/usr/bin/env node
// Copy the Claude Code plugin + marketplace manifest from the repo root into
// this package so the published `lastlight` tarball ships them (the package
// `files` allowlist lists `plugins` + `.claude-plugin`, and `skills-install.ts`
// resolves them at the package root via `bundleRoot()`).
//
// The plugin's SOURCE OF TRUTH is the repo root (`../../plugins`,
// `../../.claude-plugin`) so the repo itself is a Claude Code marketplace
// (`claude plugin marketplace add nearform/lastlight`). Here they are BUILD
// ARTIFACTS — gitignored in this package, regenerated on `prepare` (a plain
// `pnpm install` and dev `tsx` runs) and `prebuild`/`prepack` (so `pnpm pack`
// / `pnpm publish` always include them). The same `marketplace.json`
// (`source: ./plugins/lastlight`) resolves at both locations because
// `.claude-plugin` and `plugins` travel together.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgRoot, "..", "..");

for (const name of ["plugins", ".claude-plugin"]) {
  const src = join(repoRoot, name);
  const dest = join(pkgRoot, name);
  if (!existsSync(src)) {
    console.error(`[copy-plugin] source missing: ${src} — cannot stage ${name}`);
    process.exit(1);
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

console.log("[copy-plugin] staged plugins/ + .claude-plugin/ from the repo root");
