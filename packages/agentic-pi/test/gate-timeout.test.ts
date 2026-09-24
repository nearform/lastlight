import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  type BashOperations,
  createBashTool,
  createBashToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  applyGateTimeout,
  gateTimeoutGuideline,
  isGateCommand,
  resolveGateTimeout,
  withGateTimeout,
} from "../src/gate-timeout.js";

/** Fake BashOperations that records the timeout (seconds) each exec was given. */
function recordingOps(): { ops: BashOperations; timeouts: Array<number | undefined> } {
  const timeouts: Array<number | undefined> = [];
  return {
    timeouts,
    ops: {
      exec: async (_command, _cwd, options) => {
        timeouts.push(options.timeout);
        options.onData(Buffer.from("ok\n"));
        return { exitCode: 0 };
      },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callBash(tool: ToolDefinition<any, any, any>, command: string, timeout?: number) {
  await tool.execute("call-1", { command, timeout }, undefined, undefined, {} as any);
}

describe("isGateCommand", () => {
  for (const cmd of [
    "pnpm install --frozen-lockfile",
    "pnpm --filter lastlight-core test",
    "npm ci",
    "npm run test:unit",
    "yarn run build",
    "bun test",
    "pnpm exec vitest run tests/x.test.ts",
    "npx vitest run",
    "cd apps/server && pnpm turbo run typecheck test build",
    "pytest -q",
    "cargo test --all",
    "go test ./...",
    "make test",
  ]) {
    test(`matches: ${cmd}`, () => assert.equal(isGateCommand(cmd), true));
  }
  for (const cmd of [
    "ls -la",
    "git status",
    "cat package.json | grep test",
    "pnpm --version",
    "grep -rn install src/",
  ]) {
    test(`does not match: ${cmd}`, () => assert.equal(isGateCommand(cmd), false));
  }
});

describe("resolveGateTimeout", () => {
  test("raises a smaller timeout on a gate command", () => {
    assert.equal(resolveGateTimeout("pnpm test", 120, 900), 900);
  });
  test("leaves a non-gate command's timeout alone", () => {
    assert.equal(resolveGateTimeout("ls", 5, 900), 5);
  });
  // The hang fix: an omitted timeout used to mean "no limit", which let a
  // `npx eslint --inspect-config` probe wedge an eval case for 7.5 hours.
  test("bounds an absent timeout at the gate value, gate command or not", () => {
    assert.equal(resolveGateTimeout("pnpm test", undefined, 900), 900);
    assert.equal(resolveGateTimeout("npx eslint --inspect-config", undefined, 900), 900);
    assert.equal(resolveGateTimeout("ls", undefined, 900), 900);
  });
  test("lowers a timeout above the gate value", () => {
    assert.equal(resolveGateTimeout("pnpm test", 1200, 900), 900);
    assert.equal(resolveGateTimeout("node server.js", 86_400, 900), 900);
  });
  test("is total — never returns undefined", () => {
    for (const t of [undefined, 1, 900, 5000]) {
      assert.equal(typeof resolveGateTimeout("ls", t, 900), "number");
    }
  });
});

describe("withGateTimeout", () => {
  test("appends the guideline with the number, keeping Pi's own guidelines", () => {
    const base = createBashToolDefinition("/tmp");
    const wrapped = withGateTimeout(base, 1500);
    const guidelines = wrapped.promptGuidelines ?? [];
    assert.deepEqual(guidelines.slice(0, -1), [...(base.promptGuidelines ?? [])]);
    assert.equal(guidelines.at(-1), gateTimeoutGuideline(1500));
    assert.match(guidelines.at(-1)!, /`timeout: 1500`/);
    assert.match(guidelines.at(-1)!, /echo EXIT=\$\?/);
    assert.equal(base.promptGuidelines?.includes(gateTimeoutGuideline(1500)), false);
  });

  test("clamps the timeout passed to operations: raise gates, cap the rest", async () => {
    const { ops, timeouts } = recordingOps();
    const tool = withGateTimeout(
      createBashToolDefinition("/tmp", { operations: ops, exposeSessionEnvironment: false }),
      600,
    );
    await callBash(tool, "pnpm --filter lastlight-core test", 120);
    await callBash(tool, "ls", 3);
    await callBash(tool, "npx eslint --inspect-config");
    await callBash(tool, "node server.js", 99_999);
    assert.deepEqual(timeouts, [600, 3, 600, 600]);
  });

  test("works on the gondolin-style AgentTool from createBashTool", async () => {
    const { ops, timeouts } = recordingOps();
    const agentTool = createBashTool("/tmp", { operations: ops, exposeSessionEnvironment: false });
    const wrapped = withGateTimeout(agentTool as any, 300);
    assert.equal(wrapped.promptGuidelines?.at(-1), gateTimeoutGuideline(300));
    await callBash(wrapped, "npm ci", 60);
    assert.deepEqual(timeouts, [300]);
  });
});

describe("applyGateTimeout", () => {
  const other = { name: "github_get_issue" } as unknown as ToolDefinition;

  test("unset: returns the tools untouched and never builds a bash", () => {
    const tools = [other];
    let built = false;
    const out = applyGateTimeout(tools, undefined, () => {
      built = true;
      return createBashToolDefinition("/tmp");
    });
    assert.equal(out, tools);
    assert.equal(built, false);
  });

  test("gondolin: wraps the sandbox bash in place, adds no second bash", () => {
    const sandboxTools = [createBashToolDefinition("/tmp"), other];
    const out = applyGateTimeout(sandboxTools, 900, () => createBashToolDefinition("/tmp"));
    assert.equal(out.filter((t) => t.name === "bash").length, 1);
    assert.equal(out[0].promptGuidelines?.at(-1), gateTimeoutGuideline(900));
    assert.equal(out[1], other);
  });

  test("host built-ins: appends a wrapped bash replacement", () => {
    const out = applyGateTimeout([], 900, () => createBashToolDefinition("/tmp"));
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "bash");
    assert.equal(out[0].promptGuidelines?.at(-1), gateTimeoutGuideline(900));
  });

  test("built-ins disabled: no bash is added", () => {
    assert.deepEqual(applyGateTimeout([], 900, undefined), []);
  });
});
