// Does a virtual-FS overlay give a BASE-side program without a second worktree?
// This is the claim that deletes `withWorktree` from the TS/JS path.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "typescript/unstable/sync";

const dir = mkdtempSync(join(tmpdir(), "tsgo-overlay-"));
mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
  compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true },
  include: ["src"],
}));
const target = join(dir, "src", "user.ts");
// HEAD content on disk.
writeFileSync(target, `export interface User { id: string }
export function getUser(id: string): User { return { id }; }
`);
const BASE = `export interface User { id: string }
export function getUser(id: string): User | null { return id ? { id } : null; }
`;

function typeOfGetUser(api) {
  const snap = api.updateSnapshot({ openProjects: [join(dir, "tsconfig.json")] });
  const p = snap.getProjects()[0];
  const sf = p.program.getSourceFile(target);
  const mod = p.checker.getSymbolAtLocation(sf);
  const ex = p.checker.getExportsOfModule(mod).find((s) => s.name === "getUser");
  const t = p.checker.getTypeOfSymbol(ex);
  return p.checker.typeToString(t);
}

const head = new API({ cwd: dir });
const tHead0 = Date.now();
const headType = typeOfGetUser(head);
const tHead = Date.now() - tHead0;
head.close();

// The base side: same tree, one file served from the base blob.
const base = new API({
  cwd: dir,
  fs: { readFile: (f) => (f === target ? BASE : undefined) },
});
const tBase0 = Date.now();
const baseType = typeOfGetUser(base);
const tBase = Date.now() - tBase0;
base.close();

console.log(JSON.stringify({ headType, baseType, tHeadMs: tHead, tBaseMs: tBase,
  overlayWorks: headType !== baseType }, null, 2));
