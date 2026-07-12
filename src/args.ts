/**
 * Argument parsing for `agentic-pi run`.
 *
 * Modeled loosely on opencode's CLI surface so the swap inside a Docker
 * sandbox is one line. We intentionally do NOT mimic opencode's JSON event
 * shape — see the plan doc for why.
 */

export interface RunConfig {
  /** "provider/model_id", e.g. "anthropic/claude-haiku-4-5" */
  model: string;
  /** Pi thinking level. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** GitHub tool profile. Phase 2 will use this. */
  profile?: string;
  /**
   * Path to the credential store (`auth.json`) Pi's `AuthStorage` reads for
   * model authentication — API keys AND OAuth tokens (Anthropic Pro/Max,
   * ChatGPT/Codex, GitHub Copilot), which are refreshed and re-persisted here.
   * Set via `--auth-file <path>`. Default: `<agent-dir>/auth.json`
   * (`~/.pi/agent/auth.json`, or `$PI_CODING_AGENT_DIR/auth.json`).
   *
   * The model call always runs in THIS process (the sandbox executes only
   * tools), so pointing this at a host store is all a subscription-login
   * provider needs — no token ever has to enter the sandbox VM. A caller
   * embedding agentic-pi in a container should mount its store and point here.
   */
  authFile?: string;
  /**
   * Override the GitHub REST API base URL for the built-in `github_*` tools
   * (Octokit's `baseUrl`). Test/eval escape hatch — point at a fake GitHub
   * server. Falls back to `GITHUB_API_URL`. Production leaves it unset.
   */
  githubApiBaseUrl?: string;
  /** Working directory for the agent. Default: process.cwd(). */
  cwd: string;
  /** Whether to persist the session to disk. Default: true (Pi's default). */
  noSession: boolean;
  /** Optional override for session storage directory. */
  sessionDir?: string;
  /** Disable built-in tools (read/write/edit/bash/grep/find/ls). */
  noBuiltinTools: boolean;
  /** Explicit tool allowlist (comma-separated). */
  tools?: string[];
  /** Ignored — accepted for opencode call-site compatibility. */
  dangerouslySkipPermissions: boolean;
  /** Sandbox backend for read/write/edit/bash. */
  sandbox: "none" | "gondolin";
  /**
   * Image to boot when `sandbox === "gondolin"`. Resolved by the image
   * loader:
   *   - `"default"` → bundled `agentic-pi-dev` manifest (auto-downloaded).
   *   - `"gondolin-builtin"` → gondolin's built-in `alpine-base:latest`.
   *   - absolute path → a local `gondolin build` output directory.
   * Ignored when `sandbox === "none"`. Default: `"default"`.
   */
  sandboxImage?: string;
  /**
   * Environment variables to inject into the sandbox VM. Ignored when
   * sandbox === "none" (Pi's host tools already inherit process.env).
   * Use this to hand `GITHUB_TOKEN`, secrets, or workflow context to the
   * agent's `bash` calls inside the VM.
   *
   * Set via `--sandbox-env KEY=VAL` (repeatable). When `--profile` is
   * active and the GitHub extension is configured, a short-lived
   * installation token is auto-injected as both `GITHUB_TOKEN` and
   * `GH_TOKEN`. User-provided values override the auto-injected ones.
   */
  sandboxEnv?: Record<string, string>;
  /**
   * HTTP egress allowlist for the sandbox VM. Without this, gondolin
   * returns 502 to every outbound request from inside the VM —
   * `git clone`, `git push`, `gh api`, `npm install`, `pip install` all
   * fail. Default: a built-in GitHub-only list (github.com,
   * api.github.com, codeload.github.com, objects.githubusercontent.com,
   * raw.githubusercontent.com).
   *
   * Set explicit hosts via `--allow-host <host>` (repeatable) to extend
   * or replace the default. Pass `--no-network` to disable HTTP egress
   * entirely. Ignored when `sandbox === "none"`.
   */
  allowedHttpHosts?: string[] | null;
  /**
   * Web-search extension toggle. Default: true (auto-enables when a
   * provider API key env var is present). Pass `--no-web-search` to
   * force-disable.
   */
  webSearch: boolean;
  /**
   * Explicit web-search provider. Overrides auto-detection by env var.
   * Set via `--web-search-provider <tavily|brave|exa>`.
   */
  webSearchProvider?: string;
  /**
   * Per-run cap on combined web_search + web_fetch calls. Default: 30.
   * Set via `--web-search-max-calls <n>`.
   */
  webSearchMaxCalls?: number;
  /**
   * File-search extension (FFF) toggle. Default: true — bundled and
   * enabled for every run. Pass `--no-file-search` to fall back to Pi's
   * built-in find/grep.
   */
  fileSearch: boolean;
  /**
   * FFF mode. Default: "override" (FFF replaces built-in find/grep under
   * the same names). Set via `--file-search-mode <override|tools-only|tools-and-ui>`.
   */
  fileSearchMode?: "override" | "tools-only" | "tools-and-ui";
  /**
   * Extra Agent Skill paths to load, beyond Pi's default discovery
   * (~/.pi/agent/skills, ~/.agents/skills, .pi/skills, .agents/skills,
   * package skills/). Each entry is a directory of skills OR a single skill
   * dir/file. Set via `--skill <path>` (repeatable). Additive even with
   * --no-skills.
   */
  skillPaths?: string[];
  /**
   * Disable Pi's default skill discovery. Explicit --skill paths still load.
   * Set via `--no-skills`. Default: discovery enabled (Pi's default).
   */
  noSkills?: boolean;
  /**
   * Max auto-retry attempts for transient model errors (429 rate limit, 503
   * overloaded, 5xx, network/timeout). Set via `--max-retries`. Default:
   * agentic-pi's bumped default (see retry.ts), unless the operator set
   * `retry.maxRetries` in Pi settings.json. 0 disables retries.
   */
  maxRetries?: number;
  /**
   * Base delay (ms) for exponential backoff: delay = base * 2^(attempt-1).
   * Set via `--retry-base-delay-ms`. Default: agentic-pi's bumped default,
   * unless the operator set `retry.baseDelayMs` in Pi settings.json.
   */
  retryBaseDelayMs?: number;
  /**
   * Hard cap on the number of agent steps (Pi "turns" — one LLM call plus its
   * tool executions). Set via `--max-steps`. When the agent completes this many
   * turns and still intends to continue (the last turn ran tools), the run is
   * stopped and a `max_steps_reached` event is emitted. Unset (default) = no
   * cap; Pi loops until the agent answers with no tool calls. Must be >= 1.
   */
  maxSteps?: number;
  /**
   * OpenTelemetry traces + metrics export. Tri-state:
   *   - `true`  (`--otel`)    → enabled.
   *   - `false` (`--no-otel`) → force-disabled (wins over env).
   *   - `undefined` (unset)   → enabled iff env AGENTIC_PI_OTEL_ENABLED is truthy.
   * Off by default. Requires an OTLP endpoint via OTEL_EXPORTER_OTLP_ENDPOINT
   * (or `--otel-endpoint`). Standard OTEL_* env vars are honored by the SDK.
   */
  otel?: boolean;
  /**
   * Export raw prompt/message/tool content on spans (bounded + truncated).
   * Default: false (metadata-only). Set via `--otel-include-content` or env
   * AGENTIC_PI_OTEL_INCLUDE_CONTENT.
   */
  otelIncludeContent?: boolean;
  /** Override OTEL_SERVICE_NAME (default: "agentic-pi"). */
  otelServiceName?: string;
  /** Override OTEL_EXPORTER_OTLP_ENDPOINT (escape hatch; prefer the env var). */
  otelEndpoint?: string;
}

