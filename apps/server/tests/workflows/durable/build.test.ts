import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPort, AgentRunOpts, CommandSpec, ExecutionResult, ExecutorConfig } from "lastlight-workflow-engine";
import {
  defineWorkflow,
  type ApprovalDecision,
  type ApprovalRequest,
  type WorkflowInput,
  type WorkflowServices,
} from "lastlight-workflow-engine/durable";
import { DurableRuntime } from "../../../src/workflows/durable/runtime.js";
import build from "../../../src/workflows/durable/workflows/build.js";

/**
 * Spike acceptance for code-defined durable workflows (docs/plans/durable-workflows/).
 *
 * Each test runs the real OpenWorkflow worker against a temp SQLite file and
 * drives it with `tick()`. "Restart" = stop the runtime and open a NEW one on the
 * same file — nothing survives but the database, exactly as after a deploy.
 */

/** Agent fake keyed by prompt file: the stub asset loader renders a prompt as `PROMPT:<path>`. */
class ScriptedAgent implements AgentPort {
  readonly calls: string[] = [];
  constructor(private readonly script: Record<string, string[] | string>) {}
  private reply(key: string): ExecutionResult {
    this.calls.push(key);
    const entry = this.script[key];
    const output = Array.isArray(entry) ? (entry.shift() ?? "") : (entry ?? "");
    return { success: true, output, turns: 1, durationMs: 1 };
  }
  async runAgent(prompt: string, _c: ExecutorConfig, _o: AgentRunOpts): Promise<ExecutionResult> {
    return this.reply(prompt.replace(/^PROMPT:prompts\//, "").replace(/\.md$/, ""));
  }
  async runCommand(_spec: CommandSpec, _c: ExecutorConfig, _o: AgentRunOpts): Promise<ExecutionResult> {
    return this.reply("bash");
  }
}

class Approvals {
  readonly requests: ApprovalRequest[] = [];
  readonly decided = new Map<string, ApprovalDecision>();
  async request(req: ApprovalRequest) {
    this.requests.push(req);
    return { approvalId: `ap-${this.requests.length}` };
  }
  async decision(runId: string, gate: string) {
    return this.decided.get(`${runId}:${gate}`) ?? null;
  }
}

const HAPPY = {
  guardrails: "GATE_PENDING — install/typecheck/lint ok",
  bash: "READY — full test suite passed (exit 0) in 3s",
  architect: "plan written",
  executor: "implemented",
  reviewer: "VERDICT: APPROVED",
  pr: "Opened https://github.com/o/r/pull/42",
};

const input = (gates: Record<string, boolean> = {}): WorkflowInput => ({
  vars: { owner: "o", repo: "r", issueNumber: 7, issueTitle: "Add CSV export", issueLabels: [], branch: "lastlight/7", issueDir: ".lastlight/issue-7", taskId: "t-7" },
  models: { architect: "m/architect" },
  gates,
  timeouts: { phaseSeconds: 2400, gateSeconds: 900 },
});

let dir: string;
let runtimes: DurableRuntime[];

function services(agent: AgentPort, approvals = new Approvals(), notes: string[] = []): WorkflowServices {
  return {
    agent,
    assets: { loadPromptTemplate: (p) => `PROMPT:${p}`, resolveSkillPaths: (n) => n.map((s) => `/skills/${s}`) },
    baseConfig: () => ({}),
    approvals,
    notify: async (_runId, message) => {
      notes.push(message);
    },
  };
}

function open(svc: WorkflowServices, extra: Parameters<typeof defineWorkflow>[0][] = []): DurableRuntime {
  const rt = new DurableRuntime(join(dir, "workflows.db"), svc);
  rt.register(build);
  for (const wf of extra) rt.register(wf);
  runtimes.push(rt);
  return rt;
}

/** Tick until the run is terminal ("completed"/"failed"/…) or parked on a wait ("parked"). */
async function settle(rt: DurableRuntime, runId: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await rt.tick();
    await new Promise((r) => setTimeout(r, 20));
    const run = await rt.getRun(runId);
    if (run && ["succeeded", "completed", "failed", "canceled"].includes(run.status)) return run.status;
    if (await rt.isParked(runId)) return "parked";
  }
  throw new Error("run did not settle");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ll-durable-"));
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes) await rt.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe("durable build workflow", () => {
  it("runs guardrails → architect → executor → reviewer → pr and returns the PR number", async () => {
    const agent = new ScriptedAgent({ ...HAPPY });
    const rt = open(services(agent));
    const h = await rt.start("build", input());
    expect(await settle(rt, h.runId)).toMatch(/succeeded|completed/);
    expect(await h.result()).toMatchObject({ success: true, prNumber: 42 });
    expect(agent.calls).toEqual(["guardrails", "bash", "architect", "executor", "reviewer", "pr"]);
  });

  it("fails on a BLOCKED guardrails verdict unless the issue is a bootstrap task", async () => {
    const blocked = new ScriptedAgent({ ...HAPPY, guardrails: "BLOCKED — no test runner" });
    const rt = open(services(blocked));
    const h = await rt.start("build", input());
    await settle(rt, h.runId);
    expect(await h.result()).toMatchObject({ success: false, summary: "Guardrails check: BLOCKED" });
    expect(blocked.calls).toEqual(["guardrails"]);

    const boot = new ScriptedAgent({ ...HAPPY, guardrails: "BLOCKED — no test runner" });
    const rt2 = open(services(boot));
    const bootInput = input();
    bootInput.vars.issueLabels = ["lastlight:bootstrap"];
    const h2 = await rt2.start("build", bootInput);
    await settle(rt2, h2.runId);
    expect(await h2.result()).toMatchObject({ success: true });
  });

  it("a word 'BLOCKED' inside prose does not flip a READY status line (the YAML substring rule would)", async () => {
    const agent = new ScriptedAgent({ ...HAPPY, bash: "READY — suite passed\nnote: previously BLOCKED on a flaky test" });
    const rt = open(services(agent));
    const h = await rt.start("build", input());
    await settle(rt, h.runId);
    expect(await h.result()).toMatchObject({ success: true });
  });

  it("parks at post_architect, survives a restart, and resumes on approval without re-running completed steps", async () => {
    const agent = new ScriptedAgent({ ...HAPPY });
    const approvals = new Approvals();
    const rt1 = open(services(agent, approvals));
    const h = await rt1.start("build", input({ post_architect: true }));
    expect(await settle(rt1, h.runId)).toBe("parked");
    expect(approvals.requests.map((r) => r.gate)).toEqual(["post_architect"]);
    expect(approvals.requests[0].message?.("ap-1")).toContain("**Architect analysis complete**");
    await rt1.stop();

    // "Deploy": a fresh runtime + services over the same database.
    const rt2 = open(services(agent, approvals));
    approvals.decided.set(`${h.runId}:post_architect`, { approved: true, by: "alice" });
    expect(await rt2.resolveApproval(h.runId, "post_architect", { approved: true, by: "alice" })).toBe(true);
    expect(await settle(rt2, h.runId)).toMatch(/succeeded|completed/);

    const run = await rt2.getRun(h.runId);
    expect(run?.output).toMatchObject({ success: true, prNumber: 42 });
    // guardrails/bash/architect ran ONCE across both processes; the request step did not re-post.
    expect(agent.calls).toEqual(["guardrails", "bash", "architect", "executor", "reviewer", "pr"]);
    expect(approvals.requests).toHaveLength(1);
  });

  it("a rejection ends the run as failed with the reason", async () => {
    const agent = new ScriptedAgent({ ...HAPPY });
    const rt = open(services(agent));
    const h = await rt.start("build", input({ post_architect: true }));
    await settle(rt, h.runId);
    await rt.resolveApproval(h.runId, "post_architect", { approved: false, reason: "wrong approach" });
    await settle(rt, h.runId);
    expect((await rt.getRun(h.runId))?.output).toMatchObject({ success: false, summary: "Rejected at post_architect: wrong approach" });
    expect(agent.calls).not.toContain("executor");
  });

  it("the reviewer loop caps at maxCycles and still opens the PR", async () => {
    const agent = new ScriptedAgent({ ...HAPPY, reviewer: "VERDICT: REQUEST_CHANGES", "re-reviewer": "VERDICT: REQUEST_CHANGES", fix: "fixed" });
    const notes: string[] = [];
    const rt = open(services(agent, new Approvals(), notes));
    const h = await rt.start("build", input());
    await settle(rt, h.runId);
    expect(await h.result()).toMatchObject({ success: true, prNumber: 42 });
    expect(agent.calls.slice(4)).toEqual(["reviewer", "fix", "re-reviewer", "fix", "re-reviewer", "pr"]);
    expect(notes.some((n) => n.includes("after 2 fix cycles"))).toBe(true);
  });

  it("parks at a fix-cycle gate inside the reviewer loop and resumes into the right cycle after a restart", async () => {
    const agent = new ScriptedAgent({ ...HAPPY, reviewer: "VERDICT: REQUEST_CHANGES", "re-reviewer": "VERDICT: APPROVED", fix: "fixed" });
    const approvals = new Approvals();
    const rt1 = open(services(agent, approvals));
    const h = await rt1.start("build", input({ post_reviewer: true }));
    expect(await settle(rt1, h.runId)).toBe("parked");
    expect(approvals.requests.map((r) => r.gate)).toEqual(["post_reviewer:1"]);
    await rt1.stop();

    const rt2 = open(services(agent, approvals));
    await rt2.resolveApproval(h.runId, "post_reviewer:1", { approved: true });
    await settle(rt2, h.runId);
    expect((await rt2.getRun(h.runId))?.output).toMatchObject({ success: true });
    expect(agent.calls.slice(4)).toEqual(["reviewer", "fix", "re-reviewer", "pr"]);
  });

  it("a decision already in the approval row is honoured without parking (signals are not buffered)", async () => {
    // The runtime drops a signal sent while no step is waiting — e.g. the human
    // approved during the window between the request step and the wait, or the
    // process died there. The approval row is the source of truth, so a replay
    // reads it before parking.
    const agent = new ScriptedAgent({ ...HAPPY });
    const approvals = new Approvals();
    approvals.decision = async (_runId, gate) => (gate === "post_architect" ? { approved: true, by: "early" } : null);
    const rt = open(services(agent, approvals));
    const h = await rt.start("build", input({ post_architect: true }));
    expect(await settle(rt, h.runId)).toMatch(/succeeded|completed/);
    expect(approvals.requests).toHaveLength(1);
    expect(agent.calls).toContain("pr");
  });
});

describe("durable step semantics", () => {
  it("a step's output is available to later steps after a restart (YAML phaseOutputs are empty after resume)", async () => {
    const seen: unknown[] = [];
    const probe = defineWorkflow({
      name: "probe",
      version: "1",
      policy: { gitAccess: "read", workspace: "per-run" },
      async run(ctx) {
        const plan = await ctx.step("plan", async () => ({ files: ["a.ts", "b.ts"] }));
        await ctx.approval("go", { summary: "go?" });
        await ctx.step("use", async () => {
          seen.push(plan);
          return null;
        });
        return { success: true, summary: "ok" };
      },
    });
    const approvals = new Approvals();
    const agent = new ScriptedAgent({});
    const rt1 = open(services(agent, approvals), [probe]);
    const h = await rt1.start("probe", input());
    expect(await settle(rt1, h.runId)).toBe("parked");
    await rt1.stop();

    const rt2 = open(services(agent, approvals), [probe]);
    await rt2.resolveApproval(h.runId, "go", { approved: true });
    await settle(rt2, h.runId);
    expect(seen).toEqual([{ files: ["a.ts", "b.ts"] }]);
  });

  it("parallel() keeps at most `max` branches in flight and memoizes each branch", async () => {
    let inFlight = 0;
    let peak = 0;
    const fan = defineWorkflow({
      name: "fan",
      version: "1",
      policy: { gitAccess: "read", workspace: "per-run" },
      async run(ctx) {
        const out = await ctx.parallel(["s1", "s2", "s3", "s4", "s5"], { max: 2 }, (id) =>
          ctx.step(`site:${id}`, async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 30));
            inFlight--;
            return id.toUpperCase();
          }),
        );
        return { success: true, summary: out.join(",") };
      },
    });
    const rt = open(services(new ScriptedAgent({})), [fan]);
    const h = await rt.start("fan", input());
    await settle(rt, h.runId);
    expect((await rt.getRun(h.runId))?.output).toMatchObject({ summary: "S1,S2,S3,S4,S5" });
    expect(peak).toBe(2);
    expect((await rt.listSteps(h.runId)).filter((s) => s.stepName.startsWith("site:"))).toHaveLength(5);
  });
});
