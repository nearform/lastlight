import { describe, expect, it, vi } from "vitest";
import { WebhookEmitter, installWebhookObservers, installWebhooks } from "#src/notify/webhook/emitter.js";
import type { WebhookEndpointConfig, WebhookPayload } from "#src/notify/webhook/types.js";
import type { WorkflowRun } from "#src/state/workflow-run-store.js";
import type { WorkflowApproval } from "#src/state/approval-store.js";

const ep = (over: Partial<WebhookEndpointConfig> = {}): WebhookEndpointConfig => ({
  url: "https://hooks.example.com/services/abc/SECRETPATH",
  secretEnv: "HOOK_SECRET",
  events: ["run.started", "run.approval_requested", "run.finished", "autonomy.held"],
  repos: [],
  ...over,
});
const env = { HOOK_SECRET: "k", OTHER_SECRET: "k2" } as NodeJS.ProcessEnv;
const log = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() });
const payload = (type: WebhookPayload["type"] = "run.started"): WebhookPayload => ({
  type,
  deliveryId: "d-1",
  timestamp: "2026-11-07T10:00:00.000Z",
  text: type,
});
const ok = () => vi.fn(async () => ({ ok: true, attempts: 1, status: 200 }));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("WebhookEmitter", () => {
  it("sends to endpoints whose events include the type and whose repos are empty or include the repo", async () => {
    const deliver = ok();
    const e = new WebhookEmitter({
      endpoints: [
        ep({ url: "https://a.example.com/x" }),
        ep({ url: "https://b.example.com/x", events: ["run.finished"] }),
        ep({ url: "https://c.example.com/x", repos: ["acme/widgets"] }),
        ep({ url: "https://d.example.com/x", repos: ["acme/other"] }),
      ],
      env,
      deliver,
      log: log(),
    });
    e.emit(payload("run.started"), "acme/widgets");
    await flush();
    expect(deliver.mock.calls.map((c) => (c[0] as WebhookEndpointConfig).url)).toEqual([
      "https://a.example.com/x",
      "https://c.example.com/x",
    ]);
    expect(deliver.mock.calls[0][1]).toBe("k");
  });

  it("never sends an env secret, including the endpoint's own, in a payload", async () => {
    const deliver = ok();
    const e = new WebhookEmitter({
      endpoints: [ep({ secretEnv: "HOOK_SIGNING" })],
      env: { HOOK_SIGNING: "hooksecret99", GH_TOKEN: "ghs_abcdefgh12345" } as NodeJS.ProcessEnv,
      deliver,
      log: log(),
    });
    e.emit({ ...payload("run.finished"), result: { status: "failed", error: "ghs_abcdefgh12345 / hooksecret99" } });
    await flush();
    const sent = deliver.mock.calls[0][2] as WebhookPayload;
    expect(sent.result?.error).toBe("[redacted] / [redacted]");
    expect(deliver.mock.calls[0][1]).toBe("hooksecret99");
  });

  it("matches the repo filter case-insensitively, and an unscoped event only reaches unfiltered endpoints", async () => {
    const deliver = ok();
    const e = new WebhookEmitter({
      endpoints: [ep({ url: "https://a.example.com/x", repos: ["Acme/Widgets"] }), ep({ url: "https://b.example.com/x" })],
      env,
      deliver,
      log: log(),
    });
    e.emit(payload(), "acme/widgets");
    e.emit(payload());
    await flush();
    expect(deliver.mock.calls.map((c) => (c[0] as WebhookEndpointConfig).url)).toEqual([
      "https://a.example.com/x",
      "https://b.example.com/x",
      "https://b.example.com/x",
    ]);
  });

  it("returns before delivery resolves", async () => {
    let settled = false;
    const deliver = vi.fn(() => new Promise<{ ok: boolean; attempts: number }>(() => undefined)); // never resolves
    const e = new WebhookEmitter({ endpoints: [ep()], env, deliver, log: log() });
    const ret = e.emit(payload());
    settled = true;
    expect(ret).toBeUndefined();
    expect(settled).toBe(true);
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("logs a failed delivery with the endpoint host only", async () => {
    const l = log();
    const deliver = vi.fn(async () => ({ ok: false, attempts: 4 }));
    new WebhookEmitter({ endpoints: [ep()], env, deliver, log: l }).emit(payload());
    await flush();
    expect(l.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(l.warn.mock.calls);
    expect(logged).toContain("hooks.example.com");
    expect(logged).not.toContain("SECRETPATH");
  });

  it("skips and logs an endpoint whose secret disappeared from the env, never throwing", async () => {
    const l = log();
    const deliver = ok();
    new WebhookEmitter({ endpoints: [ep({ secretEnv: "GONE" })], env, deliver, log: l }).emit(payload());
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalled();
  });

  it("swallows a deliver that rejects", async () => {
    const l = log();
    const deliver = vi.fn(async () => {
      throw new Error("boom");
    });
    new WebhookEmitter({ endpoints: [ep()], env, deliver, log: l }).emit(payload());
    await flush();
    expect(l.warn).toHaveBeenCalled();
  });
});

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowName: "build",
    triggerId: "t",
    owner: "acme",
    repo: "widgets",
    issueNumber: 42,
    currentPhase: "architect",
    phaseHistory: [],
    status: "running",
    startedAt: "2026-11-07T09:00:00Z",
    updatedAt: "2026-11-07T09:00:00Z",
    ...over,
  };
}

function fakeDb() {
  const obs = {
    start: [] as Array<(r: WorkflowRun) => void>,
    approval: [] as Array<(r: WorkflowRun, a: WorkflowApproval) => void>,
    terminal: [] as Array<(r: WorkflowRun, s: "succeeded" | "failed" | "cancelled") => void>,
  };
  const db = {
    runs: {
      addStartObserver: vi.fn((f: (r: WorkflowRun) => void) => obs.start.push(f)),
      addApprovalObserver: vi.fn((f: (r: WorkflowRun, a: WorkflowApproval) => void) => obs.approval.push(f)),
      addTerminalObserver: vi.fn((f: (r: WorkflowRun, s: "succeeded" | "failed" | "cancelled") => void) =>
        obs.terminal.push(f),
      ),
    },
  };
  return { db, obs };
}

function approval(kind: "approve" | "reply"): WorkflowApproval {
  return {
    id: "a-1",
    workflowRunId: "run-1",
    gate: "post_architect",
    summary: "Plan ready",
    status: "pending",
    kind,
    createdAt: "2026-11-07T09:00:00Z",
  };
}

describe("installWebhookObservers", () => {
  const ctx = { botName: "last-light", dashboardBase: "https://ll.example.com" };

  it("maps start, approve-gate and terminal transitions to events, with the repo for filtering", () => {
    const { db, obs } = fakeDb();
    const emit = vi.fn();
    installWebhookObservers(db as never, { emit } as never, ctx);

    obs.start[0](run());
    obs.approval[0](run({ status: "paused" }), approval("approve"));
    obs.approval[0](run({ status: "paused" }), approval("reply"));
    obs.terminal[0](run({ status: "failed", context: { error: "sandbox died" } }), "failed");

    expect(emit.mock.calls.map((c) => [(c[0] as WebhookPayload).type, c[1]])).toEqual([
      ["run.started", "acme/widgets"],
      ["run.approval_requested", "acme/widgets"],
      ["run.finished", "acme/widgets"],
    ]);
    const approvalPayload = emit.mock.calls[1][0] as WebhookPayload;
    expect(approvalPayload.approval?.summary).toBe("Plan ready");
    const finished = emit.mock.calls[2][0] as WebhookPayload;
    expect(finished.result).toEqual({ status: "failed", error: "sandbox died" });
  });

  it("links the PR when the run knows its number", () => {
    const { db, obs } = fakeDb();
    const emit = vi.fn();
    installWebhookObservers(db as never, { emit } as never, ctx);
    obs.terminal[0](run({ status: "succeeded", context: { prNumber: 7 } }), "succeeded");
    expect((emit.mock.calls[0][0] as WebhookPayload).result).toEqual({
      status: "succeeded",
      prUrl: "https://github.com/acme/widgets/pull/7",
    });
  });

  it("an emitter that throws never escapes the observer", () => {
    const { db, obs } = fakeDb();
    installWebhookObservers(db as never, { emit: () => { throw new Error("boom"); } } as never, ctx);
    expect(() => obs.start[0](run())).not.toThrow();
    expect(() => obs.terminal[0](run(), "succeeded")).not.toThrow();
  });
});

describe("installWebhooks", () => {
  it("installs nothing and returns null with no endpoints", () => {
    const { db } = fakeDb();
    expect(installWebhooks(db as never, { webhooks: [], botName: "last-light" }, env, log())).toBeNull();
    expect(db.runs.addStartObserver).not.toHaveBeenCalled();
    expect(db.runs.addApprovalObserver).not.toHaveBeenCalled();
    expect(db.runs.addTerminalObserver).not.toHaveBeenCalled();
  });

  it("returns the emitter and wires the three observers with endpoints", () => {
    const { db } = fakeDb();
    const e = installWebhooks(db as never, { webhooks: [ep()], botName: "last-light", publicUrl: "https://ll.example.com" }, env, log());
    expect(e).toBeInstanceOf(WebhookEmitter);
    expect(db.runs.addStartObserver).toHaveBeenCalledTimes(1);
    expect(db.runs.addApprovalObserver).toHaveBeenCalledTimes(1);
    expect(db.runs.addTerminalObserver).toHaveBeenCalledTimes(1);
  });
});
