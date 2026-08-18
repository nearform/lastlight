import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  SKILLS_MOUNT_DIR,
  sanitizeSkillName,
  buildSkillTar,
  SkillBundleRegistry,
} from "#src/sandbox/k8s/skill-bundle.js";

describe("sanitizeSkillName", () => {
  it("keeps safe chars and strips the rest", () => {
    expect(sanitizeSkillName("pr-review")).toBe("pr-review");
    expect(sanitizeSkillName("weird name;rm -rf/")).toBe("weirdnamerm-rf");
    expect(sanitizeSkillName("")).toBe("skill");
  });
});

describe("buildSkillTar", () => {
  it("tars resolved skill dirs into a gzip that unpacks under sanitized names", () => {
    const src = mkdtempSync(join(tmpdir(), "skills-src-"));
    const a = join(src, "pr-review");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "SKILL.md"), "# pr-review");
    mkdirSync(join(a, "scripts"), { recursive: true });
    writeFileSync(join(a, "scripts", "run.sh"), "echo hi");

    const { tar, names } = buildSkillTar([a]);
    expect(names).toEqual(["pr-review"]);
    expect(tar.length).toBeGreaterThan(0);

    // Unpack and confirm structure survives (nested dir + file).
    const out = mkdtempSync(join(tmpdir(), "skills-out-"));
    const tarPath = join(out, "b.tgz");
    writeFileSync(tarPath, tar);
    execFileSync("tar", ["xzf", tarPath, "-C", out]);
    expect(() => execFileSync("cat", [join(out, "pr-review", "SKILL.md")])).not.toThrow();
    expect(() => execFileSync("cat", [join(out, "pr-review", "scripts", "run.sh")])).not.toThrow();
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("returns an empty bundle for no skills", () => {
    expect(buildSkillTar([])).toEqual({ tar: Buffer.alloc(0), names: [] });
  });

  it("handles a sanitized name that starts with a dash (tar option-injection guard)", () => {
    const src = mkdtempSync(join(tmpdir(), "skills-src-"));
    // sanitizeSkillName("-rf") === "-rf" — a leading-dash name must not be
    // parsed as a tar flag.
    const a = join(src, "-rf");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "SKILL.md"), "# dash-named skill");

    let result: { tar: Buffer; names: string[] } | undefined;
    expect(() => {
      result = buildSkillTar([a]);
    }).not.toThrow();
    expect(result?.names).toEqual(["-rf"]);
    expect(result?.tar.length).toBeGreaterThan(0);

    const out = mkdtempSync(join(tmpdir(), "skills-out-"));
    const tarPath = join(out, "b.tgz");
    writeFileSync(tarPath, result?.tar as Buffer);
    execFileSync("tar", ["xzf", tarPath, "-C", out]);
    expect(() => execFileSync("cat", [join(out, "-rf", "SKILL.md")])).not.toThrow();

    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("throws on a duplicate sanitized name instead of silently merging", () => {
    const src = mkdtempSync(join(tmpdir(), "skills-src-"));
    const a = join(src, "dir-one", "pr-review");
    const b = join(src, "dir-two", "pr-review");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "SKILL.md"), "# a");
    writeFileSync(join(b, "SKILL.md"), "# b");

    expect(() => buildSkillTar([a, b])).toThrow(/duplicate skill name/);

    rmSync(src, { recursive: true, force: true });
  });
});

describe("SkillBundleRegistry", () => {
  it("register → get round-trips the bytes; evict + unknown → undefined", () => {
    const reg = new SkillBundleRegistry();
    const token = reg.register(Buffer.from("hello"));
    expect(reg.get(token)?.toString()).toBe("hello");
    expect(reg.get("nope")).toBeUndefined();
    reg.evict(token);
    expect(reg.get(token)).toBeUndefined();
  });

  it("expires entries past the TTL", () => {
    const reg = new SkillBundleRegistry(0); // immediate expiry
    const token = reg.register(Buffer.from("x"));
    expect(reg.get(token)).toBeUndefined();
  });

  it("exposes the in-pod mount root", () => {
    expect(SKILLS_MOUNT_DIR).toBe("/lastlight-skills");
  });
});