export function printHelp(): void {
  process.stdout.write(`agentic-pi — Pi-based coding-agent harness

Usage:
  echo "<prompt>" | agentic-pi run --model <provider/id> [flags]

Flags:
  --model <provider/id>      e.g. anthropic/claude-opus-4-5, openai/gpt-4o
  --thinking <level>         off | minimal | low | medium | high | xhigh
  --profile <name>           GitHub tool profile (read|issues-write|review-write|repo-write)
  --auth-file <path>         Credential store (auth.json) for model auth — API keys and
                              OAuth tokens (Anthropic Pro/Max, ChatGPT/Codex, Copilot),
                              refreshed + re-persisted here. Default: <agent-dir>/auth.json
                              ($PI_CODING_AGENT_DIR or ~/.pi/agent). The model call runs in
                              this process, so a host store suffices — no token enters the VM.
  --cwd <path>               Working directory (default: $PWD)
  --no-session               Do not persist session jsonl
  --session-dir <path>       Where to persist sessions
  --no-builtin-tools         Disable Pi built-in tools (read,write,edit,bash,grep,find,ls)
  --tools <a,b,c>            Explicit tool allowlist
  --sandbox <none|gondolin>  Route Pi's read/write/edit/bash through a sandbox backend.
                              Default: none. 'gondolin' boots a per-run QEMU micro-VM
                              mounting the cwd at /workspace. Requires QEMU on host;
                              native only (Docker-in-Docker not viable; see SPIKE-gondolin.md).
  --sandbox-env KEY=VAL      Inject env var into the sandbox VM. Repeatable.
                              Ignored when --sandbox=none. When --profile is active,
                              GITHUB_TOKEN and GH_TOKEN are auto-injected from a minted
                              installation token (App PEM never enters the VM).
  --allow-host <host>        Add a host to the sandbox HTTP egress allowlist.
                              Repeatable. First explicit use replaces the default
                              GitHub-only allowlist; subsequent uses extend it.
                              Ignored when --sandbox=none.
  --no-network               Disable HTTP egress from the sandbox entirely.
                              Ignored when --sandbox=none.
  --web-search-provider <p>  Force a web-search provider: tavily | brave | exa.
                              Default: auto-detect from env (Tavily > Exa > Brave).
                              Provider's API key env var must be set:
                              TAVILY_API_KEY, EXA_API_KEY, or BRAVE_SEARCH_API_KEY.
  --no-web-search            Disable the web-search extension entirely
                              (web_search / web_fetch tools not registered).
  --web-search-max-calls <n> Cap combined web_search + web_fetch calls per run.
                              Default: 30. When exceeded, further calls return a
                              structured error result.
  --no-file-search           Disable the bundled FFF file-search extension; fall
                              back to Pi's built-in find/grep.
  --file-search-mode <m>     FFF mode: override | tools-only | tools-and-ui.
                              Default: override (FFF replaces built-in find/grep
                              under the same names). Overridden by PI_FFF_MODE env.
  --skill <path>             Load Agent Skills from <path> (a directory of
                              skills or a single skill). Repeatable. Additive
                              even with --no-skills. Maps e.g. ~/.claude/skills
                              into the agent. Skills in Pi's default locations
                              (.pi/skills, .agents/skills, ~/.pi/agent/skills)
                              are discovered automatically without this flag.
  --no-skills                Disable Pi's default skill discovery. Explicit
                              --skill paths still load.
  --max-retries <n>          Max auto-retry attempts for transient model errors
                              (429 rate limit, 503 overloaded, 5xx, network).
                              Exponential backoff. 0 disables. Default tuned for
                              per-minute rate-limit windows (e.g. Fireworks TPM).
                              Overrides retry.maxRetries from Pi settings.json.
  --retry-base-delay-ms <n>  Base backoff delay in ms: delay = base*2^(attempt-1).
                              Overrides retry.baseDelayMs from Pi settings.json.
  --max-steps <n>            Hard cap on agent steps (one LLM turn + its tool
                              calls). When reached while the agent still wants to
                              continue, the run stops and emits a
                              "max_steps_reached" event. Default: no cap.
  --otel                     Enable OpenTelemetry traces + metrics export.
                              Off by default. Requires an OTLP endpoint via
                              OTEL_EXPORTER_OTLP_ENDPOINT (or --otel-endpoint).
                              Honors standard OTEL_* env vars. Can also be
                              enabled with AGENTIC_PI_OTEL_ENABLED=1.
  --no-otel                  Force-disable OTEL even if AGENTIC_PI_OTEL_ENABLED
                              is set (highest precedence).
  --otel-include-content     Attach prompt/message/tool content to spans
                              (bounded + truncated). Default: metadata-only.
  --otel-service-name <n>    Override OTEL_SERVICE_NAME (default: agentic-pi).
  --otel-endpoint <url>      Override OTEL_EXPORTER_OTLP_ENDPOINT base URL.
  --sandbox-image <name>     Image to boot when --sandbox=gondolin. Values:
                              'default' (recommended) — bundled agentic-pi-dev image
                                with git/gh/node/python/rust baked in (auto-downloaded).
                              'gondolin-builtin' — stock alpine-base:latest, no extras.
                              <absolute path> — directory produced by 'gondolin build'.
                              Default: 'default'.
  --dangerously-skip-permissions   Accepted for compat; Pi has no permission prompts anyway

Reads the prompt from stdin. Emits Pi-native JSONL events on stdout, terminating
with an "agent_end" event that includes synthesized usage/cost data.
`);
}

