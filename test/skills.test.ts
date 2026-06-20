import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadSkillsExtension,
  buildSkillsStatusEvent,
  type SkillsResult,
  type SkillSummary,
} from "../src/extensions/skills/index.js";

describe("loadSkillsExtension", () => {
  let home: string;
  let cwd: string;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "ap-skills-home-"));
    cwd = mkdtempSync(join(tmpdir(), "ap-skills-cwd-"));
    // ~/.claude/skills (tilde target) and ./local-skills (cwd-relative target)
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(cwd, "local-skills"), { recursive: true });
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("no flags → status 'default', no paths, discovery enabled", () => {
    const r = loadSkillsExtension({ cwd, home });
    assert.equal(r.status, "default");
    assert.deepEqual(r.additionalSkillPaths, []);
    assert.equal(r.noSkills, false);
    assert.deepEqual(r.warnings, []);
  });

  test("expands ~ and resolves relative paths to absolute", () => {
    const r = loadSkillsExtension({
      cwd,
      home,
      skillPaths: ["~/.claude/skills", "local-skills"],
    });
    assert.equal(r.status, "configured");
    assert.deepEqual(r.additionalSkillPaths, [
      join(home, ".claude", "skills"),
      join(cwd, "local-skills"),
    ]);
    assert.deepEqual(r.warnings, []);
  });

  test("drops missing paths with a warning (non-fatal)", () => {
    const r = loadSkillsExtension({
      cwd,
      home,
      skillPaths: ["~/.claude/skills", "~/does-not-exist"],
    });
    assert.deepEqual(r.additionalSkillPaths, [join(home, ".claude", "skills")]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /not found/);
    // One valid path remains, so still "configured".
    assert.equal(r.status, "configured");
  });

  test("--no-skills with no valid paths → status 'disabled', passthrough", () => {
    const r = loadSkillsExtension({ cwd, home, noSkills: true });
    assert.equal(r.status, "disabled");
    assert.equal(r.noSkills, true);
    assert.deepEqual(r.additionalSkillPaths, []);
  });

  test("--skill is additive even with --no-skills", () => {
    const r = loadSkillsExtension({
      cwd,
      home,
      noSkills: true,
      skillPaths: ["~/.claude/skills"],
    });
    // Pi loads explicit paths even when default discovery is off.
    assert.equal(r.status, "configured");
    assert.equal(r.noSkills, true);
    assert.deepEqual(r.additionalSkillPaths, [join(home, ".claude", "skills")]);
  });
});

describe("buildSkillsStatusEvent (gated)", () => {
  const result = (over: Partial<SkillsResult> = {}): SkillsResult => ({
    status: "default",
    additionalSkillPaths: [],
    noSkills: false,
    warnings: [],
    ...over,
  });
  const skill = (name: string): SkillSummary => ({
    name,
    source: `/skills/${name}/SKILL.md`,
    modelInvocable: true,
  });

  test("suppressed on a default run with no skills (keeps fixtures byte-identical)", () => {
    assert.equal(buildSkillsStatusEvent(result(), []), null);
  });

  test("emitted when skills are discovered, even with no flags", () => {
    const ev = buildSkillsStatusEvent(result(), [skill("roll-dice")]);
    assert.ok(ev);
    assert.equal(ev.type, "skills_status");
    assert.equal(ev.status, "default");
    assert.equal(ev.discovered, 1);
    assert.deepEqual(ev.skills, [skill("roll-dice")]);
  });

  test("emitted when explicitly configured, even with zero discovered", () => {
    const ev = buildSkillsStatusEvent(
      result({ status: "configured", additionalSkillPaths: ["/mapped"] }),
      [],
    );
    assert.ok(ev);
    assert.equal(ev.discovered, 0);
    assert.deepEqual(ev.mappedPaths, ["/mapped"]);
  });

  test("emitted on --no-skills (status 'disabled') to confirm discovery is off", () => {
    const ev = buildSkillsStatusEvent(result({ status: "disabled", noSkills: true }), []);
    assert.ok(ev);
    assert.equal(ev.status, "disabled");
    assert.equal(ev.noSkills, true);
    assert.equal(ev.discovered, 0);
  });
});
