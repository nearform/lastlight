import { PROMPT_FILE } from "./pod.js";

/**
 * Which optional `agentic-pi run` flags to emit, and whether the best-effort
 * artifact-upload block should run after the agent exits.
 *
 * Deliberately absent: the actual model, harness endpoint, profile,
 * thinking-level, and web-search-provider STRINGS. `runAgent`
 * (`kubernetes-sandbox.ts`) validates each of those against a closed set,
 * then execs the returned script as `sh -c SCRIPT sh $1 $2 $3 $4 $5` — model,
 * harness endpoint, profile, thinking, web-search provider — binding each to
 * its own positional arg at exec time. That's immune to quote-breaking
 * regardless of characters (the same contract `init-clone.ts` uses for
 * owner/repo/branch): since this builder's input has no field for the values
 * themselves, there's no way for one to be spliced into the script text by
 * mistake.
 */
export interface RunAgentScriptInput {
  /** Append `--profile "$3"` — the profile string itself is bound to `$3`. */
  readonly profile: boolean;
  /** Absolute in-pod skill directories (`SKILLS_MOUNT_DIR/<name>`, already
   *  sanitized by `stageSkills` before this is called) — each becomes its
   *  own `--skill <dir>`. Safe to splice directly into the script text: not
   *  user input, already charset-restricted. */
  readonly skillDirs: readonly string[];
  /** Append `--thinking "$4"` — the level string itself is bound to `$4`. */
  readonly thinking: boolean;
  /**
   * Whether this run has web search enabled at all. False (the default)
   * appends `--no-web-search` — REQUIRED, not cosmetic: agentic-pi
   * auto-enables its web-search extension whenever any `*_API_KEY` env var
   * is present in the container, so a phase that never opted in would
   * otherwise get search anyway. Mirrors the docker backend (`docker.ts`,
   * ~:358-373).
   */
  readonly webSearch: boolean;
  /** Append `--web-search-provider "$5"` — only takes effect when
   *  `webSearch` is also true; the provider string itself is bound to `$5`. */
  readonly webSearchProvider: boolean;
  /** Append the best-effort `.lastlight/` tar+curl upload block (see below).
   *  The artifact bearer token travels via env (`LASTLIGHT_ARTIFACT_TOKEN`,
   *  in the pod's creds Secret), never as an argv value. */
  readonly artifactUpload: boolean;
}

function agentRunFlags(input: RunAgentScriptInput): string {
  const webSearchFlag = input.webSearch
    ? input.webSearchProvider
      ? `--web-search-provider "$5"`
      : ""
    : "--no-web-search";
  return [
    input.profile ? `--profile "$3"` : "",
    input.thinking ? `--thinking "$4"` : "",
    webSearchFlag,
    ...input.skillDirs.map((dir) => `--skill ${dir}`),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Builds the in-pod shell script for a `runAgent` run.
 *
 * Fixed shape, independent of the input flags:
 * 1. `agentic-pi run`, reading the prompt from stdin (`< PROMPT_FILE`, a
 *    mounted Secret file — never a CLI arg or inline env) with whichever
 *    flags {@link agentRunFlags} decided. Its real exit code is captured
 *    (`rc=$?`) rather than left to a bare `exec`, so step 2 can run
 *    afterwards without masking it. (The resolved agent-context reaches the
 *    workspace root as `AGENTS.md` via the agent-context initContainer —
 *    `init-agent-context.ts`, nearform#240 — not this script.)
 * 2. When `artifactUpload` is set: a best-effort tar+upload of `.lastlight/`
 *    (`|| true` — a hiccup here must never turn a successful agent run into
 *    a reported failure) to the harness's `/internal/sandbox-artifacts`
 *    route, bearer-authed with `$LASTLIGHT_ARTIFACT_TOKEN` (env, not argv).
 * 3. `exit $rc` — restores the agent's own result regardless of step 2.
 */
export function buildRunAgentScript(input: RunAgentScriptInput): string {
  const flags = agentRunFlags(input);
  const runAgent =
    `agentic-pi run --model "$1" --sandbox none --no-session ${flags} ` +
    `< ${PROMPT_FILE} ; rc=$?`;
  const uploadBlock = input.artifactUpload
    ? "\n" +
      `if [ -d .lastlight ]; then\n` +
      `  tar -czf - .lastlight | curl -sf -X POST ` +
      `-H "Authorization: Bearer $LASTLIGHT_ARTIFACT_TOKEN" ` +
      `--data-binary @- "$2/internal/sandbox-artifacts" || true\n` +
      `fi`
    : "";

  return `${runAgent}${uploadBlock}\nexit $rc`;
}
