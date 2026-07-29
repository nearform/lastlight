import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/** In-pod mount root where the skills initContainer unpacks the bundle and the
 *  agent loads it from via `--skill`. */
export const SKILLS_MOUNT_DIR = "/lastlight-skills";

const DEFAULT_TTL_MS = 30 * 60_000;

/** Reduce a skill dir name to a shell/path-safe token so the `--skill
 *  <SKILLS_MOUNT_DIR>/<name>` path can be interpolated without escaping. */
export function sanitizeSkillName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_-]/g, "");
  return clean || "skill";
}

/**
 * Package the resolved skill dirs into a gzipped tar (built via system `tar` —
 * no npm dep). Each dir lands under its sanitized basename, so the tar unpacks
 * to `<name>/SKILL.md`, `<name>/scripts/…`, etc. Synchronous by design: the
 * `Sandbox.stageSkills` port is sync and bundles are tiny (~tens of KB).
 */
export function buildSkillTar(skillPaths: readonly string[]): { tar: Buffer; names: string[] } {
  if (!skillPaths.length) return { tar: Buffer.alloc(0), names: [] };
  const staging = mkdtempSync(join(tmpdir(), "ll-skills-"));
  try {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const src of skillPaths) {
      const name = sanitizeSkillName(basename(src));
      if (seen.has(name)) {
        throw new Error(
          `duplicate skill name after sanitization: "${name}" (from ${src}) — ` +
            "skill dir basenames must be distinct",
        );
      }
      seen.add(name);
      cpSync(src, join(staging, name), { recursive: true, dereference: true });
      names.push(name);
    }
    const tar = execFileSync("tar", ["-czf", "-", "-C", staging, "--", ...names], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return { tar, names };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * In-memory token→bundle store shared by the adapter (writer) and the
 * `/internal/skill-bundle` route (reader). A per-run token gates each Pod to
 * its own bundle. Primary reclaim is explicit: the orchestrator's run
 * bracket calls `evict()` on both success and error. The TTL is a lazy
 * backstop, not a timer — an expired entry is only dropped the next time its
 * token is looked up via `get()`, so a token nobody ever queries again just
 * sits in the Map until the process exits (bounded by process lifetime; a
 * crash frees the whole thing).
 */
export class SkillBundleRegistry {
  private readonly bundles = new Map<string, { tar: Buffer; expires: number }>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  register(tar: Buffer): string {
    const token = randomUUID();
    this.bundles.set(token, { tar, expires: Date.now() + this.ttlMs });
    return token;
  }

  get(token: string): Buffer | undefined {
    const entry = this.bundles.get(token);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.bundles.delete(token);
      return undefined;
    }
    return entry.tar;
  }

  evict(token: string): void {
    this.bundles.delete(token);
  }
}

/** Process-wide singleton: the adapter registers, the HTTP route serves. */
export const skillBundleRegistry = new SkillBundleRegistry();
