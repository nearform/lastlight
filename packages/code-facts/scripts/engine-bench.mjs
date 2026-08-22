// Reproduce the headline benchmark from ~/.claude/plans/we-are-building-a-refactored-pearl.md
// in THIS checkout. One engine per process — RSS is process-wide.
//   node tsgo-probe.mjs tsgo|ts-morph [tsconfig...]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const which = process.argv[2];
// The repo root, derived — a hard-coded path silently benchmarks nothing on
// anyone else's machine, which is the failure this package exists to catch.
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const cfgs = process.argv.slice(3);
const configs = cfgs.length ? cfgs : [`${ROOT}/apps/server/tsconfig.json`];
if (!existsSync(configs[0])) {
  console.error(`no tsconfig at ${configs[0]} — pass one explicitly`);
  process.exit(2);
}
console.error(`# root=${ROOT}\n# configs(${configs.length}): ${configs.join(" ")}`);
const mb = () => Math.round(process.memoryUsage.rss() / 1024 / 1024);

if (which === "tsgo") {
  const t0 = Date.now();
  const { API } = await import("typescript/unstable/sync");
  const tImport = Date.now() - t0;

  const api = new API({ cwd: ROOT });
  const t1 = Date.now();
  const snap = api.updateSnapshot({ openProjects: configs });
  const tBuild = Date.now() - t1;

  const projects = snap.getProjects();
  let files = 0;
  for (const p of projects) files += p.program.getSourceFileNames().length;

  // Semantic work: ask the checker for the type of every exported symbol of
  // each project's own root files — closer to what `contracts` does than a
  // whole-program diagnostic sweep.
  const t2 = Date.now();
  let symbols = 0;
  for (const p of projects) {
    for (const name of p.rootFiles.slice(0, 200)) {
      const sf = p.program.getSourceFile(name);
      if (!sf) continue;
      const sym = p.checker.getSymbolAtLocation(sf);
      if (!sym) continue;
      for (const ex of p.checker.getExportsOfModule(sym)) {
        p.checker.getTypeOfSymbol(ex);
        symbols += 1;
      }
    }
  }
  const tCheck = Date.now() - t2;

  console.log(JSON.stringify({
    engine: "tsgo", projects: projects.length, tImport, tBuild, tCheck,
    files, symbols, rssMb: mb(),
  }));
  api.close();
} else {
  const t0 = Date.now();
  const { Project } = await import("ts-morph");
  const tImport = Date.now() - t0;

  const t1 = Date.now();
  const projects = configs.map((c) => new Project({ tsConfigFilePath: c }));
  const tBuild = Date.now() - t1;
  let files = 0;
  for (const p of projects) files += p.getSourceFiles().length;

  const t2 = Date.now();
  let symbols = 0;
  for (const p of projects) {
    for (const sf of p.getSourceFiles().slice(0, 200)) {
      for (const [, decls] of sf.getExportedDeclarations()) {
        for (const d of decls) { d.getType().getText(); symbols += 1; }
      }
    }
  }
  const tCheck = Date.now() - t2;

  console.log(JSON.stringify({
    engine: "ts-morph", projects: projects.length, tImport, tBuild, tCheck,
    files, symbols, rssMb: mb(),
  }));
}