export function parseArgs(argv: string[]): RunConfig {
  const config: RunConfig = {
    model: "",
    cwd: process.cwd(),
    noSession: false,
    noBuiltinTools: false,
    dangerouslySkipPermissions: false,
    sandbox: "none",
    webSearch: true,
    fileSearch: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--model":
      case "-m":
        config.model = next();
        break;
      case "--thinking":
      case "--variant": {
        const v = next();
        if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(v)) {
          throw new Error(`invalid --thinking level: ${v}`);
        }
        config.thinking = v as RunConfig["thinking"];
        break;
      }
      case "--profile":
        config.profile = next();
        break;
      case "--auth-file": {
        const v = next().trim();
        if (!v) throw new Error("--auth-file requires a non-empty path");
        config.authFile = v;
        break;
      }
      case "--cwd":
        config.cwd = next();
        break;
      case "--no-session":
        config.noSession = true;
        break;
      case "--session-dir":
        config.sessionDir = next();
        break;
      case "--no-builtin-tools":
        config.noBuiltinTools = true;
        break;
      case "--tools":
        config.tools = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--dangerously-skip-permissions":
        config.dangerouslySkipPermissions = true;
        break;
      case "--sandbox": {
        const v = next();
        if (v !== "none" && v !== "gondolin") {
          throw new Error(`invalid --sandbox '${v}'. Expected: none | gondolin`);
        }
        config.sandbox = v;
        break;
      }
      case "--sandbox-image": {
        const v = next();
        if (v.length === 0) {
          throw new Error(`--sandbox-image requires a non-empty value`);
        }
        config.sandboxImage = v;
        break;
      }
      case "--sandbox-env": {
        const v = next();
        const eq = v.indexOf("=");
        if (eq < 1) {
          throw new Error(`--sandbox-env must be KEY=VAL (got '${v}')`);
        }
        const key = v.slice(0, eq);
        const val = v.slice(eq + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`--sandbox-env KEY must match POSIX identifier rules (got '${key}')`);
        }
        config.sandboxEnv = { ...(config.sandboxEnv ?? {}), [key]: val };
        break;
      }
      case "--allow-host": {
        const v = next().trim();
        if (!v) throw new Error("--allow-host requires a non-empty host");
        if (!/^[A-Za-z0-9.\-*]+$/.test(v)) {
          throw new Error(`--allow-host must be a host pattern (got '${v}')`);
        }
        // First explicit --allow-host replaces the default GitHub list;
        // subsequent ones extend. Pass --no-network first to start from
        // an empty allowlist with HTTP enabled? No — --no-network sets
        // null (HTTP disabled). To start from empty allow-list, pass an
        // explicit `--allow-host` for whatever you want and nothing else.
        const cur = Array.isArray(config.allowedHttpHosts) ? config.allowedHttpHosts : [];
        config.allowedHttpHosts = [...cur, v];
        break;
      }
      case "--no-network":
        config.allowedHttpHosts = null;
        break;
      case "--no-web-search":
        config.webSearch = false;
        break;
      case "--web-search-provider": {
        const v = next().trim();
        if (!v) throw new Error("--web-search-provider requires a value");
        config.webSearchProvider = v;
        break;
      }
      case "--web-search-max-calls": {
        const v = next();
        const n = Number(v);
        if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1) {
          throw new Error(`--web-search-max-calls must be a positive integer (got '${v}')`);
        }
        config.webSearchMaxCalls = n;
        break;
      }
      case "--no-file-search":
        config.fileSearch = false;
        break;
      case "--skill": {
        const v = next().trim();
        if (!v) throw new Error("--skill requires a non-empty path");
        config.skillPaths = [...(config.skillPaths ?? []), v];
        break;
      }
      case "--no-skills":
        config.noSkills = true;
        break;
      case "--max-retries": {
        const v = next();
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`--max-retries must be a non-negative integer (got '${v}')`);
        }
        config.maxRetries = n;
        break;
      }
      case "--retry-base-delay-ms": {
        const v = next();
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`--retry-base-delay-ms must be a positive integer (got '${v}')`);
        }
        config.retryBaseDelayMs = n;
        break;
      }
      case "--max-steps": {
        const v = next();
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`--max-steps must be a positive integer (got '${v}')`);
        }
        config.maxSteps = n;
        break;
      }
      case "--file-search-mode": {
        const v = next();
        if (v !== "override" && v !== "tools-only" && v !== "tools-and-ui") {
          throw new Error(
            `invalid --file-search-mode '${v}'. Expected: override | tools-only | tools-and-ui`,
          );
        }
        config.fileSearchMode = v;
        break;
      }
      case "--otel":
        config.otel = true;
        break;
      case "--no-otel":
        config.otel = false;
        break;
      case "--otel-include-content":
        config.otelIncludeContent = true;
        break;
      case "--otel-service-name": {
        const v = next().trim();
        if (!v) throw new Error("--otel-service-name requires a value");
        config.otelServiceName = v;
        break;
      }
      case "--otel-endpoint": {
        const v = next().trim();
        if (!v) throw new Error("--otel-endpoint requires a value");
        config.otelEndpoint = v;
        break;
      }
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }

  if (!config.model) {
    throw new Error("--model is required (e.g. anthropic/claude-haiku-4-5)");
  }
  if (!config.model.includes("/")) {
    throw new Error(`--model must be 'provider/id', got '${config.model}'`);
  }

  return config;
}
