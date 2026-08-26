/**
 * `contracts` — the CANONICALISER, and why it is a module of its own.
 *
 * The extractor itself (`extractContractsTsgo`) lives in `tsgo-extractors.ts`
 * with the compiler it needs. What lives here is the half that does not touch a
 * compiler at all: the `Shape` a declaration's observable contract is reduced
 * to, and the normalisation that decides whether two shapes are the SAME
 * contract printed differently.
 *
 * That split is the whole defence against this package's worst bug class. WP1
 * ran `contracts` against a real commit and got **227 deltas of which ONE was
 * real**, and every unit test passed throughout. Two of the three causes are
 * gone by construction now that both sides come from one snapshot over one tree
 * (an asymmetric tsconfig; a missing base-side `node_modules`). **The third —
 * reordered or re-printed type TEXT — is not**, and it is the one a change of
 * printer can make worse. So the canonicaliser has exactly one home, one set of
 * callers, and `tests/noise-floor.test.ts` measuring what each of its fixes is
 * worth.
 *
 * What `contracts` is FOR: the `getUser() -> User | null` becoming
 * `getUser() -> User` + `throws NotFoundError` class of regression, made
 * mechanical — and `consumersOutsideDiff` is the half that makes it an
 * obligation rather than a curiosity, because those are the call sites the PR
 * did not touch and the reviewer will not see.
 */

/**
 * The declaration's observable contract, as a value.
 *
 * Type TEXT rather than a structural type comparison: it is stable, readable in
 * an obligation, and — the part that matters here — it does not depend on the
 * repo's own `typescript`, which we must never resolve.
 */
export interface Shape {
  kind: string;
  signature: string;
  parameters: { name: string; type: string; optional: boolean }[];
  returns: string | null;
  nullableReturn: boolean;
  throws: string[];
}

/**
 * Strip absolute import paths out of every type-text field, in the EMITTED
 * document as well as in what `sameShape` compares.
 *
 * The base side is an overlay over the same tree now, so an absolute prefix no
 * longer differs run to run — but it still differs between a repository root
 * and its `realpath` (every `$TMPDIR` fixture on macOS), and an unstripped
 * `import("/private/var/folders/…")` is unreadable in an obligation whatever it
 * compares equal to.
 */
export function finaliseShape(shape: Shape): Shape {
  return {
    ...shape,
    signature: stripImportPaths(shape.signature),
    returns: shape.returns === null ? null : stripImportPaths(shape.returns),
    parameters: shape.parameters.map((parameter) => ({
      ...parameter,
      type: stripImportPaths(parameter.type),
    })),
    // `throws` is a type-text surface too — `thrownTypes` falls back to the
    // printer for anything that is not a `new` expression — and `sameShape`
    // compares it RAW, with no `canonicalType` pass, so an unstripped path here
    // is a delta about a directory rather than about the PR.
    throws: shape.throws.map(stripImportPaths),
  };
}

// ── canonical type text ──────────────────────────────────────────────────────
//
// A type's PRINTED form is not stable between two programs, and both
// instabilities produce phantom "changed" deltas — which are not merely noise:
// IRIS measured a half-mechanism seed as ACTIVELY HARMFUL (−3, worse than no
// seed at all), and a contract delta that did not happen is exactly that.
//
//  1. **Absolute paths.** An unnamed type prints as
//     `import("/abs/path/to/mod").Foo`. The base tree is an overlay over the
//     head tree now, so the two sides agree on the prefix — but a repository
//     root and its `realpath` do not (`/var` vs `/private/var` on darwin), and
//     an absolute path is unreadable in an obligation either way.
//  2. **Union member order.** TypeScript does not guarantee it across programs;
//     `"fail" | "complete"` and `"complete" | "fail"` are the same type.
//
// Both are normalised away before comparison. The EMITTED text keeps the import
// paths stripped too — a 4000-character type full of `../../..` is unreadable
// in an obligation regardless.

/**
 * BOTH forms, and the second one is the one that bit us.
 *
 *   `import("/abs/path/mod").User`  → `User`        — a qualified member
 *   `typeof import("./schema/sqlite.js")` → `typeof sqlite`  — the module ITSELF
 *
 * The original regex required the trailing `.`, so the bare form — a module
 * namespace type, which is what a `typeof import(...)` parameter is — survived
 * with its specifier intact. `tests/invariants.test.ts` found it on this
 * monorepo's own Drizzle commit, where 2 of 207 contract deltas carried
 * `typeof import("./schema/sqlite.js")` straight into the emitted signature.
 *
 * That is the same defect as the dotted case in both of its halves: the text is
 * unreadable in an obligation (the comment above promises `../../..` is gone),
 * and an ABSOLUTE specifier — which is what a type outside the tsconfig's root
 * prints as — names a machine rather than a repository, so the symbol reads as
 * `changed` for a reason that is not in the PR. Phantom deltas are not noise;
 * IRIS measured a half-mechanism seed at −3, worse than no seed at all.
 *
 * Collapsing the module to its basename loses the ability to distinguish
 * `import("./a/mod")` from `import("./b/mod")` — exactly the trade the dotted
 * form has always made, and the same direction: mask a rare real delta rather
 * than manufacture a routine phantom one.
 */
