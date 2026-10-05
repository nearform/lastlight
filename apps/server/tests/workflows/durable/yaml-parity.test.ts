import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { runWorkflowCore, AgentWorkflowSchema } from "lastlight-workflow-engine";
import type {
  AgentPort,
  AgentRunOpts,
  CommandSpec,
  ExecutionResult,
  ExecutorConfig,
  GitSandboxAccess,
  PhaseRunContext,
  SchedulerDeps,
  TemplateContext,
} from "lastlight-workflow-engine";
import { InMemoryStateStore, RecordingReporter, noopLiveness, noopObservability } from "lastlight-workflow-engine/test-support";
import type { LastLightWorkflow, WorkflowInput } from "lastlight-workflow-engine/durable";
import { DurableRuntime } from "../../../src/workflows/durable/runtime.js";

/**
 * Differential test for the YAML → TS converter (scripts/yaml-to-ts.mjs).
 *
 * The SAME scripted agent drives (a) the YAML engine on the packaged
 * workflow and (b) the converter's output on the durable runtime; the agent
 * call sequence and the run outcome must match. The converter runs fresh into
 * a temp dir, so this pins the generator, not a checked-in snapshot.
 */

const WORKFLOWS = join(__dirname, "../../../workflows");
const GENERATED = join(__dirname, "../../../src/workflows/durable/generated");

type Script = Record<string, string>;

/** Keys a call by prompt file (`architect`), skill (`skill:fixing`) or `bash`. */
class ScriptedAgent implements AgentPort {
  readonly calls: string[] = [];
  constructor(private readonly script: Script) {}
  private reply(key: string): ExecutionResult {
    this.calls.push(key);
    return { success: true, output: this.script[key] ?? this.script["*"] ?? "ok", turns: 1, durationMs: 1 };
  }
  async runAgent(prompt: string, _c: ExecutorConfig, _o: AgentRunOpts): Promise<ExecutionResult> {
    const file = /^PROMPT:prompts\/(.+)\.md/.exec(prompt)?.[1];
    const skill = /^Use the \*\*(.+?)\*\* skill/.exec(prompt)?.[1];
    return this.reply(file ?? (skill ? `skill:${skill}` : "unknown"));
  }
  async runCommand(_s: CommandSpec, _c: ExecutorConfig, _o: AgentRunOpts): Promise<ExecutionResult> {
    return this.reply("bash");
  }
}

const VARS = {
  owner: "acme", repo: "widgets", issueNumber: 7, prNumber: 7, issueTitle: "Add CSV export", issueBody: "",
  issueLabels: [] as string[], commentBody: "", sender: "alice", branch: "lastlight/7", taskId: "t-7",
  issueDir: ".lastlight/issue-7", bootstrapLabel: "lastlight:bootstrap",
  gate: { timeoutSeconds: 900, phaseTimeoutSeconds: 2400 },
};
const assets = { loadPromptTemplate: (p: string) => `PROMPT:${p}`, resolveSkillPaths: (n: readonly string[]) => [...n] };

async function runYaml(name: string, script: Script, labels: string[] = []) {
  const definition = AgentWorkflowSchema.parse(parse(readFileSync(join(WORKFLOWS, `${name}.yaml`), "utf8")));
  const store = new InMemoryStateStore("run-1");
  const agent = new ScriptedAgent(script);
  const scope: PhaseRunContext = {
    definition,
    ctx: { ...VARS, issueLabels: labels } as unknown as TemplateContext,
    config: { sandbox: "none" } as unknown as ExecutorConfig,
    taskId: "t-7",
    triggerId: "acme/widgets#7",
    githubAccess: { owner: "acme", repo: "widgets", profile: "repo-write" } as GitSandboxAccess,
    scratch: {},
    store,
    workflowId: "run-1",
    botName: "last-light",
  };
  const deps: SchedulerDeps = {
    reporter: new RecordingReporter(),
    resolver: { modelFor: () => undefined, variantFor: () => undefined, renderPrompt: (p) => `PROMPT:${p}`, gateEnabled: () => false },
    ports: { agent, assets, liveness: noopLiveness, observability: noopObservability },
    store,
    reporterActive: false,
    capabilities: { qaImageAvailable: () => true, qaImageName: "qa" },
  };
  const result = await runWorkflowCore(scope, deps);
  return { success: result.success, calls: agent.calls };
}

