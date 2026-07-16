import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { enumerateOverlayAssets } from "@lastlight/shared/overlay-assets";

function makeTree(): { core: string; overlay: string } {
  const root = mkdtempSync(join(tmpdir(), "overlay-assets-"));
  const core = join(root, "core");
  const overlay = join(root, "instance");
  // Built-in assets.
  mkdirSync(join(core, "workflows", "prompts"), { recursive: true });
  mkdirSync(join(core, "skills", "building"), { recursive: true });
  mkdirSync(join(core, "agent-context"), { recursive: true });
  writeFileSync(join(core, "workflows", "build.yaml"), "kind: build\nname: build\n");
  writeFileSync(join(core, "workflows", "cron-health.yaml"), "kind: cron\nname: cron-health\nworkflow: repo-health\n");
  writeFileSync(join(core, "workflows", "prompts", "architect.md"), "# architect");
  writeFileSync(join(core, "skills", "building", "SKILL.md"), "# building");
  writeFileSync(join(core, "agent-context", "soul.md"), "# soul");
  return { core, overlay };
}

describe("enumerateOverlayAssets", () => {
  let core: string;
  let overlay: string;

  beforeEach(() => {
    ({ core, overlay } = makeTree());
  });

  it("returns [] when no overlay is given or it doesn't exist", () => {
    expect(enumerateOverlayAssets({ coreRoot: core })).toEqual([]);
    expect(enumerateOverlayAssets({ coreRoot: core, overlayRoot: join(overlay, "nope") })).toEqual([]);
  });

  it("tags overlay assets as shadowing a built-in vs added", () => {
    mkdirSync(join(overlay, "workflows", "prompts"), { recursive: true });
    mkdirSync(join(overlay, "skills", "building"), { recursive: true });
    mkdirSync(join(overlay, "skills", "custom"), { recursive: true });
    mkdirSync(join(overlay, "agent-context"), { recursive: true });
    // Shadows the built-in build workflow.
    writeFileSync(join(overlay, "workflows", "build.yaml"), "kind: build\nname: build\n");
    // A brand-new workflow.
    writeFileSync(join(overlay, "workflows", "ship.yaml"), "kind: build\nname: ship\n");
    // Shadows a built-in cron.
    writeFileSync(join(overlay, "workflows", "cron-health.yaml"), "kind: cron\nname: cron-health\nworkflow: repo-health\n");
    // Prompt: one shadowing, none added.
    writeFileSync(join(overlay, "workflows", "prompts", "architect.md"), "# overridden");
    // Skills: building shadows, custom is added.
    writeFileSync(join(overlay, "skills", "building", "SKILL.md"), "# overridden");
    writeFileSync(join(overlay, "skills", "custom", "SKILL.md"), "# custom");
    // Agent-context: soul shadows, extra is added.
    writeFileSync(join(overlay, "agent-context", "soul.md"), "# overridden");
    writeFileSync(join(overlay, "agent-context", "extra.md"), "# extra");

    const assets = enumerateOverlayAssets({ coreRoot: core, overlayRoot: overlay });
    const byKey = new Map(assets.map((a) => [`${a.type}:${a.name}`, a.shadowsDefault]));

    expect(byKey.get("workflow:build")).toBe(true);
    expect(byKey.get("workflow:ship")).toBe(false);
    expect(byKey.get("cron:cron-health")).toBe(true);
    expect(byKey.get("prompt:architect.md")).toBe(true);
    expect(byKey.get("skill:building")).toBe(true);
    expect(byKey.get("skill:custom")).toBe(false);
    expect(byKey.get("agent-context:soul.md")).toBe(true);
    expect(byKey.get("agent-context:extra.md")).toBe(false);
  });

  it("keys workflows by YAML name, not filename, and splits cron vs workflow", () => {
    mkdirSync(join(overlay, "workflows"), { recursive: true });
    // Filename differs from the logical name.
    writeFileSync(join(overlay, "workflows", "my-build.yaml"), "kind: build\nname: build\n");
    const assets = enumerateOverlayAssets({ coreRoot: core, overlayRoot: overlay });
    expect(assets).toContainEqual({ type: "workflow", name: "build", shadowsDefault: true });
  });

  it("treats everything as 'added' when there are no built-ins to compare", () => {
    mkdirSync(join(overlay, "skills", "custom"), { recursive: true });
    writeFileSync(join(overlay, "skills", "custom", "SKILL.md"), "# custom");
    const assets = enumerateOverlayAssets({ overlayRoot: overlay });
    expect(assets).toEqual([{ type: "skill", name: "custom", shadowsDefault: false }]);
  });
});
