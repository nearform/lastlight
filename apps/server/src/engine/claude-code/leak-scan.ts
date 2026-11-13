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
 * followed, `.git` and `node_modules` skipped. No publish path reads `.git`
 * objects: `github_publish` and the host's notes commit send working-tree files.
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ClaudeCodeExecPort } from "../../sandbox/sandbox.js";

export const REDACTED = "[redacted: contained the Claude token]\n";
const PREFIX_CHARS = 24;
const CHUNK_BYTES = 1024 * 1024;
const MAX_FILES = 100_000;
/** Bytes the whole walk may read; past it the scan fails closed (a sparse file can claim terabytes). */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
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

/**
 * Workspace-relative paths of regular files holding the token. Files are read
 * in chunks (overlapping by a needle's length), so size never hides a hit.
 * `incomplete` is true when the file cap or the byte budget stopped the walk: the caller must
 * treat that as "not known clean", never as clean. Asynchronous, so a large
 * workspace never blocks the harness's event loop.
 */
export async function scanTreeForToken(
  root: string,
  token: string,
  opts: { maxFiles?: number; maxTotalBytes?: number } = {},
): Promise<{ hits: string[]; incomplete: boolean }> {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  let budget = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const ns = needles(token).map((n) => Buffer.from(n));
  if (ns.length === 0) return { hits: [], incomplete: false };
  const overlap = Math.max(...ns.map((n) => n.length)) - 1;
  const hits: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (++seen > maxFiles) return { hits, incomplete: true };
      budget -= st.size;
      if (budget < 0) return { hits, incomplete: true };
      if (await fileHolds(abs, ns, overlap)) hits.push(relative(root, abs));
    }
  }
  return { hits, incomplete: false };
}

async function fileHolds(abs: string, ns: Buffer[], overlap: number): Promise<boolean> {
  let fh;
  try {
    fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(CHUNK_BYTES + overlap);
    let kept = 0;
    for (;;) {
      const { bytesRead: n } = await fh.read(buf, kept, CHUNK_BYTES, null);
      if (n <= 0) return false;
      const view = buf.subarray(0, kept + n);
      if (ns.some((needle) => view.includes(needle))) return true;
      kept = Math.min(overlap, view.length);
      view.copy(buf, 0, view.length - kept);
    }
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

/**
 * Overwrite each listed file (workspace-relative) with a redaction note, from
 * INSIDE the sandbox as its own user: the tree is sandbox-written, so the host
 * never writes through a path in it (a swapped-in link could aim a host write
 * anywhere). A link is skipped; a failure is ignored, as the phase fails anyway.
 */
export async function redactInSandbox(port: ClaudeCodeExecPort, sandboxRoot: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const script = `for f; do [ -L "$f" ] || { [ -f "$f" ] && printf '%s' '${REDACTED.trimEnd()}' > "$f"; }; done; true`;
  try {
    await port.exec(["sh", "-c", script, "sh", ...paths.map((p) => `./${p}`)], { cwd: sandboxRoot });
  } catch {
    // nothing to add: the phase is already failing on the leak
  }
}