let dir: string;
let runtimes: DurableRuntime[] = [];

async function runTs(name: string, script: Script, labels: string[] = []) {
  const wf = (await import(join(dir, "gen", `${name}.ts`))).default as LastLightWorkflow;
  const agent = new ScriptedAgent(script);
  const rt = new DurableRuntime(join(dir, `${name}-${runtimes.length}.db`), { agent, assets, baseConfig: () => ({}) });
  runtimes.push(rt);
  rt.register(wf);
  const input: WorkflowInput = { vars: { ...VARS, issueLabels: labels } };
  const h = await rt.start(name, input);
  for (let i = 0; i < 500; i++) {
    await rt.tick();
    await new Promise((r) => setTimeout(r, 10));
    const run = await rt.getRun(h.runId);
    if (run && ["completed", "succeeded", "failed"].includes(run.status)) {
      const out = run.output as { success?: boolean } | null;
      return { success: run.status !== "failed" && out?.success === true, calls: agent.calls };
    }
  }
  throw new Error("TS run did not finish");
}

beforeEach(() => {
  dir = mkdtempSync(join(GENERATED, "..", ".parity-"));
  execFileSync(process.execPath, [join(__dirname, "../../../scripts/yaml-to-ts.mjs"), WORKFLOWS, join(dir, "gen")]);
});

afterEach(async () => {
  for (const rt of runtimes) await rt.stop().catch(() => {});
  runtimes = [];
  rmSync(dir, { recursive: true, force: true });
});

const BUILD_OK: Script = {
  guardrails: "GATE_PENDING", bash: "READY — suite passed", reviewer: "VERDICT: APPROVED",
  "re-reviewer": "VERDICT: APPROVED", pr: "https://github.com/acme/widgets/pull/42", "*": "done",
};

const CASES: { name: string; workflow: string; script: Script; labels?: string[] }[] = [
  { name: "build: happy path", workflow: "build", script: BUILD_OK },
  { name: "build: guardrails BLOCKED", workflow: "build", script: { ...BUILD_OK, guardrails: "BLOCKED — no test runner" } },
  { name: "build: BLOCKED bypassed for a bootstrap issue", workflow: "build", script: { ...BUILD_OK, guardrails: "BLOCKED" }, labels: ["lastlight:bootstrap"] },
  // The YAML substring rule: a READY gate that MENTIONS "blocked" still fails. Parity means the port keeps the quirk.
  { name: "build: 'blocked' in prose fails the gate (YAML quirk)", workflow: "build", script: { ...BUILD_OK, bash: "READY — passed\nwas previously blocked" } },
  { name: "build: reviewer never approves → 2 fix cycles", workflow: "build", script: { ...BUILD_OK, reviewer: "VERDICT: REQUEST_CHANGES", "re-reviewer": "VERDICT: REQUEST_CHANGES" } },
  { name: "build: approved on recheck 1", workflow: "build", script: { ...BUILD_OK, reviewer: "VERDICT: REQUEST_CHANGES" } },
  { name: "pr-fix: diagnose → fix pushes", workflow: "pr-fix", script: { "diagnose-ci": "DIAGNOSIS_COMPLETE: class=code", "pr-fix": "outcome=pushed tried=1\nCI_FIX_COMPLETE: pushed" } },
  { name: "pr-fix: missing diagnosis marker fails", workflow: "pr-fix", script: { "diagnose-ci": "no idea" } },
  { name: "pr-fix: until unmet → until_bash decides", workflow: "pr-fix", script: { "diagnose-ci": "DIAGNOSIS_COMPLETE:", "pr-fix": "CI_FIX_COMPLETE: tried" } },
  { name: "issue-triage", workflow: "issue-triage", script: {} },
  { name: "answer", workflow: "answer", script: {} },
  { name: "security-review", workflow: "security-review", script: {} },
  { name: "repo-health", workflow: "repo-health", script: {} },
  { name: "dependabot-pr-merge", workflow: "dependabot-pr-merge", script: {} },
];

describe("YAML → TS converter parity", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const yaml = await runYaml(c.workflow, c.script, c.labels);
      const ts = await runTs(c.workflow, c.script, c.labels);
      expect(ts.calls).toEqual(yaml.calls);
      expect(ts.success).toBe(yaml.success);
    });
  }
});
