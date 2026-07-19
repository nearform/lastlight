import { describe, it, expect } from "vitest";
import { renderTemplate, slugify, type TemplateContext } from "#src/workflows/templates.js";

const BASE_CTX: TemplateContext = {
  owner: "acme",
  repo: "widget",
  issueNumber: 42,
  issueTitle: "Add Rate Limiter",
  issueBody: "We need a rate limiter",
  issueLabels: [],
  commentBody: "Please implement this",
  sender: "alice",
  branch: "lastlight/42-add-rate-limiter",
  taskId: "widget-42",
  issueDir: ".lastlight/issue-42",
  bootstrapLabel: "lastlight:bootstrap",
};

describe("slugify", () => {
  it("lowercases and replaces spaces with dashes", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugify("  Hello  ")).toBe("hello");
  });

  it("replaces non-alphanumeric characters", () => {
    expect(slugify("Fix: bug #42!")).toBe("fix-bug-42");
  });

  it("truncates to 40 characters", () => {
    const long = "a".repeat(50);
    expect(slugify(long).length).toBe(40);
  });

  it("collapses multiple non-alphanumeric runs into one dash", () => {
    expect(slugify("foo -- bar !! baz")).toBe("foo-bar-baz");
  });
});

describe("renderTemplate — {{artifactUrl}} (build-assets mode)", () => {
  it("repo mode (flag absent) → GitHub blob URL", () => {
    const result = renderTemplate("{{artifactUrl architect-plan.md}}", BASE_CTX);
    expect(result).toBe(
      "https://github.com/acme/widget/blob/lastlight%2F42-add-rate-limiter/.lastlight/issue-42/architect-plan.md",
    );
  });

  it("server mode → dashboard deep link when publicUrl is set", () => {
    const result = renderTemplate("{{artifactUrl architect-plan.md}}", {
      ...BASE_CTX,
      externalizeArtifacts: true,
      publicUrl: "https://last.example.com/",
    });
    expect(result).toBe(
      "https://last.example.com/admin/?tab=repos&rtab=assets&repo=acme%2Fwidget&key=issue-42&doc=architect-plan.md",
    );
  });

  it("server mode without publicUrl → falls back to the branch URL", () => {
    const result = renderTemplate("{{artifactUrl status.md}}", {
      ...BASE_CTX,
      externalizeArtifacts: true,
    });
    expect(result).toContain("https://github.com/acme/widget/blob/");
  });
});

describe("renderTemplate — explore-context.md link (mode-gated)", () => {
  // These are the exact template literals used in explore.yaml — keep them in
  // sync so a future YAML edit that breaks the gating fails this test.
  const ON_SUCCESS_TMPL =
    "{{#if externalizeArtifacts}}Context doc ready — [explore-context.md]({{artifactUrl explore-context.md}}){{/if}}" +
    "{{#if !externalizeArtifacts}}Context doc written to `{{issueDir}}/explore-context.md` (local to this run — set `buildAssets.location: server` to get a viewable/editable link).{{/if}}";

  const GATE_MSG_TMPL =
    "{{#if externalizeArtifacts}}_You can view or edit the research context doc I'm working from here: [explore-context.md]({{artifactUrl explore-context.md}})._\n" +
    "{{/if}}_Just reply to this thread with your answers — no need to @mention me. I'll keep going until we have enough to write this up._\n" +
    "_Say `we're done` at any point to jump straight to the spec draft._";

  const SERVER_CTX = { ...BASE_CTX, externalizeArtifacts: true, publicUrl: "https://last.example.com/" };
  const ARTIFACT_URL =
    "https://last.example.com/admin/?tab=repos&rtab=assets&repo=acme%2Fwidget&key=issue-42&doc=explore-context.md";

  describe("on_success", () => {
    it("server mode: renders dashboard link and 'Context doc ready'", () => {
      const result = renderTemplate(ON_SUCCESS_TMPL, SERVER_CTX);
      expect(result).toContain(ARTIFACT_URL);
      expect(result).toContain("Context doc ready");
      expect(result).not.toContain("local to this run");
    });

    it("repo mode: renders 'local to this run' message without a blob URL", () => {
      const result = renderTemplate(ON_SUCCESS_TMPL, BASE_CTX);
      expect(result).toContain("local to this run");
      expect(result).not.toContain("Context doc ready");
      expect(result).not.toContain("blob/");
    });
  });

  describe("gate_message", () => {
    it("server mode: includes 'view or edit' line with dashboard link", () => {
      const result = renderTemplate(GATE_MSG_TMPL, SERVER_CTX);
      expect(result).toContain("view or edit");
      expect(result).toContain(ARTIFACT_URL);
    });

    it("repo mode: omits 'view or edit' line entirely", () => {
      const result = renderTemplate(GATE_MSG_TMPL, BASE_CTX);
      expect(result).not.toContain("view or edit");
      expect(result).not.toContain("blob/");
      expect(result).toContain("Just reply to this thread");
    });
  });
});

