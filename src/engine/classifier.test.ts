import { describe, it, expect, vi } from "vitest";
import { classifyComment, extractGithubRefFromText } from "./classifier.js";

describe("extractGithubRefFromText", () => {
  it("returns undefined when no github.com URL is present", () => {
    expect(extractGithubRefFromText("hi there")).toBeUndefined();
    expect(extractGithubRefFromText("check cliftonc/lastlight")).toBeUndefined();
  });

  it("extracts owner/repo from a bare github.com URL", () => {
    expect(extractGithubRefFromText("https://github.com/cliftonc/lastlight")).toEqual({
      repo: "cliftonc/lastlight",
    });
  });

  it("extracts from a URL embedded in surrounding text", () => {
    const input = "can you do a security review of https://github.com/cliftonc/lastlight";
    expect(extractGithubRefFromText(input)).toEqual({ repo: "cliftonc/lastlight" });
  });

  it("strips a trailing slash", () => {
    expect(extractGithubRefFromText("https://github.com/cliftonc/lastlight/")).toEqual({
      repo: "cliftonc/lastlight",
    });
  });

  it("strips a trailing punctuation (question mark, comma, period)", () => {
    expect(extractGithubRefFromText("triage https://github.com/foo/bar?")).toEqual({
      repo: "foo/bar",
    });
    expect(extractGithubRefFromText("review https://github.com/foo/bar, please")).toEqual({
      repo: "foo/bar",
    });
    expect(extractGithubRefFromText("scan https://github.com/foo/bar.")).toEqual({
      repo: "foo/bar",
    });
  });

  it("strips a .git suffix", () => {
    expect(extractGithubRefFromText("https://github.com/foo/bar.git")).toEqual({
      repo: "foo/bar",
    });
  });

  it("extracts an issue number from /issues/N URLs", () => {
    expect(
      extractGithubRefFromText("please look at https://github.com/cliftonc/lastlight/issues/42"),
    ).toEqual({ repo: "cliftonc/lastlight", issueNumber: 42 });
  });

  it("extracts a PR number from /pull/N URLs", () => {
    expect(
      extractGithubRefFromText("review https://github.com/foo/bar/pull/7 when you can"),
    ).toEqual({ repo: "foo/bar", issueNumber: 7 });
  });

  it("ignores trailing URL path segments beyond owner/repo when no issue/PR", () => {
    expect(extractGithubRefFromText("https://github.com/foo/bar/tree/main/src")).toEqual({
      repo: "foo/bar",
    });
  });

  it("handles http:// in addition to https://", () => {
    expect(extractGithubRefFromText("http://github.com/foo/bar")).toEqual({
      repo: "foo/bar",
    });
  });

  it("handles repo names with dots and hyphens", () => {
    expect(extractGithubRefFromText("https://github.com/cliftonc/drizzle-cube")).toEqual({
      repo: "cliftonc/drizzle-cube",
    });
    expect(extractGithubRefFromText("https://github.com/user/foo.bar")).toEqual({
      repo: "user/foo.bar",
    });
  });
});

describe("classifyComment — injected chat", () => {
  it("parses build intent responses", async () => {
    const chat = vi.fn().mockResolvedValue("INTENT: BUILD\nREPO: cliftonc/lastlight\nISSUE: 96\nREASON: NONE");
    const r = await classifyComment(
      "@last-light can you build this?",
      { issueTitle: "Introduce one provider-agnostic chat() seam" },
      { chat, defaultFastModel: () => "openai/test" },
    );
    expect(r).toMatchObject({ intent: "build", repo: "cliftonc/lastlight", issueNumber: 96 });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledWith(
      "openai/test",
      expect.arrayContaining([
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("@last-light can you build this?") }),
      ]),
      { maxTokens: 128 },
    );
  });

  it("falls back to a GitHub URL when model output omits repo and issue", async () => {
    const chat = vi.fn().mockResolvedValue("INTENT: SECURITY\nREPO: NONE\nISSUE: NONE\nREASON: NONE");
    const r = await classifyComment(
      "security review https://github.com/foo/bar/pull/7 please",
      {},
      { chat, defaultFastModel: () => "openai/test" },
    );
    expect(r).toMatchObject({ intent: "security", repo: "foo/bar", issueNumber: 7 });
  });

  it("falls back to chat intent when chat rejects", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("network"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await classifyComment("@last-light can you build this?", {}, { chat, defaultFastModel: () => "openai/test" });
    expect(r).toEqual({ intent: "chat" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
