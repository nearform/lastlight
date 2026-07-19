import { describe, it, expect } from "vitest";
import { getWorkflow } from "#src/workflows/loader.js";

/**
 * Shape guard: ensures explore.yaml wires {{artifactUrl explore-context.md}}
 * into both user-facing message surfaces. If the link is removed or the
 * template expression is renamed, this test fails loudly.
 */
describe("explore.yaml — context-doc link wiring", () => {
  it("read_context phase has on_success containing {{artifactUrl explore-context.md}}", () => {
    const def = getWorkflow("explore");
    const readCtx = def.phases.find((p) => p.name === "read_context");
    expect(readCtx, "read_context phase not found").toBeDefined();
    const onSuccess = readCtx?.messages?.on_success as string | undefined;
    expect(onSuccess, "read_context.messages.on_success not found").toBeDefined();
    expect(onSuccess).toContain("{{artifactUrl explore-context.md}}");
  });

  it("socratic phase gate_message contains {{artifactUrl explore-context.md}}", () => {
    const def = getWorkflow("explore");
    const socratic = def.phases.find((p) => p.name === "socratic");
    expect(socratic, "socratic phase not found").toBeDefined();
    const gateMsg = socratic?.generic_loop?.gate_message as string | undefined;
    expect(gateMsg, "socratic.generic_loop.gate_message not found").toBeDefined();
    expect(gateMsg).toContain("{{artifactUrl explore-context.md}}");
  });
});