describe("renderTemplate — {{approvalUrl}} (focused approval deep link)", () => {
  it("builds a focused-view link from publicUrl + approvalId", () => {
    const result = renderTemplate("{{approvalUrl}}", {
      ...BASE_CTX,
      publicUrl: "https://last.example.com/",
      approvalId: "appr-123",
    });
    expect(result).toBe("https://last.example.com/admin/?approval=appr-123");
  });

  it("renders empty when publicUrl is absent (so the rest of the message still posts)", () => {
    const result = renderTemplate("see {{approvalUrl}} now", {
      ...BASE_CTX,
      approvalId: "appr-123",
    });
    expect(result).toBe("see  now");
  });

  it("renders empty when approvalId is absent", () => {
    const result = renderTemplate("{{approvalUrl}}", {
      ...BASE_CTX,
      publicUrl: "https://last.example.com",
    });
    expect(result).toBe("");
  });
});

describe("renderTemplate — doc-commit gate", () => {
  const TEMPLATE =
    "{{#if !externalizeArtifacts}}git commit docs{{/if}}{{#if externalizeArtifacts}}harness persists{{/if}}";

  it("repo mode (flag absent) renders the git commit", () => {
    expect(renderTemplate(TEMPLATE, BASE_CTX)).toBe("git commit docs");
  });

  it("server mode renders the persistence note instead", () => {
    expect(renderTemplate(TEMPLATE, { ...BASE_CTX, externalizeArtifacts: true })).toBe(
      "harness persists",
    );
  });
});

describe("renderTemplate — simple substitution", () => {
  it("replaces {{varName}} with context value", () => {
    const result = renderTemplate("Hello {{owner}}/{{repo}}#{{issueNumber}}", BASE_CTX);
    expect(result).toBe("Hello acme/widget#42");
  });

  it("leaves unknown variables as empty string", () => {
    const result = renderTemplate("{{unknownVar}}", BASE_CTX);
    expect(result).toBe("");
  });

  it("handles numeric values", () => {
    const result = renderTemplate("Issue {{issueNumber}}", BASE_CTX);
    expect(result).toBe("Issue 42");
  });
});

describe("renderTemplate — phaseOutputs fallback", () => {
  it("resolves single-segment {{varName}} from phaseOutputs when not on ctx", () => {
    const ctx = {
      ...BASE_CTX,
      phaseOutputs: { publishResult: "**Spec published:** https://github.com/a/b/issues/1" },
    };
    const result = renderTemplate("{{publishResult}}", ctx as unknown as TemplateContext);
    expect(result).toBe("**Spec published:** https://github.com/a/b/issues/1");
  });

  it("prefers top-level ctx over phaseOutputs on name collision", () => {
    const ctx = {
      ...BASE_CTX,
      owner: "ctxOwner",
      phaseOutputs: { owner: "phaseOwner" },
    };
    const result = renderTemplate("{{owner}}", ctx as unknown as TemplateContext);
    expect(result).toBe("ctxOwner");
  });
});

describe("renderTemplate — nested variable (two-level)", () => {
  it("resolves models.architect style vars", () => {
    const ctx = {
      ...BASE_CTX,
      models: { architect: "claude-opus-4-6", default: "claude-sonnet-4-6" },
    };
    const result = renderTemplate("Model: {{models.architect}}", ctx as unknown as TemplateContext);
    expect(result).toBe("Model: claude-opus-4-6");
  });

  it("returns empty string for missing nested key", () => {
    const ctx = { ...BASE_CTX, models: { default: "claude-sonnet-4-6" } };
    const result = renderTemplate("{{models.architect}}", ctx as unknown as TemplateContext);
    expect(result).toBe("");
  });

  it("resolves hyphenated keys like models.pr-fix", () => {
    const ctx = {
      ...BASE_CTX,
      models: { "pr-fix": "claude-haiku-4-5", default: "claude-sonnet-4-6" },
    };
    const result = renderTemplate("{{models.pr-fix}}", ctx as unknown as TemplateContext);
    expect(result).toBe("claude-haiku-4-5");
  });

  it("renders a hyphenated key to empty (not the literal) when unset", () => {
    // Regression: \w-only key regex left {{models.pr-fix}} unrendered, which
    // then reached the sandbox model validator as a literal and was rejected.
    const ctx = { ...BASE_CTX, models: { default: "claude-sonnet-4-6" } };
    const result = renderTemplate("{{models.pr-fix}}", ctx as unknown as TemplateContext);
    expect(result).toBe("");
  });
});

describe("renderTemplate — slugify helper", () => {
  it("applies slugify to the named variable", () => {
    const result = renderTemplate("{{slugify issueTitle}}", BASE_CTX);
    expect(result).toBe("add-rate-limiter");
  });
});

