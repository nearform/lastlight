/**
 * The grammars `@ast-grep/napi` does NOT bundle — Python, Go, Java — loaded
 * through its `registerDynamicLanguage`, the same tree-sitter runtime the
 * bundled TS/JS grammars run on. Not a second parser: each `@ast-grep/lang-*`
 * package is a prebuilt tree-sitter `parser.so` per platform plus a
 * registration record (`libraryPath`, `extensions`, `languageSymbol`).
 *
 * Three properties of that API, each measured on `@ast-grep/napi` 0.45.2, are
 * why this module is shaped the way it is:
 *
 *  1. **A bad `libraryPath` does not throw — it PANICS the Rust side and aborts
 *     the whole process** (`napi_lang.rs: GetLibPath(NotFound)`, then
 *     `failed to initiate panic`). No `try` can catch that, and a dead process is
 *     the one failure the fail-loud envelope cannot describe. So every library
 *     is PREFLIGHTED before it is handed over: the file must exist, and
 *     `process.dlopen` must be able to map it. `dlopen` on a tree-sitter parser
 *     fails with `Module did not self-register` — which is exactly the proof we
 *     want (the loader mapped it; it is simply not a Node addon). Any other
 *     error — missing file, wrong architecture, a glibc `.so` on musl — is the
 *     reason that language is reported unavailable.
 *  2. **Registration is once per process.** A second `registerDynamicLanguage`
 *     call is silently IGNORED (measured: registering `{python}` then `{go}`
 *     leaves `go` "not supported"). So there is exactly one call, carrying every
 *     grammar that passed preflight, made lazily on the first parse that needs
 *     one — a TS-only run never pays the ~ms of `dlopen`.
 *  3. **Something else in the process may have registered first** (an embedder
 *     that also uses ast-grep). Then our call is the ignored one. So after
 *     registering, each grammar is PROBED with a real parse, and a grammar the
 *     runtime does not actually know is unavailable, with that as its reason.
 *
 * Every failure lands in `grammarStatus`, and the callers turn it into a
 * `degraded[]` entry naming the grammar and a `languages[].parsedFiles` that
 * stays honest (a file that was not parsed is not counted as parsed). Never
 * silent.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { parse, registerDynamicLanguage } from "@ast-grep/napi";

/** One dynamically-loaded grammar: the ast-grep language name and its npm package. */
export interface DynamicGrammar {
  /** The name `parse()` is called with — also the descriptor id. */
  lang: string;
  /** The `@ast-grep/lang-*` package carrying the prebuilt parser. */
  packageName: string;
}

export const DYNAMIC_GRAMMARS: DynamicGrammar[] = [
  { lang: "python", packageName: "@ast-grep/lang-python" },
  { lang: "go", packageName: "@ast-grep/lang-go" },
  { lang: "java", packageName: "@ast-grep/lang-java" },
];

export type GrammarStatus = { ok: true } | { ok: false; reason: string };

interface Registration {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
  metaVarChar?: string;
  expandoChar?: string;
}

const require = createRequire(import.meta.url);

/**
 * Can this shared library be mapped by the dynamic loader at all?
 *
 * `null` = yes; a string = why not. See the module header, point 1: this is the
 * only thing standing between a broken install and an uncatchable abort.
 */
export function preflightLibrary(libraryPath: string): string | null {
  if (!existsSync(libraryPath)) return `the parser library does not exist: ${libraryPath}`;
  const probe = { exports: {} };
  try {
    process.dlopen(probe, libraryPath);
    // A tree-sitter parser is not a Node addon, so this line is not expected —
    // but a library that loads is a library that loads.
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/did not self-register/i.test(message)) return null;
    return `the parser library could not be loaded: ${message.split("\n")[0]}`;
  }
}

/** Resolve the package's registration record, or say why it cannot be. */
function resolveRegistration(grammar: DynamicGrammar): Registration | string {
  try {
    const record = require(grammar.packageName) as Registration;
    // `libraryPath` is a GETTER that throws when no prebuild matches this
    // platform/arch and nothing was built from source — read it here, inside
    // the try, rather than letting `registerDynamicLanguage` read it.
    const libraryPath = record.libraryPath;
    return {
      libraryPath,
      extensions: record.extensions,
      ...(record.languageSymbol ? { languageSymbol: record.languageSymbol } : {}),
      ...(record.metaVarChar ? { metaVarChar: record.metaVarChar } : {}),
      ...(record.expandoChar ? { expandoChar: record.expandoChar } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `${grammar.packageName} could not be resolved on ${process.platform}-${process.arch}: ${message.split("\n")[0]}`;
  }
}

let STATUS: Map<string, GrammarStatus> | null = null;
/** Test seam — see `forceGrammarUnavailable`. Per module instance, so per test file. */
const FORCED = new Map<string, string>();

function registerAll(): Map<string, GrammarStatus> {
  const status = new Map<string, GrammarStatus>();
  const toRegister: Record<string, Registration> = {};
  for (const grammar of DYNAMIC_GRAMMARS) {
    const registration = resolveRegistration(grammar);
    if (typeof registration === "string") {
      status.set(grammar.lang, { ok: false, reason: registration });
      continue;
    }
    const refused = preflightLibrary(registration.libraryPath);
    if (refused !== null) {
      status.set(grammar.lang, { ok: false, reason: `${grammar.packageName}: ${refused}` });
      continue;
    }
    toRegister[grammar.lang] = registration;
  }

  if (Object.keys(toRegister).length > 0) {
    try {
      registerDynamicLanguage(toRegister);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const lang of Object.keys(toRegister)) {
        status.set(lang, { ok: false, reason: `registerDynamicLanguage threw: ${message}` });
      }
      return status;
    }
  }

  // Point 3: an earlier registration elsewhere in the process makes ours a
  // silent no-op, so "we registered it" is not evidence. A parse is.
  for (const lang of Object.keys(toRegister)) {
    try {
      parse(lang, "").root();
      status.set(lang, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status.set(lang, {
        ok: false,
        reason: `the ${lang} grammar was registered but the runtime cannot parse with it (${message}) — another registerDynamicLanguage call in this process may have won`,
      });
    }
  }
  return status;
}

/**
 * Is this dynamic grammar usable in this process? Registers every dynamic
 * grammar on first call; cheap (a map lookup) after that.
 */
export function grammarStatus(lang: string): GrammarStatus {
  const forced = FORCED.get(lang);
  if (forced !== undefined) return { ok: false, reason: forced };
  STATUS ??= registerAll();
  return STATUS.get(lang) ?? { ok: false, reason: `no dynamic grammar is known for ${lang}` };
}

/**
 * TEST SEAM: make one grammar read as failed-to-load in THIS module instance.
 *
 * It deliberately does not touch the native registration — that is
 * process-global and once-only, so a test that really unregistered a grammar
 * would change what every later test in the same worker sees. What it exercises
 * is everything DOWNSTREAM of a load failure: the unparsed count, the
 * `degraded[]` entry, `languages[].parsedFiles`. The real preflight has its own
 * test (`preflightLibrary`). `null` clears it.
 */
export function forceGrammarUnavailable(lang: string, reason: string | null): void {
  if (reason === null) FORCED.delete(lang);
  else FORCED.set(lang, reason);
}
