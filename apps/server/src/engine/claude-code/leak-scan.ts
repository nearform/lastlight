/**
 * Backstop scan for the Claude token in what a `claude-code` phase produced.
 *
 * The real controls are elsewhere (no GitHub or provider credential in the
 * phase, the Anthropic API as its only extra egress); this catches the
 * accidental case — a session that echoed its env into a note or a file —
 * before Last Light publishes anything. It cannot catch a deliberately
 * disguised token.
 *
 * The workspace is read on the host as plain files: no `git`, no link ever
 * followed, `.git` and `node_modules` skipped, oversized files skipped.
 */
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join, relative } from "node:path";

export const REDACTED = "[redacted: contained the Claude token]\n";
const PREFIX_CHARS = 24;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 100_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

function needles(token: string): string[] {
  if (!token) return [];
  const out = new Set([token, token.slice(0, PREFIX_CHARS), Buffer.from(token).toString("base64")]);
  return [...out].filter((n) => n.length >= 16);
}

/** `text` with every form of the token {@link findTokenLeak} looks for replaced. */
export function scrubToken(text: string, token: string): string {
  let out = text;
  for (const n of needles(token)) out = out.split(n).join("[redacted]");
  return out;
}

/** Name of the first source containing the token (or its first 24 characters, or its base64), else null. */
export function findTokenLeak(token: string, sources: { name: string; text: string }[]): string | null {
  const ns = needles(token);
  if (ns.length === 0) return null;
  for (const s of sources) if (ns.some((n) => s.text.includes(n))) return s.name;
  return null;
}

/** Workspace-relative paths of regular files holding the token. */
export function scanTreeForToken(root: string, token: string): string[] {
  const ns = needles(token).map((n) => Buffer.from(n));
  if (ns.length === 0) return [];
  const hits: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(abs);
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      if (++seen > MAX_FILES) return hits;
      let buf: Buffer;
      try {
        const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          buf = readFileSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      if (ns.some((n) => buf.includes(n))) hits.push(relative(root, abs));
    }
  }
  return hits;
}

/** Overwrite each listed file (workspace-relative) with a redaction note; links are never written through. */
export function redactTokenFiles(root: string, paths: string[]): void {
  for (const p of paths) {
    try {
      const fd = openSync(join(root, p), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
      try {
        writeSync(fd, REDACTED);
      } finally {
        closeSync(fd);
      }
    } catch {
      // A file that vanished or turned into a link is not published either way.
    }
  }
}
