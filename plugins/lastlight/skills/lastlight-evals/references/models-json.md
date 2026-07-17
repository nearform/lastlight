# Model registry — `models.json`

The eval harness picks models from a `models.json`. Resolution: the scaffolded
`evals/models.json` is picked up automatically (or pass `--models-file <path>`).

```json
{
  "default": "openai/gpt-5.4-mini",
  "compare": [
    { "id": "openai/gpt-5.5",            "label": "GPT-5.5",        "provider": "OpenAI",          "envKey": "OPENAI_API_KEY" },
    { "id": "anthropic/claude-opus-4-8", "label": "Claude Opus 4.8","provider": "Anthropic",       "envKey": "ANTHROPIC_API_KEY" },
    { "id": "fireworks/accounts/fireworks/models/glm-5p2", "label": "GLM-5.2", "provider": "Fireworks (open)", "envKey": "FIREWORKS_API_KEY" }
  ]
}
```

Fields:
- **`default`** — the single model `run` uses when not `--compare`.
- **`compare`** — the cross-vendor set `--compare` runs. **Each entry runs only if
  its `envKey` is present** in the environment, so you can list many and only the
  ones you have keys for execute. Add/remove freely.
- Per entry: `id` is the agentic-pi/pi-ai `provider/model` spec; `label` is the
  scorecard display name; `provider` is a grouping label; `envKey` is the env var
  that gates it.

## Selecting models on the CLI

```bash
lastlight-evals run triage --model haiku                 # fuzzy substring match against ids/labels
lastlight-evals run triage --model openai/gpt-5.5        # exact provider/model id
lastlight-evals run triage --model glm,deepseek          # comma-list
lastlight-evals run --compare                            # the whole compare set (key-gated)
```

You can also override the set with `EVAL_MODELS=<comma-list>` in the environment.

## Provider keys

Set whichever provider keys you have in the workspace `.env`:
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `FIREWORKS_API_KEY` (GLM / DeepSeek /
GPT-OSS), `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`. No GitHub credentials needed —
GitHub is mocked.