function stripImportPaths(text: string): string {
  return text.replace(/import\("([^"]*)"\)(\.?)/g, (_match, specifier: string, dot: string) =>
    dot ? "" : moduleLabel(specifier),
  );
}

/** `./state/schema/sqlite.js` → `sqlite`; `@scope/pkg` → `pkg`. */
function moduleLabel(specifier: string): string {
  const last = specifier.split("/").filter(Boolean).at(-1) ?? "";
  return last.replace(/\.[cm]?[jt]sx?$/, "") || "module";
}

/**
 * Does `text[i]` close a bracket group?
 *
 * The `text[i - 1] !== "="` is the whole reason this is a function. **`=>` is
 * not a closing angle bracket**, and counting it as one drove the depth NEGATIVE
 * for the rest of the string — so every signature (which is to say every
 * function, which is to say most of what this extractor compares) had its
 * return type split at a union that was never top-level. `tests/noise-floor.test.ts`
 * measures what that cost: 12 phantom deltas on a fixture whose only real change
 * is one added parameter.
 */
function closesGroup(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === ")" || ch === "]" || ch === "}") return true;
  return ch === ">" && text[i - 1] !== "=";
}

function opensGroup(ch: string): boolean {
  return ch === "(" || ch === "[" || ch === "{" || ch === "<";
}

/** Split on `separator` at bracket depth 0, ignoring string literals. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (opensGroup(ch)) depth++;
    else if (closesGroup(text, i)) depth--;
    else if (depth === 0 && ch === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * `(…) => A | B` parses as `(…) => (A | B)`: the arrow binds LOOSER than the
 * union, so it has to come off before anything splits on `|`. Otherwise the
 * parameter list travels with the first union member and sorting moves it into
 * the middle of the return type — two orderings of the same type stay different
 * and the delta is phantom.
 */
function splitArrow(text: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (opensGroup(ch)) depth++;
    else if (closesGroup(text, i)) depth--;
    else if (depth === 0 && ch === "=" && text[i + 1] === ">") {
      return [text.slice(0, i), text.slice(i + 2)];
    }
  }
  return null;
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/**
 * `sortMembers` is true only inside `{ … }`: object members have no meaningful
 * order, but function PARAMETERS and generic ARGUMENTS do, so `(` and `<`
 * groups are canonicalised without being reordered.
 */
function canonicalise(text: string, sortMembers = false): string {
  const trimmed = text.trim();

  // MEMBERS BEFORE UNIONS, and the order is load-bearing. Inside an object body
  // the `;` between members and the `|` inside a member's value sit at the SAME
  // bracket depth, so splitting on `|` first shreds the member list and the
  // sort never reaches the value that actually needed reordering.
  if (sortMembers) {
    for (const separator of [";", ","]) {
      const members = splitTopLevel(trimmed, separator);
      if (members.length > 1) {
        return members
          .map((member) => canonicaliseMember(member))
          .filter((member) => member.length > 0)
          .sort()
          .join("; ");
      }
    }
    // A body with exactly ONE member never reached the split above and fell
    // through to the union branch, where the property name sorted as part of
    // the first union member — `{ then: "a" | "b" }` and `{ then: "b" | "a" }`
    // stayed different. Route it through the same member path.
    if (trimmed.length > 0) return canonicaliseMember(trimmed);
  }

  const arrow = splitArrow(trimmed);
  if (arrow) {
    return `${canonicalise(arrow[0], false)} => ${canonicalise(arrow[1], false)}`;
  }

  const unionParts = splitTopLevel(trimmed, "|");
  if (unionParts.length > 1) {
    return unionParts
      .map((part) => canonicalise(part, sortMembers))
      .sort()
      .join(" | ");
  }

  // No top-level split left — descend into each bracketed group.
  let out = "";
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    const closer = CLOSERS[ch];
    if (!closer) {
      out += ch;
      i++;
      continue;
    }
    let depth = 0;
    let end = i;
    for (let j = i; j < trimmed.length; j++) {
      const c = trimmed[j];
      if (opensGroup(c)) depth++;
      else if (closesGroup(trimmed, j)) {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end <= i) {
      out += trimmed.slice(i);
      break;
    }
    out += ch + canonicalise(trimmed.slice(i + 1, end), ch === "{") + closer;
    i = end + 1;
  }
  return out.trim();
}

/**
 * `then: "complete" | "fail"` — the property NAME must be split off before the
 * value's union is sorted, or the name sorts as part of the first member and
 * the two orderings still differ. That single omission left one phantom delta
 * standing on the first real repo this ran against.
 */
function canonicaliseMember(member: string): string {
  const halves = splitTopLevel(member, ":");
  if (halves.length < 2) return canonicalise(member, false);
  const name = halves[0];
  const value = halves.slice(1).join(":");
  return `${canonicalise(name, false)}: ${canonicalise(value, false)}`;
}

export function canonicalType(text: string): string {
  return canonicalise(stripImportPaths(text));
}

/**
 * `changed` vs unchanged, decided in ONE place — a second copy of this
 * comparison is a second place a phantom delta can be born.
 */
export function sameShape(a: Shape, b: Shape): boolean {
  return (
    canonicalType(a.signature) === canonicalType(b.signature) &&
    a.kind === b.kind &&
    a.throws.join("|") === b.throws.join("|") &&
    a.nullableReturn === b.nullableReturn
  );
}
