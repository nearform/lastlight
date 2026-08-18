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
 */
import ts from "typescript";
import { resolve, relative } from "node:path";

// Pre-existing, deliberately unfixed. `stream.writeSSE` inside Hono's
// `streamSSE` handler: awaiting it would respect backpressure and is probably
// the better code, but it changes the behaviour of a live streaming endpoint
// and predates this gate by four months (21c6cb0, 2026-04-06). Fix it in a
// change that is about SSE, not as a drive-by. Remove the entry when you do.
const ALLOWED = new Set([
  "src/admin/routes.ts:452",
  "src/admin/routes.ts:458",
]);

const projectDirs = process.argv.slice(2);
if (projectDirs.length === 0) {
  console.error("usage: lint-floating-promises.mjs <project-dir>...");
  process.exit(2);
}

const isThenable = (t) =>
  t.getProperties?.().some((p) => p.getName() === "then") ||
  (t.isUnionOrIntersection?.() && t.types.some(isThenable));

/** A rejection with somewhere to go is not floating. */
const isHandled = (e) => {
  if (!ts.isCallExpression(e)) return false;
  const callee = e.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const name = callee.name.getText();
  return name === "catch" || name === "finally" || (name === "then" && e.arguments.length >= 2);
};

let total = 0;
for (const dir of projectDirs) {
  const root = resolve(dir);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    console.error(`no tsconfig.json under ${dir}`);
    process.exit(2);
  }
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    root,
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue;
    if (!sf.fileName.startsWith(root)) continue;
    const visit = (node) => {
      if (ts.isExpressionStatement(node)) {
        const e = node.expression;
        const skip =
          ts.isVoidExpression(e) || ts.isAwaitExpression(e) || ts.isBinaryExpression(e) || isHandled(e);
        if (!skip && isThenable(checker.getTypeAtLocation(e))) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          const where = `${relative(root, sf.fileName)}:${line + 1}`;
          if (!ALLOWED.has(where)) {
            console.error(`${dir}/${where}  ${node.getText().split("\n")[0].slice(0, 90)}`);
            total++;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

if (total > 0) {
  console.error(
    `\n${total} unhandled floating promise(s). Await it, or say the fire-and-forget out loud ` +
      `with \`void\` / \`.catch(…)\` — a bare dropped promise swallows its rejection silently.`,
  );
  process.exit(1);
}
console.log("floating promises: none");
