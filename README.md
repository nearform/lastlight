# agentic-pi

A pre-configured, opinionated wrapper around [earendil-works/pi](https://github.com/earendil-works/pi)
that turns it into a **one-shot coding-agent worker** for workflow systems like
[lastlight](https://github.com/cliftonc/lastlight).

If you already have an orchestrator that wants to spawn an agent for one
phase (architect, build, review, triage, …), pipe a prompt in, and parse a
structured event stream back out, this is what slots in. It does the
boring wiring so you don't have to.

## What this is opinionated about

Pi itself is a deliberately minimal harness — it gives you an SDK, a multi-provider
LLM API, an extension model, and four run modes. agentic-pi makes opinionated
choices on top of all of that for one specific use case:

### 1. One-shot only, no interactive mode

The only command is `agentic-pi run`. It reads the prompt from **stdin**, runs
exactly one agent turn (which may contain many tool calls), emits JSONL to
**stdout**, and exits when Pi's `agent_end` fires. There is no REPL, no chat
loop, no `serve` mode. If a phase needs follow-ups, the orchestrator spawns a
new process.

### 2. JSONL event stream tailored for downstream parsing

Pi natively emits a JSONL event stream in `--mode json`. agentic-pi uses Pi's SDK
in-process, subscribes to the same events, and adds three things on top:

- A leading `{"type":"session", "version":3, "id":<uuid>, "cwd":...}` header.
- `sessionId` and `timestamp` injected onto **every** subsequent event, so a
  downstream consumer can correlate without parsing the header line separately.
- A terminal `{"type":"usage_snapshot", "stats":{...}}` event synthesized from
  `session.getSessionStats()` — because Pi's per-event payloads do **not**
  carry token counts or cost.

If your orchestrator needs cost/token accounting, the snapshot is the
single line you parse.

### 3. GitHub repo operations as first-class native tools

Pi explicitly does not support MCP. agentic-pi ships a native Pi extension
exposing **31 GitHub tools** ported from lastlight's `mcp-github-app`:
clone/push, issues, PRs, reviews, labels, search. Tool names are prefixed
with `github_`.

Auth is opinionated: **GitHub App credentials preferred**, static
`GITHUB_TOKEN` only as a low-trust fallback. JWT-minted installation tokens
cached for ~50 minutes, 5-minute refresh buffer, `git credential-store`
file written with mode 600 and a regex-validated token.

### 4. Permission profiles as a registration-time gate

`--profile <name>` picks one of four allowlists ported from lastlight:

| Profile | Tool count | What it can do |
| --- | --- | --- |
| `read` | 18 | Repo/issue/PR reads + search. No mutations. |
| `issues-write` | 24 | Read + issue/comment/label mutations. |
| `review-write` | 26 | Read + issues + PR review/comment + create PR. |
| `repo-write` | 31 | Everything: clone, push, branch, file edits, merge. |

Tools outside the active profile are **never registered** — the LLM cannot see
them in the system prompt and cannot call them. This is a stronger guarantee
than a runtime "ask each time" gate.

The extension is **safe by default** when credentials are missing or
mis-configured:

| Situation | Behaviour | Stderr warning? |
| --- | --- | --- |
| `--profile` not passed | Silent skip. No GitHub tools registered. | No |
| `--profile X`, no `GITHUB_*` env vars at all | Skip. Run continues without GitHub tools. | Yes |
| `--profile X`, partial App creds (e.g. APP_ID set but INSTALLATION_ID missing) | Skip with explicit error. | Yes |
| `--profile X`, App creds set but PEM file unreadable | Skip with explicit error. | Yes |
| `--profile X`, all App creds set and PEM readable | Tools registered. | No |
| `--profile X`, only `GITHUB_TOKEN` set | Tools registered (static-token mode, lower trust). | No |

The `extension_status` JSONL event always reports `status`, `reason`,
`message`, `profile`, and `toolCount` so the orchestrator can log the
outcome programmatically without parsing stderr.

### 5. Model selection

`--model provider/id` (e.g. `anthropic/claude-opus-4-5`, `openai/gpt-4o`).
Credentials come from environment variables (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) or Pi's `~/.pi/agent/auth.json`
if you've logged in interactively. Provider/id mapping is delegated to
`@earendil-works/pi-ai`'s `getModel()`.

`--thinking <level>` maps directly to Pi's `thinkingLevel`
(`off`/`minimal`/`low`/`medium`/`high`/`xhigh`). Per-provider effort is
handled by Pi.

### 6. Defaults that match a containerized sandbox

- **`--no-session`** is intended to be the default in sandboxed runs (state
  lives outside the container).
- **Built-in tools** (read, write, edit, bash, grep, find, ls) are enabled
  by default. Add `--no-builtin-tools` if you want a GitHub-only agent.
- **`AGENTS.md`** in the working directory is auto-loaded as the agent's
  system prompt — same convention Pi uses. Drop your workflow's
  `AGENTS.md` into the mounted workspace and the agent picks it up.

### 7. Optional micro-VM sandboxing via `--sandbox gondolin`

By default Pi's file and bash tools run on the host. Pass `--sandbox gondolin`
and they get routed through a per-run [Gondolin](https://github.com/earendil-works/gondolin)
QEMU micro-VM instead. The orchestrator doesn't need to manage anything —
agentic-pi boots the VM, mounts the working directory at `/workspace`
inside it, runs the agent's tools through it, and tears it down on
`agent_end`.

**What this protects against.** Arbitrary code the agent runs via `bash`
or `write` executes inside the VM, not on the host. A prompt-injection
that gets the agent to `rm -rf /` only rm's the guest, which is thrown
away seconds later. The host workspace is mounted in, so legitimate file
edits *do* persist — destructive `bash` against `/workspace` will still
modify host files (the same trade-off `chroot` and Docker bind mounts
have).

**What this does NOT protect against.** GitHub credentials and the LLM
API key live in the agentic-pi process *outside* the VM. The `github_*`
tools run there. A prompt-injection that subverts Pi into calling
`github_create_issue` does not need to escape the VM — the call happens
host-side. The VM protects against *code execution*, not *tool misuse*.
For protection against tool misuse, restrict the GitHub profile
(`--profile read`).

**Hard requirements.**

- QEMU on the host: `brew install qemu` (macOS) or
  `apt install qemu-system-x86 qemu-system-arm qemu-utils` (Debian/Ubuntu).
- agentic-pi running **natively** on the host, not inside a Docker
  container. See `SPIKE-gondolin.md`: managed-host containers don't
  expose `/dev/kvm`, and macOS Docker uses Apple's
  Virtualization.Framework (not KVM), which is unreachable from inside
  a container.
- On Linux, the running user must have read access to `/dev/kvm`.

**Pre-flight is loud, not silent.** agentic-pi probes for QEMU and
`qemu-img` before starting the VM, and probes the booted VM with
`/bin/true` (5s timeout) before returning. If any check fails, the
process exits 2 with a clean error pointing at the spike doc. The
upstream `VM.create` failure mode of "returns ready but the guest is
dead" cannot leak through.

**Latency cost (measured on macOS Apple Silicon).**

| Op | Time |
| --- | --- |
| First `VM.create` post-boot | ~13 s (one-time cache warm-up) |
| Subsequent `VM.create` | < 100 ms |
| Per-tool overhead | ~200 ms each |
| Realistic shell op (`ls /etc && uname -a`) | ~2.8 s |
| `vm.close` | ~10 ms |

Linux + KVM should be in the same ballpark. Numbers are reproducible
from `test/fixtures/phase3-smoke-sandbox-gondolin.jsonl`.

**Event stream.** A `sandbox_status` JSONL line is emitted right after
the session header. It carries an `envKeys` list (just the keys, never
the values) so consumers can verify which env vars were handed to the VM:

```jsonl
{"type":"sandbox_status","backend":"gondolin","status":{"backend":"gondolin","cwd":"/path/to/workspace","guestPath":"/workspace","createMs":47,"envKeys":["GH_TOKEN","GITHUB_TOKEN"]},"sessionId":"…","timestamp":"…"}
```

If `--sandbox none` (the default), the same line is still emitted with
`backend: "none"` so downstream consumers always know which mode the run
used.

**Passing env into the VM.** Use `--sandbox-env KEY=VAL` on the CLI
(repeatable), or `sandboxEnv: { KEY: "VAL" }` on the programmatic API.
The agent's `bash` calls see these as ordinary environment variables.

When `--profile <github>` is also active and the GitHub extension is
configured, agentic-pi automatically mints a short-lived installation
token via the configured auth backend (App JWT exchange, or static
`GITHUB_TOKEN` passthrough) and injects it as **both** `GITHUB_TOKEN`
and `GH_TOKEN`. Inside the VM, `git push`, `git fetch`, and `gh`
commands work without further setup.

The **App PEM is never copied into the VM** — only the resulting token,
which is short-lived. User-supplied `--sandbox-env GITHUB_TOKEN=…`
overrides the auto-injected value if you need to scope down further.

### 8. Safe web search via the `web-search` extension

agentic-pi can register two native Pi tools — `web_search` and `web_fetch` —
so the agent can do general-purpose research. Backed by a configurable
provider:

| Provider | API key env var | Native content extraction |
| --- | --- | --- |
| Tavily (default) | `TAVILY_API_KEY` | yes (search + extract) |
| Exa | `EXA_API_KEY` | yes (search + contents) |
| Brave Search | `BRAVE_SEARCH_API_KEY` | no — `web_fetch` falls back to a safe HTML→text extractor |

**Auto-enable.** When at least one API key env var is present, the
extension is configured automatically. With multiple keys set, priority is
**Tavily → Exa → Brave**; override with `--web-search-provider` or the
`WEB_SEARCH_PROVIDER` env var. Pass `--no-web-search` to suppress the
tools entirely.

**Host-process egress.** Both tools run in the agentic-pi process, **not**
inside the Gondolin guest. That means:

- The provider API host is **not** added to the Gondolin egress
  allowlist, and the API key is **never** injected into the VM.
- Behavior is identical under `--sandbox=none`, `--sandbox=gondolin`, and
  when agentic-pi itself is containerized. The host's own network policy
  controls reachability to the provider + arbitrary http(s) URLs.

**Safety rails (built-in, non-configurable in v1).**

| Rail | Default |
| --- | --- |
| URL scheme allowlist | `http`, `https` only (`web_fetch`) |
| Request timeout | 15 s |
| Max response bytes | 1 MiB (streamed, aborted on overflow) |
| Max redirects | 3 (scheme re-checked at each hop) |
| Content-type gate (`web_fetch`) | `text/*`, `application/(xhtml+xml\|xml\|json)` |
| Max search results | 10 (regardless of `max_results` arg) |
| Extracted text cap | ~200 KiB |
| HTML cleaning | `<script>`, `<style>`, `<noscript>`, `<iframe>`, comments stripped before extraction |
| Per-run call budget | 30 combined `web_search` + `web_fetch` calls (override with `--web-search-max-calls`) |

When the call budget is hit, further invocations return a structured
rate-limit error result so the agent can recover; the run is **not**
aborted.

**No SSRF blocking.** Loopback / private IP ranges are **not** blocked by
default. Operators who care should run agentic-pi behind their own
egress firewall.

**Event stream.** A second `extension_status` event mirrors GitHub's:

```jsonl
{"type":"extension_status","extension":"web-search","status":"configured","provider":"tavily","toolCount":2,"maxCalls":30,"sessionId":"…","timestamp":"…"}
```

When skipped (no keys / `--no-web-search`), `status: "skipped"` carries a
`reason` of `disabled-by-flag` or `no-credentials`. Misconfigurations
(explicit provider whose key is missing, or an unknown provider name)
surface as a warning before the run starts.

### 9. Default file search via FFF

agentic-pi bundles [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff)
— a Rust-backed, git-aware, frecency-ranked, SIMD-accelerated fuzzy file/content
search — as the **default** file-search backend. It ships as a dependency and is
loaded for **every** run with no per-host `pi install` required.

**`override` mode by default.** FFF registers under Pi's built-in tool names
(`find`, `grep`, `multi_grep`), transparently replacing the built-ins. The agent
gets faster, git-aware search with zero prompt changes. Switch behaviour with
`--file-search-mode`:

| Mode | Tool names | Notes |
| --- | --- | --- |
| `override` (default) | `find`, `grep`, `multi_grep` | Transparent replacement of Pi's built-ins. |
| `tools-only` | `fffind`, `ffgrep`, `fff-multi-grep` | Added alongside Pi's built-ins; the agent chooses. |
| `tools-and-ui` | same as `tools-only` | Adds `@`-mention autocomplete — useless headless; not recommended. |

The CLI flag maps to FFF's `PI_FFF_MODE` env var. An explicit `PI_FFF_MODE` in the
environment wins over the flag. Pass `--no-file-search` to disable FFF entirely and
fall back to Pi's built-in `find`/`grep`.

**Host-process execution.** Like web search, FFF runs in the agentic-pi process,
**not** inside the Gondolin guest. Under `--sandbox gondolin`, `read`/`write`/`edit`/
`bash` route through the VM while `find`/`grep` (FFF) run host-side against the
bind-mounted workspace. Paths align (cwd is the mount), and FFF only touches the
local filesystem — no egress or secret exposure.

**Native binary.** FFF is a native Rust library (`@ff-labs/fff-node`) shipped as
prebuilt per-platform binaries (`fff-bin-linux-x64-gnu`/`-musl`, `darwin`, `win32`).
npm auto-selects the correct one at install time. In containers, run `npm install`
on the target platform — do **not** copy `node_modules` across glibc↔musl.

**Safe by default.** If pi-fff can't be resolved or its native binary fails to load
on the platform, the run is **not** aborted — file search skips with
`reason: "resolve-failed"` (surfaced as a warning) and the agent falls back to Pi's
built-in `find`/`grep`.

**Event stream.** A third `extension_status` event mirrors the others:

```jsonl
{"type":"extension_status","extension":"file-search","status":"configured","mode":"override","toolCount":3,"sessionId":"…","timestamp":"…"}
```

When disabled or unavailable, `status: "skipped"` carries a `reason` of
`disabled-by-flag` or `resolve-failed`.

### 10. Optional OpenTelemetry export via `--otel`

agentic-pi can export **traces and metrics** for its run to any OTLP-compatible
collector, using the standard OpenTelemetry JS SDK and the standard `OTEL_*`
environment variables. This is meant for orchestrators (e.g. lastlight) that
forward `OTEL_*` config into a sandboxed agentic-pi process so Pi's own activity
shows up in their observability stack.

**Off unless explicitly enabled.** Enablement precedence (highest first):

1. `--no-otel` → force-disabled (wins over everything).
2. `--otel` → enabled.
3. env `AGENTIC_PI_OTEL_ENABLED=1` (when neither flag is passed) → enabled.
4. otherwise → disabled.

A bare `OTEL_EXPORTER_OTLP_ENDPOINT` does **not** enable telemetry on its own —
enablement is always intentional. Configure the destination with the usual
`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` /
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (etc.) variables, or `--otel-endpoint` as a
base-URL escape hatch.

**Span tree** (one-shot run → a short-lived root span is correct):

```
agentic_pi.session                 (root; gen_ai.conversation.id = sessionId)
└── agentic_pi.turn
    ├── chat <model>               (per assistant message; tokens, cost, finish reason)
    └── execute_tool <name>        (per tool call; status, duration)
```

**Metrics**: `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`,
`agentic_pi.cost.usd`, `agentic_pi.tool.duration`, `agentic_pi.tool.invocations`,
`agentic_pi.tool.failures`, `agentic_pi.turns`. Attribute names follow the OTEL
GenAI semantic conventions where stable, namespaced under `agentic_pi.*` otherwise.

**Metadata-only by default.** Raw prompt/message/tool-result content is **never**
exported unless you pass `--otel-include-content` (or set
`AGENTIC_PI_OTEL_INCLUDE_CONTENT=1`), in which case content is bounded and
truncated. Metric dimensions are always metadata (bounded cardinality).

**Trace correlation.** If a W3C `TRACEPARENT` env var is present, the session
span is parented to it, so a sandboxed agentic-pi run correlates with the
caller's trace across the process/container boundary.

**Safe by default.** Telemetry never affects the run's exit code, never writes to
stdout/stderr (SDK diagnostics route to the warning channel), and degrades to a
warning if the collector is unreachable. When requested, a final
`extension_status` event mirrors the others:

```jsonl
{"type":"extension_status","extension":"telemetry","status":"configured","includeContent":false,"sessionId":"…","timestamp":"…"}
```

A silent default run (no `--otel`) emits no telemetry event at all.

```bash
# Export to a local collector (e.g. otel-desktop-viewer, Jaeger, Grafana Alloy)
echo "summarize the repo" | OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  node dist/cli.js run --model openai/gpt-5.4-nano --otel --no-session
```

### 11. Agent skills (`SKILL.md`)

Pi natively implements the [Agent Skills standard](https://agentskills.io) — the
same `SKILL.md`-in-a-folder convention used by Claude Code and Codex — and
agentic-pi exposes it. A **skill** is a directory containing a `SKILL.md` with YAML
frontmatter (`name` + `description`) and freeform instructions, plus any helper
scripts/references it needs:

```
roll-dice/
└── SKILL.md
```

```markdown
---
name: roll-dice
description: Roll an N-sided die. Use when asked to roll a die or dice.
---

# Roll Dice

Run `echo $((RANDOM % <sides> + 1))`, replacing `<sides>` with the die size.
```

**Progressive disclosure.** At startup Pi scans the skill locations and puts only
each skill's `name` + `description` into the system prompt. When a task matches, the
agent `read`s the full `SKILL.md` on demand, then loads any referenced scripts/assets
by relative path. This keeps the prompt small while making many skills available.

**Default locations — already discovered, no flag needed.** Drop a skill into any of:

- Global: `~/.pi/agent/skills/`, `~/.agents/skills/`
- Project (cwd + ancestors to git root): `.pi/skills/`, `.agents/skills/`
- Packages: a `skills/` directory or `pi.skills` entry in a dependency's `package.json`

**Mapping an existing skills folder via `--skill`.** To use skills you already keep
elsewhere — e.g. your Claude Code skills, or a directory mounted into a CI container —
point at it with `--skill <path>` (repeatable; accepts a directory of skills or a
single skill). It's **additive even with `--no-skills`**:

```bash
# Map your Claude Code skills directory straight into the agent
echo "use the roll-dice skill to roll a d20" | node dist/cli.js run \
  --model openai/gpt-5.4-nano --no-session --skill ~/.claude/skills

# Load ONLY an explicit folder; suppress all default discovery
... --no-skills --skill ./ci-skills

# Turn skills off entirely
... --no-skills
```

Programmatic callers pass `skillPaths: string[]` / `noSkills: boolean` to `run()`.

**Cross-harness reuse via settings.** Instead of a flag on every run, list skill
directories in a Pi `settings.json` (under the agent dir) so they always load:

```json
{
  "skills": ["~/.claude/skills", "~/.codex/skills"]
}
```

**One-shot caveat.** agentic-pi has no interactive mode, so Pi's `/skill:name` slash
command doesn't apply here — skills are **model-invoked** from the catalog. If the
model doesn't pick up a skill on its own, name it in the prompt ("use the `roll-dice`
skill …") to nudge it to load the `SKILL.md`.

**Safe by default.** A `--skill` path that doesn't exist is dropped with a warning
rather than aborting the run. Skills are a Pi-native *resource* (fed to the resource
loader), not agentic-pi tools, so they don't appear in the `extension_status` events.

**Observability.** Pi emits no skill-specific event, and skill *usage* only shows up
indirectly — when the agent loads a skill it `read`s the `SKILL.md`, so it surfaces as
a normal `tool_execution_start`/`_end` whose `args.path` ends in `SKILL.md`. To make
*discovery* visible, agentic-pi synthesizes a single `skills_status` event at startup:

```jsonl
{"type":"skills_status","status":"configured","discovered":2,"skills":[{"name":"roll-dice","source":"/abs/roll-dice/SKILL.md","modelInvocable":true}],"mappedPaths":["/abs/skills"],"noSkills":false,"sessionId":"…","timestamp":"…"}
```

`status` is `default` (no flags), `configured` (`--skill` paths resolved), or
`disabled` (`--no-skills`). `modelInvocable` is `false` for skills that set
`disable-model-invocation: true` (present but never auto-loaded). The event is
**gated**: a default run that discovers no skills emits nothing, so the golden JSONL
fixtures stay byte-identical. Programmatic callers read the same data from
`result.skills`.

> **Security:** a skill can instruct the model to take any action and may bundle code
> the model runs. Only map skill directories you trust.

## When to use this

- You have an orchestrator that calls a coding agent once per workflow
  phase, in a container, and parses a JSONL stream.
- You need GitHub repo operations available to the agent without standing
  up an MCP server.
- You want safe, sandbox-mode-agnostic web search available to the agent.

## When **not** to use this

- You want a chat UI or a long-running agent. Use [`pi`](https://github.com/earendil-works/pi)
  directly — its interactive and RPC modes are excellent.
- You want generic MCP support. Pi has none by design and agentic-pi inherits
  that decision; only the GitHub tool surface is built-in.
- You want a different tool surface (Linear, GitLab, internal APIs). Fork the
  `extensions/github/` directory as a template. agentic-pi bundles specific Pi
  extensions (GitHub, web search, FFF file search) but does not (yet) load
  arbitrary operator-supplied extensions as a runtime plugin system.

## Usage

```bash
echo "list open PRs on owner/repo" | agentic-pi run \
  --model anthropic/claude-haiku-4-5 \
  --profile read \
  --no-session
```

Required env (one of):

```bash
# Anthropic/OpenAI/OpenRouter — at least one matching your --model
ANTHROPIC_API_KEY=sk-ant-…
OPENAI_API_KEY=sk-…
OPENROUTER_API_KEY=sk-or-…

# GitHub — App credentials preferred over static token
GITHUB_APP_ID=…
GITHUB_APP_PRIVATE_KEY_PATH=/abs/path/app.pem
GITHUB_APP_INSTALLATION_ID=…
# or, for low-trust fallback:
GITHUB_TOKEN=ghp_…
```

## Flags

| Flag | Description |
| --- | --- |
| `--model <provider/id>` | Required. e.g. `anthropic/claude-opus-4-5`, `openai/gpt-4o`. |
| `--thinking <level>` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh`. |
| `--profile <name>` | `read` \| `issues-write` \| `review-write` \| `repo-write`. Omit to disable GitHub tools entirely. |
| `--cwd <path>` | Working directory for the agent. Default: `$PWD`. |
| `--no-session` | Ephemeral run — do not persist session jsonl. Recommended in sandboxed containers. |
| `--session-dir <path>` | Override session storage location. |
| `--no-builtin-tools` | Disable Pi's `read,write,edit,bash,grep,find,ls`. |
| `--tools <a,b,c>` | Explicit tool allowlist (combined with profile if set). |
| `--sandbox <none\|gondolin>` | Route `read`/`write`/`edit`/`bash` through a sandbox backend. Default `none`. `gondolin` boots a QEMU micro-VM mounting cwd at `/workspace`. Requires QEMU on the host; native-only (not Docker-in-Docker). See section 7. |
| `--sandbox-env KEY=VAL` | Inject env var into the sandbox VM (repeatable). Ignored when `--sandbox=none`. Auto-injects a minted `GITHUB_TOKEN`/`GH_TOKEN` when `--profile` is also active. |
| `--allow-host <host>` | Add host to the sandbox HTTP egress allowlist (repeatable). Ignored when `--sandbox=none`. |
| `--no-network` | Disable sandbox HTTP egress entirely. Ignored when `--sandbox=none`. |
| `--web-search-provider <p>` | Force web-search provider: `tavily` \| `brave` \| `exa`. Default: auto-detect by env. See section 8. |
| `--no-web-search` | Disable the web-search extension (no `web_search`/`web_fetch` tools). |
| `--no-file-search` | Disable the bundled FFF file-search extension; fall back to Pi's built-in `find`/`grep`. |
| `--file-search-mode <m>` | FFF mode: `override` (default) \| `tools-only` \| `tools-and-ui`. Overridden by the `PI_FFF_MODE` env var. See section 9. |
| `--skill <path>` | Load Agent Skills from `<path>` (a skills dir or a single skill). Repeatable; additive even with `--no-skills`. Maps e.g. `~/.claude/skills` into the agent. Default-location skills load without this. See section 11. |
| `--no-skills` | Disable Pi's default skill discovery. Explicit `--skill` paths still load. |
| `--web-search-max-calls <n>` | Cap combined `web_search` + `web_fetch` calls per run. Default: 30. |
| `--otel` | Enable OpenTelemetry traces + metrics export. Off by default. Requires an OTLP endpoint via `OTEL_EXPORTER_OTLP_ENDPOINT` (or `--otel-endpoint`). See section 10. |
| `--no-otel` | Force-disable OTEL even if `AGENTIC_PI_OTEL_ENABLED=1`. |
| `--otel-include-content` | Attach prompt/message/tool content to spans (bounded + truncated). Default: metadata-only. |
| `--otel-service-name <n>` | Override `OTEL_SERVICE_NAME` (default: `agentic-pi`). |
| `--otel-endpoint <url>` | Override `OTEL_EXPORTER_OTLP_ENDPOINT` base URL. |

Reads the prompt from stdin. Emits JSONL on stdout. Exits 0 on `agent_end`,
1 on fatal error.

## Event stream

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"…","cwd":"…"}
{"type":"sandbox_status","backend":"none","status":{"backend":"none"},"sessionId":"<uuid>","timestamp":"…"}
{"type":"extension_status","extension":"github","status":"configured","profile":"read","toolCount":18,"sessionId":"<uuid>","timestamp":"…"}
{"type":"extension_status","extension":"web-search","status":"configured","provider":"tavily","toolCount":2,"maxCalls":30,"sessionId":"<uuid>","timestamp":"…"}
{"type":"extension_status","extension":"file-search","status":"configured","mode":"override","toolCount":3,"sessionId":"<uuid>","timestamp":"…"}
{"type":"skills_status","status":"configured","discovered":1,"skills":[{"name":"roll-dice","source":"…/SKILL.md","modelInvocable":true}],"mappedPaths":["…"],"noSkills":false,"sessionId":"<uuid>","timestamp":"…"}
{"type":"agent_start","sessionId":"<uuid>","timestamp":"…"}
{"type":"turn_start","sessionId":"<uuid>","timestamp":"…"}
{"type":"message_start","message":{…},"sessionId":"<uuid>","timestamp":"…"}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"…"},"sessionId":"<uuid>","timestamp":"…"}
{"type":"tool_execution_start","toolCallId":"…","toolName":"github_list_pull_requests","args":{…},"sessionId":"<uuid>","timestamp":"…"}
{"type":"tool_execution_end","toolCallId":"…","toolName":"github_list_pull_requests","result":{"content":[…]},"isError":false,"sessionId":"<uuid>","timestamp":"…"}
{"type":"message_end","message":{…},"sessionId":"<uuid>","timestamp":"…"}
{"type":"turn_end","message":{…},"toolResults":[…],"sessionId":"<uuid>","timestamp":"…"}
{"type":"agent_end","messages":[…],"willRetry":false,"sessionId":"<uuid>","timestamp":"…"}
{"type":"usage_snapshot","stats":{"userMessages":1,"assistantMessages":2,"toolCalls":1,"toolResults":1,"tokens":{"input":…,"output":…,"cacheRead":…,"cacheWrite":…,"total":…},"cost":0.000…},"sessionId":"<uuid>","timestamp":"…"}
```

`extension_status` is emitted once at startup so downstream logs can confirm
the GitHub profile (and whether auth succeeded). `skills_status` is emitted once
at startup too, but **only** when skills were configured or discovered (section 11) —
a default run with no skills omits it entirely. `usage_snapshot` is always the last
line in a successful run.

## Programmatic usage

If your orchestrator runs Node, you can skip the subprocess and import
agentic-pi directly. The `run()` API never touches `process.stdout` or
`process.stderr` — it returns a fully-derived `RunResult` and forwards
events through callbacks instead.

```ts
import { run } from "agentic-pi";

const result = await run({
  model: "anthropic/claude-haiku-4-5",
  prompt: "list the open PRs on owner/repo and summarize them",
  thinking: "medium",
  profile: "read",
  sandbox: "none",
  noSession: true,
  cwd: "/path/to/workspace",

  // Per-run env handed to the sandbox VM. Ignored when sandbox="none".
  // When sandbox="gondolin" + profile is set, GITHUB_TOKEN/GH_TOKEN are
  // auto-injected from a minted installation token — explicit values
  // here win.
  sandboxEnv: {
    CI_BUILD_REF: process.env.GITHUB_SHA ?? "",
  },

  // Optional observability hooks. Both are pure callbacks — no I/O happens
  // unless you do something with the values.
  onEvent: (record) => myShim.writeJsonl(record),
  onWarn: (msg) => myLogger.warn(msg),
});

if (!result.ok) {
  throw new Error(result.fatalError?.message ?? "agent failed");
}

console.log(result.finalText);           // "There are 3 open PRs: …"
console.log(result.sessionId);           // Pi session UUID
console.log(result.stats?.tokens.total); // total tokens
console.log(result.stats?.cost);         // USD
console.log(result.sandbox?.backend);    // "none" | "gondolin"
console.log(result.github?.status);      // "configured" | "skipped"
console.log(result.records.length);      // full event log
```

### `RunResult` shape

| Field | Type | Description |
| --- | --- | --- |
| `exitCode` | `0 \| 1 \| 2` | Same code the CLI would have returned. |
| `ok` | `boolean` | `exitCode === 0`. |
| `agentEnded` | `boolean` | Pi emitted `agent_end`. |
| `toolErrors` | `boolean` | At least one tool returned an error. |
| `fatalError` | `{name, message}` \| `undefined` | Set if a fatal error short-circuited the run. |
| `sessionId` | `string` \| `undefined` | Pi session UUID. |
| `cwd` | `string` \| `undefined` | Working directory the agent ran in. |
| `startedAt` | `string` \| `undefined` | ISO timestamp of session start. |
| `finalText` | `string` | Concatenated last-assistant text content. |
| `messages` | `unknown[]` | Full Pi message array from `agent_end`. |
| `stats` | `{userMessages, assistantMessages, toolCalls, toolResults, tokens: {input, output, cacheRead, cacheWrite, total}, cost}` \| `undefined` | Token + cost rollup. |
| `sandbox` | `{backend, status}` \| `undefined` | Mirror of the `sandbox_status` event. |
| `github` | `{status, reason, profile, toolCount}` \| `undefined` | Mirror of the GitHub `extension_status` event. |
| `webSearch` | `{status, reason, provider, toolCount, maxCalls}` \| `undefined` | Mirror of the web-search `extension_status` event. |
| `fileSearch` | `{status, reason, mode, toolCount}` \| `undefined` | Mirror of the FFF file-search `extension_status` event. |
| `skills` | `{status, discovered, skills: {name, source, modelInvocable}[], mappedPaths, noSkills}` \| `undefined` | Mirror of the `skills_status` event. Absent when none configured/discovered (section 11). |
| `records` | `EmitterRecord[]` | Every JSONL record in order. Same shape that the CLI writes. |
| `warnings` | `string[]` | Warnings that would have gone to stderr in CLI mode. |

### When to use which API

| If you want… | Use |
| --- | --- |
| The same observable stream the CLI produces, captured to a file or proxied to a UI | `run({ ..., onEvent })` |
| A single object describing the outcome (lastlight's `ExecutionResult` mapping) | `run()` and read `result.finalText`/`result.stats` |
| Direct control over the sink (e.g. write straight to a writable stream you already have) | `run({ ..., extraSink })` or drop down to `runOnce(config, prompt, { sink, onWarn })` |
| Cancellation | Not supported yet — kill the host process. Open an issue if you need this. |

### Notes for in-process callers

- agentic-pi reuses the host process's env vars (`OPENAI_API_KEY`,
  `GITHUB_APP_ID`, …). If your orchestrator runs multiple
  workflows with different credentials, `process.env` is the seam to vary.
- `cwd` is per-call; you can run multiple agents in parallel against
  different working directories from the same orchestrator process.
- Sessions are created fresh each call. Pass `noSession: true` if you
  don't want session JSONLs accumulating under `~/.pi/agent/sessions/`.
- The sandbox boots and tears down per call. If you're processing many
  short tasks against the same workspace, the per-task VM cost adds up;
  consider batching or just leaving `sandbox: "none"`.

## Development

```bash
npm install
npm run build
npm test                 # full suite — skips integration tests if env not set
npm run test:unit        # unit only (fast, no API keys, no QEMU)
npm run test:integration # integration only (needs OPENAI_API_KEY; sandbox also needs QEMU)

echo "hello" | node dist/cli.js run --model anthropic/claude-haiku-4-5 --no-session
```

### Tests

The test suite uses Node's built-in test runner (`node:test`) and `tsx`
to load TypeScript. Files are discovered by `scripts/run-tests.mjs`,
which walks `test/` for `*.test.ts`.

| File | What it covers | Skip condition |
| --- | --- | --- |
| `test/args.test.ts` | CLI flag parsing happy path + every error case | — |
| `test/emitter.test.ts` | `Emitter`, `CollectorSink`, `TeeSink` contracts | — |
| `test/models.test.ts` | `provider/id` parsing including openrouter triple-slash | — |
| `test/extensions/github/profiles.test.ts` | Profile → tool allowlist (counts, superset structure, scope tiering) | — |
| `test/extensions/github/credentials.test.ts` | `assertSafeToken` and `credentialsFilePath` validation | — |
| `test/extensions/web-search/*.test.ts` | Provider selection, extension wiring, safe-fetch rails, HTML extraction, rate limiter, per-provider normalization (all with injected `fetchImpl`) | — |
| `test/extensions/file-search/index.test.ts` | FFF extension wiring: mode → tool names, package resolution, disabled-by-flag + resolve-failed skips | — |
| `test/sandbox/preflight.test.ts` | Preflight returns a structured ok\|error result | — |
| `test/run.integration.test.ts` | Programmatic `run()`: RunResult populated, onEvent fires for every record, **child-process check confirms zero stdout/stderr leak from library** | `OPENAI_API_KEY` not set |
| `test/run-sandbox.integration.test.ts` | `run({ sandbox: "gondolin" })` boots a VM, agent's `write` tool produces a host file via the mount | `OPENAI_API_KEY` not set OR QEMU/preflight unavailable |

Unit tests run in ~170 ms. Integration tests cost about $0.001 per run on
`gpt-5.4-nano`.

## Releasing

agentic-pi publishes to npm via a GitHub Actions workflow using **npm
trusted publishing** (OIDC) — no `NPM_TOKEN` secret is needed in the
repo.

To cut a release:

1. Bump `version` in `package.json` — `npm version patch` (or `minor` /
   `major`) does the version bump, the commit, and the tag in one step.
2. Push the commit and tag: `git push --follow-tags`. CI runs against
   the version-bump commit on `main`.
3. Create a GitHub Release on the new tag once CI is green:
   `gh release create v0.2.0 --generate-notes` or via the web UI.
4. The `publish.yml` workflow runs on the `release: published` event —
   this is the only auto-trigger. (CI does not re-run; `publish.yml`
   re-validates type-check, build, and unit tests itself so nothing is
   skipped.)

`publish.yml` also accepts a manual `workflow_dispatch` with an explicit
tag/ref — useful if a release-triggered run failed (network, OIDC config
not yet set up) and you want to retry without re-cutting the release.

The publish step fails if the tag (or the dispatch `ref` input) doesn't
match `package.json` version — there is no path that publishes a version
not represented in the repo at that exact commit.

### One-time setup (trusted publisher)

The first publish of a package needs to be done manually; subsequent
ones go through the workflow. To enable OIDC for this repo's publishes:

1. Visit the package's "Trusted Publishers" page on
   <https://www.npmjs.com/package/agentic-pi/settings>.
2. Add a GitHub Actions trusted publisher with:
   - Organization: `cliftonc`
   - Repository: `agentic-pi`
   - Workflow filename: `publish.yml`
   - Environment: leave empty (the workflow doesn't use one)

After that, every tag push triggers a workflow that mints an OIDC token,
npm verifies it against the configured publisher, and the publish goes
through with a [provenance statement](https://docs.npmjs.com/generating-provenance-statements)
attached.

Project layout:

```
src/
  cli.ts                       argv → run config; reads stdin; wraps run()
  index.ts                     public library API: run, RunResult, sinks
  run.ts                       programmatic entry: in-process run() + result accumulation
  args.ts                      flag parser
  stdin.ts                     stdin slurp
  runner.ts                    createAgentSession → subscribe → prompt → emit
  emitter.ts                   sink abstraction (Stdout / Collector / Tee) + Emitter
  models.ts                    "provider/id" → getModel(...)
  extensions/github/
    index.ts                   loadGitHubExtension(profile) entry
    auth.ts                    GitHubAppAuth (JWT → installation token) + static fallback
    client.ts                  Octokit wrapper with retry/backoff
    credentials.ts             git credential-store file writer (mode 600)
    profiles.ts                4 profiles → tool name allowlists
    tools.ts                   31 defineTool() registrations
  extensions/file-search/
    index.ts                   loadFileSearchExtension() — resolves bundled @ff-labs/pi-fff
  sandbox/
    index.ts                   buildSandbox(backend) dispatcher
    preflight.ts               QEMU + accelerator detection (refuses to start if hung)
    gondolin.ts                VM lifecycle + tool overrides for read/write/edit/bash
test/fixtures/                 golden JSONL streams from real runs
SPIKE-gondolin.md              spike notes on why sandbox is native-only
```

## Status & relationship to Pi

agentic-pi pins to `@earendil-works/pi-coding-agent ^0.75.4`. It uses Pi's SDK
in-process (`createAgentSession`, `session.subscribe`, `session.prompt`,
`session.getSessionStats`) — not the CLI subprocess. If Pi's SDK changes shape,
agentic-pi will need to track it; that's the trade-off taken for in-process
speed and direct access to session state.

It does **not** wrap, fork, or modify Pi. Pi's defaults that we don't
override remain in effect: AGENTS.md auto-discovery, ~/.pi/agent skills /
extensions / prompts / themes, the same model registry, the same auth
storage. If you `pi /login` and authenticate via subscription, agentic-pi
will pick that up too.
