#!/usr/bin/env node
/**
 * Tiny test runner.
 *
 * Node's `node --test` doesn't recursively discover `.ts` test files on
 * its own (its default pattern only matches `.js/.cjs/.mjs`). This script
 * walks `test/` looking for files matching `*.test.ts`, optionally filters
 * by category, and invokes `node --test --import tsx` with the explicit
 * file list.
 *
 * Categories:
 *   default       (all .test.ts)
 *   --unit        skip *.integration.test.ts
 *   --integration only *.integration.test.ts
 *
 * Any unrecognised flags get forwarded to `node --test` after the file
 * list (e.g. `--test-reporter=spec`).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TEST_DIR = join(__dirname, "..", "test");

const args = process.argv.slice(2);
const onlyUnit = args.includes("--unit");
const onlyIntegration = args.includes("--integration");
const passthrough = args.filter((a) => a !== "--unit" && a !== "--integration");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const all = walk(TEST_DIR).sort();
const files = all.filter((f) => {
  const isIntegration = f.endsWith(".integration.test.ts");
  if (onlyUnit) return !isIntegration;
  if (onlyIntegration) return isIntegration;
  return true;
});

if (files.length === 0) {
  console.error(`No test files matched (looked in ${TEST_DIR}).`);
  process.exit(1);
}

// VITEST_MAX_WORKERS is the workspace-wide worker cap (see the vitest configs);
// honour it here too so the guardrails gate bounds node's test pool the same way.
const concurrency = process.env.VITEST_MAX_WORKERS ? [`--test-concurrency=${process.env.VITEST_MAX_WORKERS}`] : [];

const nodeArgs = ["--test", "--import", "tsx", ...concurrency, ...passthrough, ...files];

const child = spawn(process.execPath, nodeArgs, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
