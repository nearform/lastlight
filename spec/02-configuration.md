---
title: "Configuration"
order: 2
description: "Every env var the harness reads, the typed config schema, model and variant overrides, sandbox backend selection, approval-gate enablement, secrets layout, and the STATE_DIR tree."
---

## Purpose

Configuration is the single source of truth for every runtime knob.
Every other component reads from the typed `LastLightConfig` value the
harness loads at boot; other spec pages cite this one rather than
redocumenting env vars locally.

The config layer's job is to parse the environment, validate the
non-negotiable bits (the GitHub App PEM, if present, must exist and
parse), apply defaults, and expose a typed object the rest of the
process consumes. Malformed JSON inputs (`LASTLIGHT_MODELS`, etc.) log a
warning and fall back — they don't crash boot.

## Schema

```ts
interface LastLightConfig {
  port: number;
  webhookSecret: string;
  botLogin: string;
  dbPath: string;
  workflowDir: string;
  stateDir: string;
  sandboxDir: string;
  sessionsDir: string;
  model: string;                          // provider/model, e.g. "anthropic/claude-sonnet-4-6"
  models: ModelConfig;                    // { default: string; [taskType: string]: string }
  variants: VariantConfig;                // { default?: string; [taskType: string]: string | undefined }
  maxTurns: number;
  sandbox: "gondolin" | "docker" | "none";
  githubApp?: {
    appId: string;
    privateKeyPath: string;
    installationId: string;
  };
  slack?: SlackConfig;
  approval?: Record<string, boolean>;     // gate-name → enabled
  bootstrapLabel: string;
  exploreDefaultRepo?: string;
  publicUrl?: string;
  reviewPostsCheck: boolean;
}

interface SlackConfig {
  botToken: string;
  appToken: string;
  allowedUsers: string[];
  deliveryChannel?: string;
}
```

Defined in `src/config.ts:74–143`. Loaded once at boot, never mutated. A
re-implementation should treat this object as effectively `Readonly` —
any per-task overrides are layered *over* the base config at dispatch
time, not back into it.

## Env vars, by group

The defaults below are what the harness produces if the var is unset.
Required vars are fatal only if the *feature* they gate is needed —
missing `GITHUB_APP_ID` is fine for a chat-only deployment.

### GitHub App

| Var | Required for | Default |
|---|---|---|
| `GITHUB_APP_ID` | GitHub integration | — |
| `GITHUB_APP_INSTALLATION_ID` | GitHub integration | — |
| `GITHUB_APP_PRIVATE_KEY_PATH` | GitHub integration | `./secrets/app.pem` |
| `WEBHOOK_SECRET` | webhook signature verification | empty (verification **disabled**) |
| `BOT_LOGIN` | self-event filtering | `last-light[bot]` |

The PEM is validated at boot: must exist and parse as PEM (`src/index.ts:42–51`).
Missing or malformed PEM exits `78`.

### Slack

| Var | Required for | Default |
|---|---|---|
| `SLACK_BOT_TOKEN` | Slack at all | — |
| `SLACK_APP_TOKEN` | required if bot token set (Socket Mode) | — |
| `SLACK_ALLOWED_USERS` | allowlist (comma-separated user IDs) | empty = all allowed |
| `SLACK_DELIVERY_CHANNEL` / `SLACK_HOME_CHANNEL` | cron report destination | none |
| `SLACK_OAUTH_CLIENT_ID` / `SLACK_OAUTH_CLIENT_SECRET` / `SLACK_OAUTH_REDIRECT_URI` | "Login with Slack" for dashboard | none |
| `SLACK_ALLOWED_WORKSPACE` | restrict OAuth to one team | none |

Presence of `SLACK_BOT_TOKEN` gates the `slack` config sub-object.
Without it, the Slack connector never registers.

### Models and reasoning

| Var | Purpose | Default |
|---|---|---|
| `LASTLIGHT_MODEL` / `OPENCODE_MODEL` | base model for all phases | `anthropic/claude-sonnet-4-6` |
| `LASTLIGHT_MODELS` / `OPENCODE_MODELS` | per-phase model overrides (JSON) | `{}` |
| `LASTLIGHT_THINKING` / `OPENCODE_VARIANT` | base reasoning-effort | (provider default) |
| `LASTLIGHT_THINKINGS` / `OPENCODE_VARIANTS` | per-phase reasoning overrides (JSON) | `{}` |
| `ANTHROPIC_API_KEY` | provider auth | — |
| `OPENAI_API_KEY` | provider auth | — |
| `OPENROUTER_API_KEY` | provider auth | — |

`OPENCODE_*` names are kept as legacy aliases — the runtime is now
agentic-pi / pi-ai, but production deployments may still set the old
names and we don't want to break them. New deployments should prefer
`LASTLIGHT_*`.

