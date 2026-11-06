/**
 * Config → Managed repos: when a removal needs the "follow the App or require
 * approval?" choice, and which confirm text the approval switch shows. The
 * server enforces the same rule (409 would-empty); these decide what the pane
 * asks before it sends anything.
 */
import { describe, it, expect } from "vitest";
import type { ManagedRepos } from "../src/api";
import { followAppCount, followAppPhrase, removeNeedsChoice, showGapSection, toggleConfirmText } from "../src/lib/managed-repos-view";

function view(over: Partial<ManagedRepos>): ManagedRepos {
  return {
    configured: [],
    installation: ["a/one", "a/two", "a/three", "a/four", "a/five", "a/six", "a/seven"],
    effective: [],
    source: "config",
    refreshedAt: "2026-11-06T00:00:00Z",
    installations: [],
    uninstalledOwners: [],
    appInstallUrl: "",
    repoConfig: [],
    approved: [],
    requireApproval: false,
    stored: false,
    gap: [],
    approvedNoAccess: [],
    yamlDiffers: false,
    showApprovalLists: true,
    discoveryFailedAccounts: [],
    ...over,
  };
}

describe("removeNeedsChoice", () => {
  it("removing the only approved repo with the flag off needs the choice", () => {
    expect(removeNeedsChoice(view({ approved: ["a/one"] }), ["a/one"])).toBe(true);
  });

  it("matches repo names case-insensitively", () => {
    expect(removeNeedsChoice(view({ approved: ["A/One"] }), ["a/one"])).toBe(true);
  });

  it("removing one of two does not", () => {
    expect(removeNeedsChoice(view({ approved: ["a/one", "a/two"] }), ["a/one"])).toBe(false);
  });

  it("with the flag on it never does", () => {
    expect(removeNeedsChoice(view({ approved: ["a/one"], requireApproval: true }), ["a/one"])).toBe(false);
  });
});

describe("toggleConfirmText", () => {
  it("enabling with nothing approved warns that nothing will get work", () => {
    expect(toggleConfirmText(view({ approved: [] }), true)).toBe("Nothing will get work until you approve repos.");
  });

  it("disabling with nothing approved warns about all repos and future ones", () => {
    expect(toggleConfirmText(view({ approved: [], requireApproval: true }), false)).toBe(
      "The bot will work on all 7 repos the App can see, and future repos.",
    );
  });

  it("needs no confirm when repos are approved", () => {
    expect(toggleConfirmText(view({ approved: ["a/one"], requireApproval: true }), false)).toBeNull();
    expect(toggleConfirmText(view({ approved: ["a/one"] }), true)).toBeNull();
  });
});

describe("followAppCount", () => {
  it("is the size of the App grant", () => {
    expect(followAppCount(view({}))).toBe(7);
  });
});

describe("showGapSection", () => {
  it("hides the Not approved section when every visible repo is approved and approval is off", () => {
    expect(showGapSection(view({ approved: ["a/one"], gap: [] }))).toBe(false);
  });

  it("shows it when there is a gap, before discovery, or when approval is required", () => {
    expect(showGapSection(view({ approved: ["a/one"], gap: ["a/two"] }))).toBe(true);
    expect(showGapSection(view({ approved: ["a/one"], gap: null }))).toBe(true);
    expect(showGapSection(view({ approved: ["a/one"], gap: [], requireApproval: true }))).toBe(true);
  });
});

describe("before the App's repo list is discovered", () => {
  it("does not say \"all 0 repos\"", () => {
    const d = view({ installation: [], refreshedAt: null, requireApproval: true });
    expect(followAppPhrase(d)).toBe("every repo the App can see");
    expect(toggleConfirmText(d, false)).toBe(
      "The bot will work on every repo the App can see (not discovered yet), and future repos.",
    );
  });

  it("names the count once discovered", () => {
    expect(followAppPhrase(view({}))).toBe("all 7 repos the App can see");
  });
});
