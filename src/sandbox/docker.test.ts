import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
    // create() runs `docker run` via execFileSync and polls readiness via
    // execFile (promisified). Stub both so create() can be exercised without a
    // real docker daemon.
    execFileSync: vi.fn().mockReturnValue("container-xyz\n"),
    execFile: vi.fn((_cmd: string, _args: string[], opts: unknown, cb?: unknown) => {
      const done = (typeof opts === "function" ? opts : cb) as (e: unknown, r: unknown) => void;
      done(null, { stdout: "", stderr: "" });
    }),
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true), readFileSync: vi.fn().mockReturnValue("{}") };
});

import { spawn, execFileSync } from "child_process";
import { DockerSandbox } from "./docker.js";

const mockSpawn = vi.mocked(spawn);
const mockExecFileSync = vi.mocked(execFileSync);

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

  it("agentic-pi command runs in --sandbox none mode and does not embed the prompt", async () => {
    const runPromise = manager.runAgent("task-001", "test prompt");
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
    const shCmd = dockerArgs[dockerArgs.length - 1];
    expect(shCmd).toContain("agentic-pi run");
    expect(shCmd).toContain("--sandbox none");
    expect(shCmd).not.toContain("--no-file-search");
    expect(shCmd).not.toContain("test prompt");
  });
});

describe("DockerSandbox.create — shared package cache (issue #107)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue("container-xyz\n");
  });

  function dockerRunArgv(): string[] {
    const call = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
    );
    return (call?.[1] as string[]) ?? [];
  }

  it("mounts the shared cache volume and wires npm/pnpm/yarn env", async () => {
    const manager = new DockerSandbox({ imageName: "img", env: {} });
    await manager.create({
      taskId: "repo-1-pr-review",
      worktreePath: "/tmp/work",
      workspaceMount: { type: "bind", hostPath: "/tmp/work" },
    });
    const argv = dockerRunArgv();
    expect(argv).toContain("lastlight_pkg-cache:/cache");
    expect(argv).toContain("npm_config_cache=/cache/npm");
    expect(argv).toContain("npm_config_store_dir=/cache/pnpm");
    expect(argv).toContain("YARN_CACHE_FOLDER=/cache/yarn");
  });

  it("honours LASTLIGHT_PKG_CACHE_VOLUME override", async () => {
    const prev = process.env.LASTLIGHT_PKG_CACHE_VOLUME;
    process.env.LASTLIGHT_PKG_CACHE_VOLUME = "my-cache";
    try {
      const manager = new DockerSandbox({ imageName: "img", env: {} });
      await manager.create({
        taskId: "t",
        worktreePath: "/tmp/work",
        workspaceMount: { type: "bind", hostPath: "/tmp/work" },
      });
      expect(dockerRunArgv()).toContain("my-cache:/cache");
    } finally {
      if (prev === undefined) delete process.env.LASTLIGHT_PKG_CACHE_VOLUME;
      else process.env.LASTLIGHT_PKG_CACHE_VOLUME = prev;
    }
  });
});
