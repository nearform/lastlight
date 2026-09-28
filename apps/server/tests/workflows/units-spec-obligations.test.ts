import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkflow } from "#src/workflows/loader.js";
import { renderTemplate, validateShellCommand } from "lastlight-workflow-engine";
import type { TemplateContext } from "lastlight-workflow-engine";
import type { PrState } from "#src/engine/pr-state.js";
import { renderContext, specObligationsLine } from "#src/engine/pr-decisions.js";
import type { SpecObligationSet } from "#src/engine/review-spec.js";
import { defaultDependenciesConfig, defaultFixConfig } from "lastlight-shared/config-types";
import { defaultReviewConfig } from "#src/config/config.js";

/**
 * The spec obligations reach the sandbox through ONE channel: the `units` bash
 * node writes `specObligationsJson` (projected by `specContext`) into
 * `.lastlight/pr-review/spec-obligations.json` through a quoted heredoc. The
 * value is built from a PR body and linked issues — text a stranger wrote — so
 * what is pinned here is the whole chain, run for real: the template renderer
 * (no escaping, no re-scan of substituted values), the `{{` command guard, and
 * `sh` itself. The bytes written must parse back to the identical object.
 */

const units = getWorkflow("pr-review").phases.find((p) => p.name === "units");
if (!units?.command) throw new Error("pr-review.yaml has no `units` bash command");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "units-spec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Render the node exactly as the bash phase does, guard it, and run it with `sh` in a temp checkout. */
function runUnitsNode(ctx: Record<string, unknown>): { stdout: string; command: string } {
  const command = renderTemplate(units!.command!, ctx as unknown as TemplateContext);
  validateShellCommand(command);
  // A stand-in `lastlight-facts` that does nothing, so the node's shell
  // fallback writes units.json — this test is about the file written BEFORE it.
  const bin = join(dir, "fake-facts");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  const stdout = execFileSync("sh", ["-c", command], {
    cwd: dir,
    env: { ...process.env, LASTLIGHT_FACTS_BIN: bin },
    encoding: "utf8",
  });
  return { stdout, command };
}

const SPEC_FILE = () => join(dir, ".lastlight", "pr-review", "spec-obligations.json");

const HOSTILE: SpecObligationSet = {
  obligations: [
    {
      id: "S-1",
      criterion:
        `Quotes "double" and 'single', $(rm -rf /) and \`id\`, $HOME, a {{template}} and {{{triple}}}, ` +
        "<!-- a comment --> & <tag>, a backslash \\ and \\n literal,\na real newline,\r\na CRLF, a tab\there, " +
        "unicode ✓   separator, and on its own line:\nLASTLIGHT_SPEC_EOF\nthen more",
      source: "issue #7",
      candidates: ["src/a.ts", "src/${evil}.ts"],
      changedFileCount: 2,
      found: false,
      question: "Which line does ${this}? {{#if x}}y{{/if}}",
    },
  ],
  dropped: 0,
  changedFileCount: 2,
  degraded: ["LASTLIGHT_SPEC_EOF", "}}{{"],
};

describe("units node — spec-obligations.json through a quoted heredoc", () => {
  it("writes bytes that parse back to the identical object, whatever the criterion holds", () => {
    const line = specObligationsLine(HOSTILE);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("{{");
    const { stdout } = runUnitsNode({ specObligationsJson: line });

    const written = readFileSync(SPEC_FILE(), "utf8");
    expect(JSON.parse(written)).toEqual(HOSTILE);
    // The heredoc adds exactly one newline and nothing else.
    expect(written).toBe(`${line}\n`);
    expect(stdout).toMatch(/units: spec obligations written, *\d+ bytes/);
    // …and the node went on to its own work: the fallback document exists.
    expect(existsSync(join(dir, ".lastlight", "pr-review", "units.json"))).toBe(true);
  });

  it("no set writes no file, and removes a stale one from a reused workspace", () => {
    mkdirSync(join(dir, ".lastlight", "pr-review"), { recursive: true });
    writeFileSync(SPEC_FILE(), '{"stale":true}');
    const { stdout, command } = runUnitsNode({});
    expect(existsSync(SPEC_FILE())).toBe(false);
    expect(command).not.toContain("LASTLIGHT_SPEC_EOF");
    expect(stdout).toContain("units: no spec obligations for this PR");
  });

  it("projects the raw set, and a degraded one, and nothing with the pipeline off", () => {
    const pr = {
      repo: "acme/widgets",
      prNumber: 7,
      headSha: "abc",
      body: '## Acceptance criteria\n- [ ] Tokens with a "{{" in them expire after $(date) seconds\n',
      closes: [],
      changedFiles: ["src/tokens.ts"],
      labels: [],
    } as unknown as PrState;
    const review = defaultReviewConfig();
    const on = { ...review, analysis: { ...review.analysis, enabled: true } };
    const ctx = renderContext(pr, defaultFixConfig(), defaultDependenciesConfig(), on) as unknown as Record<string, unknown>;
    const set = JSON.parse(String(ctx.specObligationsJson)) as SpecObligationSet;
    expect(set.obligations[0]?.criterion).toContain('"{{"');
    // End to end: rendered, guarded and written by `sh`.
    runUnitsNode(ctx);
    expect(JSON.parse(readFileSync(SPEC_FILE(), "utf8"))).toEqual(set);

    // A DEGRADED set still projects — "we could not look" must stay
    // distinguishable from "nothing to say" (locked decision 6) — as the raw
    // set with its reason, not only as prose.
    const degraded = renderContext(
      { ...pr, body: "Refactor, no behaviour change." } as PrState,
      defaultFixConfig(),
      defaultDependenciesConfig(),
      on,
    ) as unknown as Record<string, unknown>;
    const dset = JSON.parse(String(degraded.specObligationsJson)) as SpecObligationSet;
    expect(dset.obligations).toEqual([]);
    expect(dset.degraded.length).toBeGreaterThan(0);

    // Pipeline off: no key, so the node writes nothing.
    const off = renderContext(pr, defaultFixConfig(), defaultDependenciesConfig(), review) as unknown as Record<string, unknown>;
    expect("specObligationsJson" in off).toBe(false);
  });
});
