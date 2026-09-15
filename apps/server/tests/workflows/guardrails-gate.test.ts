import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkflow } from "#src/workflows/loader.js";
import { renderTemplate, validateShellCommand, type TemplateContext } from "lastlight-workflow-engine";

/**
 * Issue #385 — build's guardrails verdict is decided by the full test suite's
 * EXIT CODE, run once by the harness (`guardrails_gate`, a `type: bash` phase),
 * never by the model reading output. These tests execute the rendered command
 * for real against a fake checkout.
 */

const def = getWorkflow("build");
const gatePhase = def.phases.find((p) => p.name === "guardrails_gate")!;

describe("build.yaml guardrails phases — shape", () => {
  it("runs the setup agent, then the deterministic gate, then the architect", () => {
    const names = def.phases.map((p) => p.name);
    expect(names.slice(1, 4)).toEqual(["guardrails", "guardrails_gate", "architect"]);
  });

  it("gate is a bash phase bounded by config, with BLOCKED → fail + bootstrap bypass", () => {
    expect(gatePhase.type).toBe("bash");
    expect(gatePhase.timeout_seconds).toEqual({ from: "gate.phaseTimeoutSeconds" });
    expect(gatePhase.command).toContain("{{gate.timeoutSeconds}}");
    const blocked = gatePhase.on_output?.contains_BLOCKED;
    expect(blocked?.action).toBe("fail");
    expect(blocked?.unless_label).toBe("lastlight:bootstrap");
    expect(blocked?.unless_title_matches).toBeTruthy();
    expect(gatePhase.messages?.on_success).toMatch(/^READY/);
  });

  it("no timeout in build.yaml is a literal or carries a default", () => {
    for (const p of def.phases) {
      if (p.timeout_seconds === undefined) continue;
      expect(p.timeout_seconds).toEqual({ from: "gate.phaseTimeoutSeconds" });
    }
    for (const name of ["guardrails", "executor", "reviewer"]) {
      expect(def.phases.find((p) => p.name === name)?.timeout_seconds).toEqual({ from: "gate.phaseTimeoutSeconds" });
    }
  });
});

