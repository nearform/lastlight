/**
 * `build` as a code-defined durable workflow (spike — the YAML original is
 * `workflows/build.yaml`). Architect → Executor → Reviewer loop → PR, behind a
 * two-part guardrails check and optional approval gates.
 *
 * Prompts/skills still resolve through the layered asset loader, so an overlay
 * can override `prompts/architect.md` without touching this file.
 */

import { defineWorkflow, readStatusLine, reviewLoop, type AgentResult, type WorkflowContext, type WorkflowOutcome } from "lastlight-workflow-engine/durable";

const BOOTSTRAP_LABEL = "lastlight:bootstrap";
const BOOTSTRAP_TITLE = /^(guardrails:|\[guardrails\])/i;

/** No LLM: runs the agent-written `.git/lastlight-gate.sh` once and prints READY/BLOCKED (exit 0). */
const GUARDRAILS_GATE = `dir='{{issueDir}}'
limit='{{gateLimit}}'
gate=.git/lastlight-gate.sh
log=.git/lastlight-gate.log
mkdir -p "$dir"
set_status() {
  { grep -v '^guardrails_status:' "$dir/status.md" 2>/dev/null; echo "guardrails_status: $1"; } > "$dir/status.md.tmp"
  mv "$dir/status.md.tmp" "$dir/status.md"
}
report() {
  {
    echo ''
    echo '## Full test suite gate (run by the harness)'
    echo ''
    echo "- Verdict: $1 — $2"
    if [ -f "$gate" ]; then echo "- Command (\\\`$gate\\\`):"; echo '\`\`\`sh'; cat "$gate"; echo '\`\`\`'; fi
    if [ -n "\${code:-}" ]; then
      echo "- Exit code: $code · duration: \${dur}s · limit: gate.timeoutSeconds=\${limit}s"
      echo ''; echo 'Last 60 lines of output:'; echo '\`\`\`'; tail -n 60 "$log"; echo '\`\`\`'
    fi
  } >> "$dir/guardrails-report.md"
}
block() { set_status BLOCKED; report BLOCKED "$1"; echo "BLOCKED — $1"; exit 0; }
if grep -qs '^guardrails_status: READY' "$dir/status.md"; then
  echo 'READY — guardrails already verified (the full test suite passed on an earlier run)'; exit 0
fi
# BOOTSTRAP is written by the agent, so it only waives a suite that does not
# exist yet: a gate script present means there IS a suite, and it always runs.
if [ ! -f "$gate" ] && grep -qs '^guardrails_status: BOOTSTRAP' "$dir/status.md"; then
  echo 'READY — bootstrap build: no test suite to gate yet (the executor establishes it)'; exit 0
fi
case "$limit" in ''|*[!0-9]*) block "gate.timeoutSeconds is not set in the run context (got '$limit')";; esac
[ -f "$gate" ] || block "guardrails did not produce a gate command ($gate is missing)"
start=$(date +%s)
if command -v timeout >/dev/null 2>&1; then
  timeout -k 30 "$limit" bash "$gate" > "$log" 2>&1; code=$?
else
  echo '(no coreutils timeout on this host: bounded by the phase timeout only)' > "$log"
  bash "$gate" >> "$log" 2>&1; code=$?
fi
dur=$(( $(date +%s) - start ))
if [ "$code" -eq 0 ]; then
  set_status READY
  report READY "full test suite passed (exit 0) in \${dur}s"
  echo "READY — full test suite passed (exit 0) in \${dur}s"
  exit 0
fi
if [ "$code" -eq 124 ] || { [ "$code" -eq 137 ] && [ "$dur" -ge "$limit" ]; }; then
  reason="full test suite did not finish within gate.timeoutSeconds (\${limit}s) — raise gate.timeoutSeconds in the overlay or .lastlight/lastlight.yml"
else
  reason="full test suite failed (exit $code)"
fi
set_status BLOCKED
report BLOCKED "$reason"
echo "BLOCKED — $reason"
echo ''
echo 'Last 60 lines of output:'
tail -n 60 "$log"
exit 0
`;

const fail = (summary: string): WorkflowOutcome => ({ success: false, summary });