JSON parse failures on `*_MODELS` / `*_VARIANTS` log a warning and use
`{}` — they do not crash boot.

### Models / variants override JSON

```json
LASTLIGHT_MODELS={
  "default":   "anthropic/claude-sonnet-4-6",
  "architect": "anthropic/claude-opus-4-7",
  "chat":      "anthropic/claude-haiku-4-5",
  "triage":    "openai/gpt-4-turbo"
}

LASTLIGHT_THINKINGS={
  "default":   "low",
  "architect": "high",
  "reviewer":  "high",
  "triage":    "minimal"
}
```

Keys are phase names from YAML workflows (e.g. `architect`, `reviewer`)
or skill types (e.g. `chat`, `triage`). `default` is the catch-all.
Resolution at dispatch (`src/config.ts:296`): per-type if present, else
`default`, else the base `LASTLIGHT_MODEL`. Thinking values are pi-ai's
`ThinkingLevel`: `off | minimal | low | medium | high | xhigh`.

### Sandbox

| Var | Purpose | Default |
|---|---|---|
| `LASTLIGHT_SANDBOX` | backend: `gondolin` / `docker` / `none` | `gondolin` |
| `MAX_TURNS` | agent loop budget per session | `200` |
| `SANDBOX_MEMORY_LIMIT` | docker only | `2g` |
| `SANDBOX_DATA_VOLUME` | docker only — named volume or bind-mount path | `lastlight_agent-data` |
| `LASTLIGHT_SANDBOX_NETWORK` | docker only | `lastlight_sandbox-egress` |

Unknown `LASTLIGHT_SANDBOX` values log a warning and fall back to
`gondolin`. `none` is for local dev only — no isolation.

### State and paths

| Var | Purpose | Default |
|---|---|---|
| `STATE_DIR` | root for all persistent state | `./data` |
| `DB_PATH` | SQLite file | `$STATE_DIR/lastlight.db` |
| `LASTLIGHT_SESSIONS_DIR` | JSONL session envelopes (dashboard reads here) | `$STATE_DIR/agent-sessions` |
| `WORKFLOW_DIR` | YAML workflow definitions | `./workflows` |
| `WEBHOOK_PORT` / `PORT` | webhook listener port | `8644` |

### Approval gates

| Var | Format |
|---|---|
| `APPROVAL_GATES` | comma-separated gate names, e.g. `post_architect,post_triage` |

Parsed into `Record<string, boolean>` (`src/config.ts:242–248`). A phase
declaring `approval_gate: post_architect` only pauses if `post_architect`
appears in the map. Missing names are *implicitly disabled* — there is no
"enable all" mode.

### Dashboard

| Var | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | gate dashboard login | empty (no auth) |
| `ADMIN_SECRET` | HMAC secret for session cookies | `lastlight-dev-secret` |
| `PUBLIC_URL` | absolute base URL for outbound links | derived from `DOMAIN` or unset |
| `DOMAIN` | TLS domain, used to derive `PUBLIC_URL` as `https://<DOMAIN>` | unset |

`ADMIN_SECRET`'s default is unsafe in production — it must be replaced.

### Web search (opt-in per phase)

| Var | Provider |
|---|---|
| `TAVILY_API_KEY` | Tavily |
| `EXA_API_KEY` | Exa |
| `BRAVE_SEARCH_API_KEY` | Brave |

These are forwarded into the sandbox env *only when* the dispatching
phase declared `web_search: true` in its YAML
(`src/engine/agent-executor.ts:116–123`). Auto-detection precedence:
Tavily > Exa > Brave. Provider API keys (Anthropic / OpenAI /
OpenRouter) are forwarded unconditionally.

### Misc

| Var | Purpose | Default |
|---|---|---|
| `BOOTSTRAP_LABEL` | label for issues that set up missing guardrails | `lastlight:bootstrap` |
| `EXPLORE_DEFAULT_REPO` | `owner/name` — destination for Slack-initiated explore publish | unset (must be set or run fails at publish phase) |
| `REVIEW_POSTS_CHECK` | post a Check Run on PR head SHA after pr-review | `false` |
| `LASTLIGHT_GIT_CREDENTIALS` | inline credentials for private repos without App access | unset |
| `LASTLIGHT_WRITE_GLOBAL_GIT` | when `"1"`, configure git globally not just per-repo | `0` |

### CLI client

The `npm run cli` thin client (`src/cli.ts`) reads its own env:

| Var | Purpose | Default |
|---|---|---|
| `LASTLIGHT_URL` | server URL | `http://localhost:8644` |
| `LASTLIGHT_TOKEN` | auth token (checked against `ADMIN_PASSWORD`) | empty |

