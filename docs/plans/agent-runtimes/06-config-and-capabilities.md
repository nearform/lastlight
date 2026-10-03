# 06 — Config surface and capability matrix

## Config

```yaml
# config/default.yaml
runtimes:                  # per-task map, resolved exactly like models:
  default: agentic-pi      # (phase/helper key > default)
  # review-site: claude-code

agentRuntimes:             # definitions
  claude-code:
    command: null          # override the pinned adapter bin
    env: {}
    maxTurns: null
    modelMap: { "anthropic/*": "$id" }
  codex:
    modelMap: { "openai/*": "$id" }
    approval: untrusted
  opencode:
    modelMap: { "*": "$spec" }
```

- **Per-phase `runtime:`** next to `model:` / `variant:` (`schema.ts:160-161`,
  `393-400`), templatable (`"{{runtimes.review-site}}"`), overlaid by
  `phaseConfigFor` (`phase-executor.ts:~162`). Loops also get `fix_runtime`
  beside `fix_model` / `fix_variant` (`schema.ts:50-52`). Fan-out branches
  inherit or override.
- **Load-time validation**, failing with a message that names the phase:
  - the runtime exists;
  - the runtime supports the backend (an ACP runtime on `gondolin`, the
    current default backend at `default.yaml:133`, is an error);
  - `translateModel` succeeds (e.g. `claude-code` + `openai/*` is an error).
- **Repo config** (`packages/shared/src/repo-config-schema.ts`): a new
  `runtimes` key, **not** in `DEFAULT_REPO_CONFIG_ALLOW_KEYS`. A managed repo
  must never be able to switch an operator's runtime by default.

## Model translation

| Runtime | Rule |
|---|---|
| claude-code | `anthropic/x` → `x`; gateway endpoint overrides → `ANTHROPIC_BASE_URL` |
| codex | `openai/x` → `x` |
| opencode | `provider/id` passes through, with alias overrides where pi-ai and models.dev ids differ |

## Thinking ladder

Pi's `off < minimal < low < medium < high < xhigh` stays the normalized
vocabulary. Each runtime maps it to its `thought_level` options,
nearest-not-above. A miss emits a `warning`.

- Claude has no `off` or `minimal`; both map to `low`.
- Codex `reasoning_effort` maps nearly 1:1.
- OpenCode depends on the model's variants.

## Capability matrix

| Capability | agentic-pi | Claude Code | Codex | OpenCode |
|---|---|---|---|---|
| Backends | all incl. gondolin, in-process | docker / smol / k8s / none (child) | same | same |
| GitHub tools | native, profile-gated | MCP, gated; `mcp__lastlight__` prefix | MCP | MCP |
| Policy block with reason | yes | yes (hook) | **no reason** (unless P0 wrapper) | plugin **[UNVERIFIED]** |
| Gate clamp | yes | yes (hook `updatedInput`) | **no** (unless P0 wrapper) | plugin **[UNVERIFIED]** |
| Max turns | Pi step cap | `maxTurns` | **no** | agent steps **[UNVERIFIED]** |
| Cost | exact | exact | **estimated** | runtime-reported |
| Per-message usage / LLM spans with tokens | yes | **totals only** | no | no |
| Thinking text | yes | yes | **[UNVERIFIED]** | yes |
| Skills | `--skill` + `--no-skills` | native **[UNVERIFIED]** / catalogue | same | same |
| AGENTS.md context | walk-up | `systemPrompt.append` | `$CODEX_HOME/AGENTS.md` | config `instructions` |
| Web search off by default | `--no-web-search` | `disallowedTools` | config **[UNVERIFIED]** | permission deny |
| Wall-clock kill on `none` | **no** (in-process) | yes | yes | yes |
| Turns comparable | yes | synthesized | synthesized | synthesized |

**Skills fallback.** Until native skill delivery is verified for a runtime, the
bridge prepends a catalogue to the prompt: name, description and absolute
`SKILL.md` path per skill. The agent reads files on demand. That reproduces
Pi's progressive disclosure on any runtime, and `skills.status` records
`delivery: "catalogue"`.