describe("build.yaml guardrails_gate — rendered command verdicts", () => {
  let repo: string;
  let shim: string;
  const hasTimeout = spawnSync("sh", ["-c", "command -v timeout"]).status === 0;

  function render(ctx: Partial<TemplateContext> = {}): string {
    const cmd = renderTemplate(gatePhase.command!, {
      issueDir: "../.lastlight/build-7",
      gate: { timeoutSeconds: 900, phaseTimeoutSeconds: 2400 },
      ...ctx,
    } as TemplateContext);
    validateShellCommand(cmd);
    return cmd;
  }

  /** Run the command in the checkout; `pathPrefix` lets a test inject a `timeout` shim. */
  function run(cmd: string, pathPrefix?: string) {
    const env = { ...process.env, PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH };
    const r = spawnSync("sh", ["-c", cmd], { cwd: repo, env, encoding: "utf-8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  const issueDir = () => join(repo, "..", ".lastlight", "build-7");
  const status = () => readFileSync(join(issueDir(), "status.md"), "utf-8");
  const reportText = () => readFileSync(join(issueDir(), "guardrails-report.md"), "utf-8");
  const writeGate = (body: string) => writeFileSync(join(repo, ".git", "lastlight-gate.sh"), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);

  /** A `timeout` stand-in: `always124` simulates expiry; otherwise it runs the command unbounded. */
  function makeShim(always124: boolean): string {
    const dir = join(shim, always124 ? "t124" : "pass");
    mkdirSync(dir, { recursive: true });
    const body = always124
      ? "#!/bin/sh\nexit 124\n"
      : '#!/bin/sh\n[ "$1" = "-k" ] && shift 2\nshift\nexec "$@"\n';
    writeFileSync(join(dir, "timeout"), body);
    chmodSync(join(dir, "timeout"), 0o755);
    return dir;
  }

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "ll-gate-"));
    repo = join(root, "repo");
    shim = join(root, "shim");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(root, ".lastlight", "build-7"), { recursive: true });
    writeFileSync(join(root, ".lastlight", "build-7", "status.md"), "current_phase: guardrails\nguardrails_status: GATE_PENDING\n");
    writeFileSync(join(root, ".lastlight", "build-7", "guardrails-report.md"), "# Guardrails\n");
  });
  afterEach(() => rmSync(join(repo, ".."), { recursive: true, force: true }));

  it("exit 0 → READY, status + report record the run", () => {
    writeGate('echo "Tests  42 passed"');
    const r = run(render(), makeShim(false));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^READY — full test suite passed \(exit 0\) in \d+s$/);
    expect(status()).toContain("guardrails_status: READY");
    expect(status()).not.toContain("GATE_PENDING");
    expect(status()).toContain("current_phase: guardrails");
    expect(reportText()).toContain("Full test suite gate");
    expect(reportText()).toContain("Tests  42 passed");
    expect(reportText()).toContain("gate.timeoutSeconds=900s");
  });

  it("non-zero → BLOCKED with the exit code and the log tail", () => {
    writeGate('echo "FAIL tests/x.test.ts"; exit 3');
    const r = run(render(), makeShim(false));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^BLOCKED — full test suite failed \(exit 3\)/);
    expect(r.stdout).toContain("FAIL tests/x.test.ts");
    expect(status()).toContain("guardrails_status: BLOCKED");
    expect(reportText()).toContain("Exit code: 3");
  });

  it("exit 124 → BLOCKED telling the operator to raise gate.timeoutSeconds", () => {
    writeGate("sleep 1");
    const r = run(render(), makeShim(true));
    expect(r.stdout).toContain(
      "BLOCKED — full test suite did not finish within gate.timeoutSeconds (900s) — raise gate.timeoutSeconds in the overlay or .lastlight/lastlight.yml",
    );
    expect(status()).toContain("guardrails_status: BLOCKED");
  });

  it.skipIf(!hasTimeout)("a real coreutils timeout expiring → BLOCKED timeout reason", () => {
    writeGate("sleep 20");
    const r = run(render({ gate: { timeoutSeconds: 1 } } as Partial<TemplateContext>));
    expect(r.stdout).toContain("did not finish within gate.timeoutSeconds (1s)");
  });

  it("missing gate script → BLOCKED", () => {
    const r = run(render(), makeShim(false));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("BLOCKED — guardrails did not produce a gate command (.git/lastlight-gate.sh is missing)");
    expect(status()).toContain("guardrails_status: BLOCKED");
  });

  it("unresolved gate.timeoutSeconds → BLOCKED, never an unbounded run", () => {
    writeGate("echo ok");
    const r = run(render({ gate: undefined } as Partial<TemplateContext>), makeShim(false));
    expect(r.stdout).toMatch(/^BLOCKED — gate.timeoutSeconds is not set/);
  });

  it("status already READY → skips the suite", () => {
    writeFileSync(join(issueDir(), "status.md"), "guardrails_status: READY\n");
    writeGate("echo SHOULD-NOT-RUN; exit 1");
    const r = run(render(), makeShim(false));
    expect(r.stdout.trim()).toMatch(/^READY — guardrails already verified/);
    expect(existsSync(join(repo, ".git", "lastlight-gate.log"))).toBe(false);
  });

  it("bootstrap build → READY without a gate script", () => {
    writeFileSync(join(issueDir(), "status.md"), "guardrails_status: BOOTSTRAP\n");
    const r = run(render(), makeShim(false));
    expect(r.stdout.trim()).toMatch(/^READY — bootstrap build/);
  });

  it("BOOTSTRAP never waives an existing suite: a gate script present still runs and can BLOCK", () => {
    writeFileSync(join(issueDir(), "status.md"), "guardrails_status: BOOTSTRAP\n");
    writeGate("exit 3");
    const r = run(render(), makeShim(false));
    expect(r.stdout).toMatch(/BLOCKED — full test suite failed \(exit 3\)/);
  });

  it("with no `timeout` binary on PATH, still judges by exit code", () => {
    writeGate("exit 5");
    // A PATH with the shell basics but no coreutils `timeout` (macOS / `--sandbox none` hosts).
    const bin = join(shim, "notimeout");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["bash", "grep", "date", "tail", "mkdir", "mv", "cat"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
      if (found) spawnSync("ln", ["-s", found, join(bin, tool)]);
    }
    const r = spawnSync("/bin/sh", ["-c", render()], { cwd: repo, env: { PATH: bin }, encoding: "utf-8" });
    expect(r.stdout).toMatch(/^BLOCKED — full test suite failed \(exit 5\)/);
  });
});