describe("renderTemplate — branchUrl helper", () => {
  it("generates a full GitHub branch URL", () => {
    const result = renderTemplate("{{branchUrl architect-plan.md}}", BASE_CTX);
    const encoded = encodeURIComponent("lastlight/42-add-rate-limiter");
    expect(result).toBe(
      `https://github.com/acme/widget/blob/${encoded}/.lastlight/issue-42/architect-plan.md`,
    );
  });
});

describe("renderTemplate — conditional blocks", () => {
  it("includes block when variable is truthy", () => {
    const ctx = { ...BASE_CTX, ciSection: "CI FAILURES: tests failed" };
    const result = renderTemplate("{{#if ciSection}}CI section present{{/if}}", ctx);
    expect(result).toBe("CI section present");
  });

  it("excludes block when variable is empty string", () => {
    const ctx = { ...BASE_CTX, ciSection: "" };
    const result = renderTemplate("{{#if ciSection}}CI section present{{/if}}", ctx);
    expect(result).toBe("");
  });

  it("excludes block when variable is undefined", () => {
    const result = renderTemplate("{{#if ciSection}}CI section present{{/if}}", BASE_CTX);
    expect(result).toBe("");
  });

  it("includes block when variable is false (boolean false is falsy)", () => {
    const ctx = { ...BASE_CTX, approved: false };
    const result = renderTemplate("{{#if approved}}yes{{/if}}", ctx);
    expect(result).toBe("");
  });

  it("includes block when variable is true", () => {
    const ctx = { ...BASE_CTX, approved: true };
    const result = renderTemplate("{{#if approved}}yes{{/if}}", ctx);
    expect(result).toBe("yes");
  });

  it("handles multiline blocks", () => {
    const ctx = { ...BASE_CTX, ciSection: "failures here" };
    const tmpl = "{{#if ciSection}}\n  CI failures:\n  {{ciSection}}\n{{/if}}";
    const result = renderTemplate(tmpl, ctx);
    expect(result).toContain("CI failures:");
    expect(result).toContain("failures here");
  });
});

describe("renderTemplate — artifactBaseUrl (inline screenshot embeds)", () => {
  const tmpl =
    "{{#if artifactBaseUrl}}![home]({{artifactBaseUrl}}/home.png){{/if}}" +
    "{{#if !artifactBaseUrl}}see home.png in the Artifacts view{{/if}}";

  it("emits an inline image URL when the base is set", () => {
    const ctx = { ...BASE_CTX, artifactBaseUrl: "https://ll.example.com/admin/api/public/artifacts/acme/widget/issue-42" };
    expect(renderTemplate(tmpl, ctx)).toBe(
      "![home](https://ll.example.com/admin/api/public/artifacts/acme/widget/issue-42/home.png)",
    );
  });

  it("falls back to the filename note when the base is empty", () => {
    const ctx = { ...BASE_CTX, artifactBaseUrl: "" };
    expect(renderTemplate(tmpl, ctx)).toBe("see home.png in the Artifacts view");
  });

  it("falls back when the base is absent", () => {
    expect(renderTemplate(tmpl, BASE_CTX)).toBe("see home.png in the Artifacts view");
  });
});

describe("renderTemplate — deep dotted access (scratch.a.b)", () => {
  it("resolves three-level dotted paths via walkKey", () => {
    const ctx = {
      ...BASE_CTX,
      scratch: { socratic: { qa: [{ q: "q1", a: "a1" }] } },
    };
    const result = renderTemplate("{{scratch.socratic.qa}}", ctx);
    expect(result).toBe(JSON.stringify([{ q: "q1", a: "a1" }]));
  });

  it("returns empty string for missing intermediate", () => {
    const ctx = { ...BASE_CTX, scratch: {} };
    const result = renderTemplate("{{scratch.socratic.qa}}", ctx);
    expect(result).toBe("");
  });

  it("resolves scratch scalar values", () => {
    const ctx = {
      ...BASE_CTX,
      scratch: { socratic: { ready: true } },
    };
    const result = renderTemplate("{{scratch.socratic.ready}}", ctx);
    expect(result).toBe("true");
  });
});

describe("renderTemplate — deep conditional blocks", () => {
  it("includes block when deep dotted path is truthy", () => {
    const ctx = {
      ...BASE_CTX,
      scratch: { socratic: { qa: [{ q: "q1", a: "a1" }] } },
    };
    const result = renderTemplate("{{#if scratch.socratic.qa}}has qa{{/if}}", ctx);
    expect(result).toBe("has qa");
  });

  it("excludes block when deep dotted path is undefined", () => {
    const ctx = { ...BASE_CTX, scratch: {} };
    const result = renderTemplate("{{#if scratch.socratic.qa}}has qa{{/if}}", ctx);
    expect(result).toBe("");
  });
});

describe("renderTemplate — order of processing", () => {
  it("processes conditionals before variable substitution", () => {
    const ctx = { ...BASE_CTX, ciSection: "some failures" };
    const tmpl = "{{#if ciSection}}Fix: {{ciSection}}{{/if}}";
    expect(renderTemplate(tmpl, ctx)).toBe("Fix: some failures");
  });
});
