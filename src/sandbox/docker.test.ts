import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true), readFileSync: vi.fn().mockReturnValue("{}") };
});

import { spawn } from "child_process";
import { DockerSandbox } from "./docker.js";

const mockSpawn = vi.mocked(spawn);

function makeFakeChild() {
  const stdin = { write: vi.fn(), end: vi.fn() };
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: vi.fn() });
  return child as unknown as ReturnType<typeof spawn> & {
    stdin: typeof stdin;
    stdout: typeof stdout;
    stderr: typeof stderr;
  };
}

describe("DockerSandbox.runAgent — prompt via stdin, not shell arg", () => {
  let manager: DockerSandbox;
  let fakeChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

    manager = new DockerSandbox({
      imageName: "test-image",
      env: {},
      timeoutSeconds: 5,
    });
    (manager as unknown as { activeContainers: Map<string, unknown> })
      .activeContainers.set("task-001", {
        containerId: "abc123",
        containerName: "test-container",
        worktreePath: "/tmp/work",
      });
  });

  it("spawn is called with stdin: 'pipe'", async () => {
    const runPromise = manager.runAgent("task-001", "hello world");
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const spawnOpts = mockSpawn.mock.calls[0][2] as { stdio: unknown[] };
    expect(spawnOpts.stdio[0]).toBe("pipe");
  });

  it("prompt is written to child.stdin", async () => {
    const prompt = "Do something dangerous'; rm -rf /; echo '";
    const runPromise = manager.runAgent("task-001", prompt);
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    expect(fakeChild.stdin.write).toHaveBeenCalledWith(prompt);
    expect(fakeChild.stdin.end).toHaveBeenCalled();
  });

  it("prompt is not embedded in the docker exec args", async () => {
    const prompt = "secret'; rm -rf /;'";
    const runPromise = manager.runAgent("task-001", prompt);
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const dockerArgs = (mockSpawn.mock.calls[0][1] as string[]).join(" ");
    expect(dockerArgs).not.toContain(prompt);
    expect(dockerArgs).not.toContain("rm -rf");
  });

  it("docker exec args contain -i flag for stdin", async () => {
    const runPromise = manager.runAgent("task-001", "test prompt");
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(dockerArgs).toContain("-i");
  });

  it("opencode command uses --format json and does not embed the prompt", async () => {
    const runPromise = manager.runAgent("task-001", "test prompt");
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
    const shCmd = dockerArgs[dockerArgs.length - 1];
    expect(shCmd).toContain("opencode run");
    expect(shCmd).toContain("--format json");
    expect(shCmd).not.toContain("test prompt");
  });
});