## Secrets layout

The GitHub App PEM is the only secret with a non-env home. Layout
inside the harness process:

```
secrets/app.pem                     ← original (mode 600)
$STATE_DIR/secrets/app.pem          ← copy populated by deploy/entrypoint.sh
                                      so sandboxes on the shared volume can
                                      reach it, but only when allowed
```

The PEM is read by the harness itself to mint installation tokens
(`src/engine/git-auth.ts`). Sandboxes receive the **minted token**
(`GIT_TOKEN` env), not the PEM. The PEM only reaches a sandbox when the
access profile sets `allowMcpAppAuth: true` (currently only the
`repo-write` profile for the build cycle), and even then via the shared
secrets volume — never inlined in env or sandbox args.

Low-trust sandboxes get `GITHUB_APP_PRIVATE_KEY_PATH=""` explicitly to
short-circuit any inadvertent PEM reads (`src/engine/agent-executor.ts:80–82`).

## STATE_DIR tree

Created at boot (`src/index.ts:78`):

```
$STATE_DIR/
├── lastlight.db           SQLite — see §10
├── logs/                  structured harness logs
├── sandboxes/             cloned repos, one dir per taskId
├── secrets/
│   └── app.pem            mode-600 copy of the GitHub App PEM
├── agent-sessions/        JSONL envelopes, one file per agent session.
│                          Dashboard reads from here.
└── proxy/                 generated egress firewall configs
    ├── nginx-strict.conf
    ├── nginx-open.conf
    ├── Corefile.strict
    └── Corefile.open
```

`proxy/` is regenerated on every harness boot from the allowlist in
`src/sandbox/egress-allowlist.ts` — bind-mounted read-only into the
firewall containers.

## Invariants

- **PEM never reaches a sandbox by default.** Only the `repo-write`
  profile gets it, and only via the shared secrets volume — never via
  env, args, or stdin.
- **Empty `WEBHOOK_SECRET` is permitted but logs a warning.** In
  production this is dangerous; in dev it's necessary for ngrok-style
  setups. The choice is on the operator.
- **Defaults are dev-safe, not prod-safe.** `ADMIN_SECRET` is the most
  obvious example — its default explicitly contains `dev`. A production
  config validator (out of scope for the harness) is the right place to
  refuse boot on dev defaults.
- **JSON config never fails-closed.** Both `LASTLIGHT_MODELS` and
  `LASTLIGHT_THINKINGS` log on parse error and use `{}`. The cost is a
  silent fall-back to the default model — acceptable because the
  alternative would refuse to boot a working harness over a typo.
- **`APPROVAL_GATES` is positive enable, never negative disable.** There
  is no `APPROVAL_GATES=*` shortcut. A re-implementation that wants
  one-line "enable everything" should add an explicit token like `all`,
  not silently treat missing as enabled.
- **`OPENCODE_*` aliases stay.** They are the legacy names from when the
  runtime was OpenCode; they will keep working. New env should use
  `LASTLIGHT_*` for clarity.

## Current implementation

Single file: `src/config.ts`. Schema at `74–143`. JSON parsers for
models/variants at `265–281` and `313–327`. Approval-gate parser at
`242–248`. Public URL resolution at `229–234`. Sandbox backend selection
at `206–214`.

Per-task resolvers — `resolveModel(models, taskType)`, `resolveVariant()` —
sit alongside the schema (`296–297`, `336–340`) and are called from the
runner and dispatch closure, not from the config loader itself.

## Rebuild notes

- **Layered config, not flattened.** Keep base + per-task-override
  separate. Flattening them at load time means future per-task knobs
  require a config schema change instead of a JSON-blob update.
- **Validate at boundary, not at use.** The harness's pre-flight check
  is the right place for fatal validation. Once `LastLightConfig` is
  built, downstream code should not have to re-check field shapes.
- **Type the variant level.** Even if you load it from a string env var,
  parse to a typed enum at the boundary so `thinking: "wat"` fails fast
  instead of silently degrading to a provider default.
- **Pick semantic exit codes.** A re-implementation in Go / Rust / etc.
  should still distinguish "this won't work no matter how many times
  you restart" (use 78 `EX_CONFIG`) from "I crashed" (any other code).
- **Secrets layout is enforceable.** A re-implementation can go further
  and refuse to read the PEM unless it's mode-600 and owned by the
  process user. Last Light's current check is structural (the file
  exists and parses); a hardened version should check the FS metadata
  too.
- **Forward per-provider keys conservatively.** Provider API keys reach
  the sandbox; web-search keys reach it only when the phase opts in.
  A new key category should default to *not* forwarded — opt-in is the
  safe default.
