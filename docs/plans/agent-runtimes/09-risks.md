# 09 — Risks and open questions

1. **Licensing (highest).** Every route to Claude (`claude-agent-acp` →
   Claude Agent SDK) ships Anthropic's proprietary Claude Code binary under its
   Commercial Terms. Redistributing it in **public** GHCR images is unverified
   and needs a legal check. Options:
   - a private `sandbox-runtimes` image variant;
   - installing the adapter at provision time;
   - keeping Claude to `--sandbox none` (evals) until resolved.

   Codex (Apache-2.0), OpenCode (MIT) and Pi are permissive.
2. **Image size.** Three native agent binaries likely add hundreds of MB
   [estimate]. Choose between the default image, a build arg, or a separate
   variant (like `sandbox-qa`).
3. **Adapter churn.** `claude-agent-acp` is about 10k lines and changes daily.
   Mitigations:
   - exact pins in the lockfile;
   - a P0 fixture contract test per adapter;
   - a Renovate group gated on the conformance suite.
4. **Token semantics.** `PromptResponse.usage` is a draft RFD, and Codex token
   totals may be per-call. With one prompt per run, per-turn equals cumulative
   today; verify it. Never treat `usage_update.used` as billed tokens.
5. **Tool-name drift.** Prompts say `github_add_issue_comment`; Claude sees
   `mcp__lastlight__github_add_issue_comment`. Mitigations are in
   [`05`](05-github-mcp.md), and P3 measures tool-not-found errors.
6. **Codex policy parity.** Blocks without a reason may cause retry loops. The
   P0 PATH wrapper may fix it. Otherwise document the degradation and prefer
   other runtimes for policy-heavy phases.
7. **Context delivery.** Codex and OpenCode may not walk above the git root,
   so the workspace-root AGENTS.md (persona plus `security.md` rules) would
   **silently not load**. That is security-relevant. The bridge delivers it
   explicitly, and the conformance suite asserts a canary rule.
8. **Repo-controlled config.** `settingSources: ["project"]` would let a managed
   repo's `.claude/settings.json` hooks run commands. Keep `["user"]` pointed at
   the bridge-owned temp dir. Open question: inline the repo's own
   CLAUDE.md / AGENTS.md as untrusted context, for parity with Pi's walk-up?
9. **Subagents.** Claude's Task tool spawns subagents. Their cost is included in
   `total_cost_usd`, but spans and transcripts need `parentSessionId`.
   Coordinate with [`../agentic-pi-subagents/`](../agentic-pi-subagents/).
10. **Turn counts** are synthesized for ACP runtimes and not comparable across
    runtimes; scorecards label them.
11. **Egress.** Each runtime's non-model hosts (telemetry, model catalogues,
    auto-update) must be disabled or allowlisted. Under the strict DNS firewall
    they otherwise hang rather than fail cleanly.
12. **ACP SDK / protocol version.** Pin `@agentclientprotocol/sdk`. `doctor`
    fails fast on a `protocolVersion` mismatch.
13. **Harness-comparison confounds.** Each runtime's system prompt, built-in
    tools and compaction differ by design, so a score gap measures "harness +
    its defaults". [`07`](07-evals-harness-comparison.md) §7 states what is
    neutralized and what is deliberately left native; reports must say so too.
14. **Option noted, not planned: agentic-pi via `pi-acp`.** It would put every
    runtime on one path. Rejected for now: agentic-pi's native GitHub tools,
    gondolin and the in-process mode would be lost or need re-plumbing. Revisit
    after P4, once the bridge is proven. **2026-10-05: closed as no.** The
    live-sessions spike measured `pi-acp` running vanilla `pi --mode rpc` with
    no permission requests, no cost, no MCP and queue-only steering — strictly
    weaker than agentic-pi's native control ([`10`](10-live-sessions.md)).
