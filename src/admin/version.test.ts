import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock execFile so getServerVersion's git calls return controllable output.
// promisify(execFile) calls execFile(file, args, opts, cb) — invoke cb here.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { getServerVersion } from "./version.js";

const OV = "/tmp/test-overlay";
let responses: Record<string, string | Error>;

beforeEach(() => {
  process.env.LASTLIGHT_OVERLAY_DIR = OV;
  responses = {};
  execFileMock.mockImplementation((_file: string, args: string[], opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as (e: Error | null, r?: { stdout: string; stderr: string }) => void;
    const r = responses[args.join(" ")];
    if (r instanceof Error) callback(r);
    else callback(null, { stdout: r ?? "", stderr: "" });
  });
});

afterEach(() => {
  delete process.env.LASTLIGHT_GIT_SHA;
  delete process.env.LASTLIGHT_OVERLAY_DIR;
  vi.restoreAllMocks();
});

const coreLsRemote = "ls-remote https://github.com/cliftonc/lastlight HEAD";
const overlayRevParse = `-C ${OV} rev-parse HEAD`;
const overlayLsRemote = `-C ${OV} ls-remote origin HEAD`;

describe("getServerVersion", () => {
  it("flags core behind when current SHA differs from remote", async () => {
    process.env.LASTLIGHT_GIT_SHA = "aaaa1111aaaa1111";
    responses[coreLsRemote] = "bbbb2222bbbb2222\tHEAD";
    responses[overlayRevParse] = "cccc3333";
    responses[overlayLsRemote] = "cccc3333\tHEAD";

    const v = await getServerVersion();
    expect(v.core.current).toBe("aaaa1111aaaa1111");
    expect(v.core.latest).toBe("bbbb2222bbbb2222");
    expect(v.core.behind).toBe(true);
    expect(v.overlay.behind).toBe(false); // equal SHAs
  });

  it("is not behind when current matches remote", async () => {
    process.env.LASTLIGHT_GIT_SHA = "deadbeefdeadbeef";
    responses[coreLsRemote] = "deadbeefdeadbeef\tHEAD";
    responses[overlayRevParse] = "1111";
    responses[overlayLsRemote] = "1111\tHEAD";

    const v = await getServerVersion();
    expect(v.core.behind).toBe(false);
  });

  it("treats an unreachable remote as unknown, never behind", async () => {
    process.env.LASTLIGHT_GIT_SHA = "aaaa1111";
    responses[coreLsRemote] = new Error("network down");
    responses[overlayRevParse] = "2222";
    responses[overlayLsRemote] = new Error("no auth");

    const v = await getServerVersion();
    expect(v.core.current).toBe("aaaa1111");
    expect(v.core.latest).toBeNull();
    expect(v.core.behind).toBe(false);
    expect(v.overlay.current).toBe("2222");
    expect(v.overlay.latest).toBeNull();
    expect(v.overlay.behind).toBe(false);
  });

  it("reports core.current null when the SHA wasn't baked", async () => {
    responses[coreLsRemote] = "abcd1234\tHEAD";
    responses[overlayRevParse] = "3333";
    responses[overlayLsRemote] = "3333\tHEAD";

    const v = await getServerVersion();
    expect(v.core.current).toBeNull();
    expect(v.core.behind).toBe(false); // unknown current → not behind
  });
});
