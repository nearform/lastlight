// Spike: kill -9 a worker mid-step and resume in a fresh process.
//   node scripts/spike/durable-crash.mjs            (orchestrates both phases)
// Phase "worker": runs `build`; the executor step hangs forever (simulating a
// 30-minute agent run), so the parent SIGKILLs it mid-step. Phase "resume": a
// new process opens the same DB and drives the run to completion once the dead
// worker's lease (30s) expires. Calls are appended to calls.log across both.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , mode, dir] = process.argv;
const here = fileURLToPath(import.meta.url);

async function runtime(dir, hangOn) {
  const { DurableRuntime } = await import("../../dist/workflows/durable/runtime.js");
  const build = (await import("../../dist/workflows/durable/workflows/build.js")).default;
  const out = {
    guardrails: "GATE_PENDING", architect: "plan", executor: "done",
    reviewer: "VERDICT: APPROVED", pr: "https://github.com/o/r/pull/9",
  };
  const reply = async (key) => {
    appendFileSync(join(dir, "calls.log"), `${process.pid} ${key}\n`);
    if (key === hangOn) await new Promise(() => {});
    return { success: true, output: key === "bash" ? "READY — ok" : out[key], turns: 1, durationMs: 1 };
  };
  const rt = new DurableRuntime(join(dir, "workflows.db"), {
    agent: {
      runAgent: (p) => reply(p.replace(/^PROMPT:prompts\//, "").replace(/\.md$/, "")),
      runCommand: () => reply("bash"),
    },
    assets: { loadPromptTemplate: (p) => `PROMPT:${p}`, resolveSkillPaths: (n) => n },
    baseConfig: () => ({}),
  });
  rt.register(build);
  return rt;
}

const input = { vars: { owner: "o", repo: "r", issueTitle: "x", issueLabels: [], issueDir: ".ll", taskId: "t" } };

if (mode === "worker") {
  const rt = await runtime(dir, "executor");
  const h = await rt.start("build", input);
  appendFileSync(join(dir, "run.id"), h.runId);
  await rt.startWorker(1);
} else if (mode === "resume") {
  const rt = await runtime(dir, null);
  const runId = readFileSync(join(dir, "run.id"), "utf8");
  const t0 = Date.now();
  await rt.startWorker(1);
  for (;;) {
    const run = await rt.getRun(runId);
    if (["completed", "succeeded", "failed"].includes(run.status)) {
      console.log(`resumed in ${((Date.now() - t0) / 1000).toFixed(1)}s →`, run.status, JSON.stringify(run.output));
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  await rt.stop();
} else {
  const dir = mkdtempSync(join(tmpdir(), "ll-crash-"));
  const child = spawn(process.execPath, [here, "worker", dir], { stdio: "inherit" });
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    let log = "";
    try { log = readFileSync(join(dir, "calls.log"), "utf8"); } catch {}
    if (log.includes("executor")) break;
  }
  child.kill("SIGKILL");
  console.log("killed worker mid-executor (pid", child.pid + ")");
  await new Promise((r) => child.on("exit", r));
  const resume = spawn(process.execPath, [here, "resume", dir], { stdio: "inherit" });
  await new Promise((r) => resume.on("exit", r));
  console.log("calls across both processes:\n" + readFileSync(join(dir, "calls.log"), "utf8"));
}