function isBootstrap(ctx: WorkflowContext): boolean {
  const labels = Array.isArray(ctx.vars.issueLabels) ? ctx.vars.issueLabels : [];
  return labels.includes(BOOTSTRAP_LABEL) || BOOTSTRAP_TITLE.test(String(ctx.vars.issueTitle ?? ""));
}

/**
 * The guardrails verdict. A status line wins; with none, fall back to the YAML
 * engine's substring rule so the port is behaviour-preserving for now.
 */
function blocked(result: AgentResult): boolean {
  const status = readStatusLine(result.output, ["READY", "GATE_PENDING", "BOOTSTRAP", "BLOCKED"] as const);
  return status ? status === "BLOCKED" : result.output.toUpperCase().includes("BLOCKED");
}

export default defineWorkflow({
  name: "build",
  version: "1",
  description: "Architect -> Executor -> Reviewer build cycle",
  policy: { gitAccess: "repo-write", workspace: "per-target-recreate", prepopulateSynthBranch: true },
  classification: {
    intent: "build",
    description: "BUILD — The user is ASKING YOU (the bot) to make code changes NOW in a GitHub repo: implement a feature, fix a bug, create/send a PR, resolve an issue with code. BUILD requires a GitHub target — either an explicit repo reference (owner/name or github.com URL) in the message, OR an ISSUE TITLE context line indicating the comment is a reply on an existing issue/PR. If neither is present, classify as CHAT — local filesystem operations (\"delete files in ~/foo\", \"clean up my downloads\"), shell-style commands, or vague \"build something\" with no target are NOT BUILD.\n  BUILD is a REQUEST for NEW work directed at you. A comment that merely REPORTS work the human has ALREADY done is NOT BUILD — it is CHAT. Tells: past-tense (\"fixed\", \"done\", \"implemented\", \"added a test\", \"pushed a fix\", \"handled it\"), a reference to a commit the human made (\"addressed in <sha>\", \"see commit abc123\"), thanking you, or explaining/justifying a change they made in response to your review. These are status reports, not requests — classify them CHAT even when the comment is on a PR and even when it @-mentions you. Only classify BUILD when the human asks you to do NEW work (imperative request: \"fix X\", \"now also handle Y\", \"can you update Z\").\n",
    examples: [
      "\"build cliftonc/drizzle-cube#42\" → INTENT: BUILD, REPO: cliftonc/drizzle-cube, ISSUE: 42, REASON: NONE",
      "\"lets build this!\" with ISSUE TITLE \"Security Review\" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE",
      "\"go ahead\" with ISSUE TITLE \"Add CSV export\" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE",
      "\"now also handle the GET /sql case please\" with ISSUE TITLE \"Port adapters\" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE",
      "\"Thanks @last-light — addressed in 49ccadf. Fixed the nested body in the core and added a regression test; point 3 is intentional, confirmed with the maintainer.\" with ISSUE TITLE \"Port fastify/hono/nextjs adapters\" → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE",
      "\"done, pushed a fix for the type error in 1a2b3c4\" with ISSUE TITLE \"Fix build\" → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE",
      "\"delete any files in ~/work/lastlight/docs\" → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE",
      "\"can you remove the old docs folder for me\" (no ISSUE TITLE, no repo) → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE",
      "\"build something cool\" (no repo, no ISSUE TITLE) → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE"
    ],
  },
  chat: {
    "trigger": "build owner/repo#N",
    "summary": "Implement or fix a specific issue",
    "deflect": [
      "build this",
      "implement this",
      "fix this bug"
    ],
    "reply": "reply: \"tell me `build owner/repo#N` (open the GitHub issue first if needed)\""
  },

  async run(ctx) {
    const phaseTimeout = ctx.input.timeouts?.phaseSeconds;
    const agent = (role: string, prompt: string, extra: { skills?: string[]; timeoutSeconds?: number } = {}) => ({
      prompt,
      model: ctx.model(role),
      variant: ctx.variant(role),
      ...extra,
    });
    const bootstrap = isBootstrap(ctx);

    // ── Guardrails: setup (agent), then the full suite (deterministic) ──────
    const setup = await ctx.agent("guardrails", agent("guardrails", "prompts/guardrails.md", { timeoutSeconds: phaseTimeout }));
    if (!setup.success) return fail(`Guardrails setup failed: ${setup.error ?? "agent error"}`);
    if (blocked(setup) && !bootstrap) {
      await ctx.notify("guardrails:blocked", "**Guardrails check: BLOCKED** — missing foundational tooling.\n\nSee the guardrails report on branch `{{branch}}` at `{{issueDir}}/guardrails-report.md`.");
      return fail("Guardrails check: BLOCKED");
    }
    await ctx.notify("guardrails:ok", "Setup verified (install, typecheck, lint) — running the full test suite next");

    const gate = await ctx.bash("guardrails_gate", GUARDRAILS_GATE, {
      timeoutSeconds: phaseTimeout,
      vars: { gateLimit: ctx.input.timeouts?.gateSeconds ?? "" },
    });
    if (!gate.success) return fail(`Guardrails gate machinery failed: ${gate.error ?? "non-zero exit"}`);
    if (blocked(gate) && !bootstrap) {
      await ctx.notify("guardrails_gate:blocked", "**Guardrails check: BLOCKED** — the full test suite did not pass.\n\nSee `{{issueDir}}/guardrails-report.md`.");
      return fail("Guardrails check: BLOCKED — full test suite gate");
    }

    // ── Architect (+ optional approval) ─────────────────────────────────────
    const plan = await ctx.agent("architect", agent("architect", "prompts/architect.md"));
    if (!plan.success) return fail("Architect failed");
    await ctx.notify("architect:ok", "Plan ready — `{{issueDir}}/architect-plan.md`");
    if (ctx.gateEnabled("post_architect")) {
      const decision = await ctx.approval("post_architect", {
        summary: "Architect analysis complete — approval required before implementation.",
        artifact: "architect-plan.md",
        message: "**Architect analysis complete** — approval required before implementation.\n\n- Branch: `{{branch}}`\n- Plan: `{{issueDir}}/architect-plan.md`\n\n**Review & decide:** {{approvalUrl}}",
      });
      if (!decision.approved) return fail(`Rejected at post_architect${decision.reason ? `: ${decision.reason}` : ""}`);
    }

    // ── Executor → reviewer loop → PR ───────────────────────────────────────
    const exec = await ctx.agent("executor", agent("executor", "prompts/executor.md", { skills: ["building"], timeoutSeconds: phaseTimeout }));
    if (!exec.success) return fail("Executor failed");

    const review = await reviewLoop(ctx, {
      name: "reviewer",
      maxCycles: 2,
      review: agent("reviewer", "prompts/reviewer.md", { skills: ["code-review", "building"], timeoutSeconds: phaseTimeout }),
      reReview: agent("reviewer", "prompts/re-reviewer.md", { skills: ["code-review", "building"], timeoutSeconds: phaseTimeout }),
      fix: agent("fix", "prompts/fix.md", { timeoutSeconds: phaseTimeout }),
      approvalGate: { gate: "post_reviewer", artifact: "reviewer-verdict.md" },
      messages: {
        approved: "Approved — `{{issueDir}}/reviewer-verdict.md`",
        requestChanges: "**Review: REQUEST_CHANGES** — fixing issues (cycle {{cycle}}/{{maxCycles}})...",
        maxCycles: "**Review: REQUEST_CHANGES** after {{maxCycles}} fix cycles. Proceeding with remaining issues noted.",
        fixFailed: "Fix cycle {{cycle}} failed. Proceeding to PR with known issues.",
      },
    });
    if (review.rejected) return fail("Rejected at post_reviewer");

    const pr = await ctx.agent("pr", agent("pr", "prompts/pr.md"));
    if (!pr.success) return fail("PR phase failed");
    const prNumber = pr.output.match(/\/pull\/(\d+)/)?.[1] ?? pr.output.match(/#(\d+)/)?.[1];
    return { success: true, summary: "complete", prNumber: prNumber ? Number(prNumber) : undefined };
  },
});
