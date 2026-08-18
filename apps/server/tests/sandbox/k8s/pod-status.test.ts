import { describe, it, expect } from "vitest";
import {
  containerStartState,
  initContainerFailure,
  terminalResult,
} from "#src/sandbox/k8s/pod-status.js";

describe("terminalResult", () => {
  it("returns undefined while the pod is still running", () => {
    expect(
      terminalResult({
        phase: "Running",
        containerStatuses: [{ state: { running: {} } }],
      } as any),
    ).toBeUndefined();
  });

  it("returns undefined for an undefined status", () => {
    expect(terminalResult(undefined)).toBeUndefined();
  });

  it("resolves a terminated container's exit code 0 as not timed out", () => {
    expect(
      terminalResult({
        phase: "Succeeded",
        containerStatuses: [{ state: { terminated: { exitCode: 0 } } }],
      } as any),
    ).toEqual({ exitCode: 0, timedOut: false });
  });

  it("resolves a terminated container's non-zero exit code", () => {
    expect(
      terminalResult({
        phase: "Failed",
        containerStatuses: [{ state: { terminated: { exitCode: 2 } } }],
      } as any),
    ).toEqual({ exitCode: 2, timedOut: false });
  });

  it("falls back to phase-only exit code when there is no container status", () => {
    expect(terminalResult({ phase: "Succeeded" } as any)).toEqual({
      exitCode: 0,
      timedOut: false,
    });
    expect(terminalResult({ phase: "Failed" } as any)).toEqual({
      exitCode: 1,
      timedOut: false,
    });
  });

  it("flags DeadlineExceeded at the pod-status level as timed out", () => {
    expect(terminalResult({ phase: "Failed", reason: "DeadlineExceeded" } as any)).toEqual({
      exitCode: 1,
      timedOut: true,
    });
  });

  it("flags DeadlineExceeded at the container-terminated level as timed out", () => {
    expect(
      terminalResult({
        phase: "Failed",
        containerStatuses: [
          { state: { terminated: { exitCode: 137, reason: "DeadlineExceeded" } } },
        ],
      } as any),
    ).toEqual({ exitCode: 137, timedOut: true });
  });
});

describe("containerStartState", () => {
  it("is 'started' once the container is running", () => {
    expect(
      containerStartState({ containerStatuses: [{ state: { running: {} } }] } as any),
    ).toBe("started");
  });

  it("is 'started' once the container has terminated", () => {
    expect(
      containerStartState({
        containerStatuses: [{ state: { terminated: { exitCode: 0 } } }],
      } as any),
    ).toBe("started");
  });

  it("is 'started' when the pod phase already reached Succeeded/Failed", () => {
    expect(containerStartState({ phase: "Succeeded" } as any)).toBe("started");
    expect(containerStartState({ phase: "Failed" } as any)).toBe("started");
  });

  it("is 'waiting' for a non-fatal waiting reason", () => {
    expect(
      containerStartState({
        phase: "Pending",
        containerStatuses: [{ state: { waiting: { reason: "ContainerCreating" } } }],
      } as any),
    ).toBe("waiting");
  });

  it("is 'waiting' for an undefined status", () => {
    expect(containerStartState(undefined)).toBe("waiting");
  });

  it("classifies ImagePullBackOff as fatal, carrying the message through", () => {
    expect(
      containerStartState({
        phase: "Pending",
        containerStatuses: [
          {
            state: {
              waiting: { reason: "ImagePullBackOff", message: 'back-off pulling image "nope"' },
            },
          },
        ],
      } as any),
    ).toEqual({ fatal: "ImagePullBackOff", message: 'back-off pulling image "nope"' });
  });

  it("classifies every FATAL_WAITING_REASONS entry as fatal", () => {
    for (const reason of [
      "ImagePullBackOff",
      "ErrImagePull",
      "InvalidImageName",
      "CreateContainerConfigError",
      "CreateContainerError",
    ]) {
      expect(
        containerStartState({
          containerStatuses: [{ state: { waiting: { reason } } }],
        } as any),
      ).toEqual({ fatal: reason, message: undefined });
    }
  });
});

describe("initContainerFailure", () => {
  it("returns undefined when there are no init containers", () => {
    expect(initContainerFailure(undefined)).toBeUndefined();
    expect(initContainerFailure([])).toBeUndefined();
  });

  it("returns undefined while every init container is still progressing normally", () => {
    expect(
      initContainerFailure([
        { name: "clone", state: { waiting: { reason: "PodInitializing" } } },
      ] as any),
    ).toBeUndefined();
  });

  it("classifies a non-zero terminated exit as a failure, message includes reason + detail", () => {
    expect(
      initContainerFailure([
        {
          name: "clone",
          state: {
            terminated: {
              exitCode: 128,
              reason: "Error",
              message: "fatal: could not read Username",
            },
          },
        },
      ] as any),
    ).toEqual({
      name: "clone",
      message: "failed (exit 128): Error — fatal: could not read Username",
    });
  });

  it("does not classify a zero-exit terminated init container as a failure", () => {
    expect(
      initContainerFailure([
        { name: "clone", state: { terminated: { exitCode: 0, reason: "Completed" } } },
      ] as any),
    ).toBeUndefined();
  });

  it("classifies a fatal waiting reason on an init container", () => {
    expect(
      initContainerFailure([
        { name: "skills", state: { waiting: { reason: "ErrImagePull", message: "no such host" } } },
      ] as any),
    ).toEqual({ name: "skills", message: "cannot start: ErrImagePull — no such host" });
  });

  it("returns the first failing init container when several are present", () => {
    expect(
      initContainerFailure([
        { name: "ok", state: { terminated: { exitCode: 0 } } },
        { name: "clone", state: { terminated: { exitCode: 1, reason: "Error" } } },
        { name: "skills", state: { waiting: { reason: "ImagePullBackOff" } } },
      ] as any),
    ).toEqual({ name: "clone", message: "failed (exit 1): Error" });
  });
});
