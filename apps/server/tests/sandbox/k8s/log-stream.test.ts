import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { streamPodLog } from "#src/sandbox/k8s/log-stream.js";

describe("streamPodLog", () => {
  it("forwards complete lines and resolves on stream end", async () => {
    const fakeLog = {
      log: vi.fn(async (_ns, _pod, _c, stream: PassThrough) => {
        stream.write('{"type":"a"}\n{"type":"b"}\n');
        stream.end();
        return { abort() {} };
      }),
    } as any;
    const lines: string[] = [];
    await streamPodLog(fakeLog, "ns", "p", "agent", (l) => lines.push(l));
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });
});
