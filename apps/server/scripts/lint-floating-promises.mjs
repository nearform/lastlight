#!/usr/bin/env node
/**
 * Fail the build on an UNHANDLED floating promise.
 *
 * `tsc` cannot see a dropped promise: a call whose result is discarded is a
 * perfectly well-typed expression statement. That blind spot is why the
 * Drizzle migration's async flip left fourteen real bugs in a compiler-clean
 * tree (`docs/plans/drizzle-migration/README.md`, "two rules the phases learned
 * the hard way"), and why three more survived into review in
 * `workflows/handlers/post-review.ts` — a file the flip never touched, so no
 * diff showed the breakage.
 *
 * This is `@typescript-eslint/no-floating-promises` reimplemented against the
 * TS compiler API, because the repo has no eslint setup and this one rule does
 * not justify one. It runs from `typecheck`, beside the dep-cruiser boundary
 * gate — the same "invariant a reviewer should never have to check by hand"
 * shelf.
 *
 * HANDLED (not reported): `await x`, `void x`, `x.catch(fn)`,
 * `x.then(ok, err)`, `x.finally(fn)`, and any promise that is assigned,
 * returned or passed on. Deliberate fire-and-forget is spelled `.catch(…)` or
 * `void` — both of which say so in the source.
 *
 * TypeScript 7 note: the classic `import ts from "typescript"` compiler API is
 * gone — the package's main entry now exports only `version`, and the compiler
 * lives behind `typescript/unstable/*`. That surface is explicitly UNSTABLE, so
 * if this script breaks on a TS 7.x bump, it is this import boundary that moved
 * and not the rule. The shape is LSP-like rather than `createProgram`: open a
 * snapshot over the tsconfig, and read `project.program` / `project.checker`
 * off it.
 */
import { API } from "typescript/unstable/sync";
import {
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isExpressionStatement,
  isPropertyAccessExpression,
  isVoidExpression,
} from "typescript/unstable/ast/is";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

// Pre-existing, deliberately unfixed. `stream.writeSSE` inside Hono's
// `streamSSE` handler: awaiting it would respect backpressure and is probably
// the better code, but it changes the behaviour of a live streaming endpoint
// and predates this gate by four months (21c6cb0, 2026-04-06). Fix it in a
// change that is about SSE, not as a drive-by. Remove the entry when you do.
//
// NOTE: these are keyed by LINE NUMBER, so any edit that adds or removes lines
// above them in `routes.ts` silently un-allowlists them and the gate fails
// pointing at code the change never touched. Shifted by +2 in #206 (two added
// imports). If that happens again, consider keying on the expression text.
const ALLOWED = new Set([
  "src/admin/routes.ts:454",
  "src/admin/routes.ts:460",
]);

const projectDirs = process.argv.slice(2);
if (projectDirs.length === 0) {
  console.error("usage: lint-floating-promises.mjs <project-dir>...");
  process.exit(2);
}

/**
 * A union is thenable if ANY constituent is: `Promise<T> | undefined` is still
 * a promise you can drop. The checker's own property list on a union is the
 * INTERSECTION of its constituents, so it reports no `then` there — hence the
 * explicit recursion, same as the pre-TS7 version did.
 */
const isThenable = (checker, t) => {
  if (!t) return false;
  if (checker.getPropertiesOfType(t).some((p) => p.name === "then")) return true;
  const parts = t.getTypes?.();
  return Array.isArray(parts) && parts.some((p) => isThenable(checker, p));
};

/** A rejection with somewhere to go is not floating. */
const isHandled = (e) => {
  if (!isCallExpression(e)) return false;
  const callee = e.expression;
  if (!isPropertyAccessExpression(callee)) return false;
  const name = callee.name.getText();
  return name === "catch" || name === "finally" || (name === "then" && e.arguments.length >= 2);
};

const api = new API({ cwd: process.cwd() });
let total = 0;

for (const dir of projectDirs) {
  const root = resolve(dir);
  const configPath = join(root, "tsconfig.json");
  if (!existsSync(configPath)) {
    console.error(`no tsconfig.json under ${dir}`);
    process.exit(2);
  }

  const snapshot = api.updateSnapshot({ openProjects: [configPath] });
  const project = snapshot.getProject(configPath);
  if (!project) {
    console.error(`could not load project ${configPath}`);
    process.exit(2);
  }
  const { program, checker } = project;

  for (const fileName of program.getSourceFileNames()) {
    if (fileName.endsWith(".d.ts") || fileName.includes("node_modules")) continue;
    if (!fileName.startsWith(root)) continue;
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;

    const visit = (node) => {
      if (isExpressionStatement(node)) {
        const e = node.expression;
        const skip =
          isVoidExpression(e) || isAwaitExpression(e) || isBinaryExpression(e) || isHandled(e);
        if (!skip && isThenable(checker, checker.getTypeAtLocation(e))) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          const where = `${relative(root, fileName)}:${line + 1}`;
          if (!ALLOWED.has(where)) {
            console.error(`${dir}/${where}  ${node.getText().split("\n")[0].slice(0, 90)}`);
            total++;
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }

  snapshot.dispose();
}

api.close();

if (total > 0) {
  console.error(
    `\n${total} unhandled floating promise(s). Await it, or say the fire-and-forget out loud ` +
      `with \`void\` / \`.catch(…)\` — a bare dropped promise swallows its rejection silently.`,
  );
  process.exit(1);
}
console.log("floating promises: none");
