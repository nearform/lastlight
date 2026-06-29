# examples/overlay — sample deployment overlay

A minimal Last Light **overlay** for exercising the `config` eval run type — the
mode that runs a deployment's *real per-step model config* (different models per
workflow phase) instead of forcing one model across every step.

It mirrors a real instance overlay (the kind `lastlight-evals init` /
`lastlight-overlay` scaffold) but trimmed to what the eval harness consumes:
just `config.yaml`'s `models` / `variants` maps. See the comments in
[`config.yaml`](./config.yaml).

## Try it

```bash
# Per-step config over the code-fix (build) workflow — multiple phases, so the
# per-phase model map is visible in the dashboard's "Per-step models" panel.
lastlight-evals run code-fix --mode config --overlay examples/overlay

# Cheap smoke test (single triage phase):
EVAL_INSTANCE=<id> lastlight-evals run triage --mode config --overlay examples/overlay
```

Config runs land under `eval-results/<tier>-config/`, on their own dashboard
trend line — separate from `models` (compare-models) runs.

To compare two configs side-by-side in one run, pass `--overlay` twice:

```bash
lastlight-evals run code-fix --mode config --overlay examples/overlay --overlay ../my-other-overlay
```
