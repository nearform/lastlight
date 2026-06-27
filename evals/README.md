# Last Light evals

A small, **SWE-bench-compatible** eval harness that drives the **real**
production workflows (`issue-triage`, `build`, …) — their actual prompts and
skills — against a **mocked GitHub**, grades the result deterministically, and
prints a model-comparison scorecard. It's how we answer "what do we expect from
the agent, and which model does it best?"

Nothing here talks to real GitHub. The agent's `github_*` tool calls are served
by an in-process fake (seeded + recording), and `git push` goes to a local bare
repo. The only deviations from production are the ones we can't do unattended:
approval gates are disabled and outward side-effects are mocked.

## How it works

```
instance (SWE-bench shape)
   │
   ├─ start fake GitHub (seeded with the issue, records every mutation)
   ├─ (code-fix) seed workspace: fixture repo @ base_commit + local bare origin
   ├─ load the REAL workflow YAML (issue-triage / build / …)
   ├─ runWorkflow(sandbox:"none", githubApiBaseUrl→fake, approvalConfig:{})
   └─ grade:
        • execution  — apply held-out tests, run them → FAIL_TO_PASS / PASS_TO_PASS
        • behavioral — recorded GitHub calls vs the instance's expectations
```

The agent reaches the fake GitHub because agentic-pi's built-in GitHub tools
accept a `githubApiBaseUrl` (added in agentic-pi ≥ 0.2.11); Last Light threads
it through `ExecutorConfig.githubApiBaseUrl` → `agenticRun`. Static-token mode
(`GITHUB_TOKEN` set, no App creds) means no real token is ever minted.

## Run it

```bash
# triage tier (cheap, fast), default model
npm run eval

# choose tiers
npm run eval -- triage
npm run eval -- code-fix
npm run eval -- triage code-fix

# compare models (any provider/model id pi-ai knows)
EVAL_MODELS="openai/gpt-5.5,openai/gpt-5.4-mini" npm run eval
```

Needs a provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
`OPENROUTER_API_KEY`) in the environment or repo-root `.env`. Output: a
scorecard table on stdout plus `evals/results/<tiers>/`:

- `scorecard.json` — structured roll-up per model.
- `predictions.jsonl` — SWE-bench predictions shape
  (`{ instance_id, model_name_or_path, model_patch }`).

The runner exits non-zero **only** if the harness itself errors — a weak model
scoring poorly is the measurement, not a build failure.

## Files

| File | Role |
|---|---|
| `schema.ts` | `SweBenchInstance` (SWE-bench-compatible) + result types. |
| `fake-github.ts` | In-process fake GitHub REST API: serves seeded fixtures, records mutations. |
| `seed.ts` | Deterministic workspace seed (fixture @ base_commit + local bare `origin`). |
| `grade.ts` | Execution grade (held-out tests → resolved) + behavioral/triage grade. |
| `metrics.ts` | Token/cost/turn roll-up from the session jsonl. |
| `run-instance.ts` | Orchestrates one instance through the real workflow + grading. |
| `report.ts` | Scorecard table + `scorecard.json` + `predictions.jsonl`. |
| `run.ts` | CLI entry (`npm run eval`). A measurement, not a test. |
| `mechanism.test.ts` | **Deterministic, AI-free** tests of the harness plumbing — run in `npm test`. |
| `datasets/<tier>/` | `instances.json` + (code-fix) `repos/<id>` fixtures + `tests/<id>` held-out tests. |

## Tiers

- **triage** — runs the real `issue-triage` workflow; the agent reads the
  seeded issue and applies labels/comments via `github_*`. Graded on the
  applied labels (`triage_gold`) + `expect_github`. Cheap, no code execution.
- **code-fix** (SWE-bench-style) — runs the real `build` workflow against a
  seeded TypeScript fixture; the agent fixes the bug and opens a PR (against the
  fake). Graded by **execution**: apply the held-out tests and require every
  `FAIL_TO_PASS` to pass and every `PASS_TO_PASS` to stay green. Heavier (full
  architect→executor→reviewer→pr cycle).

## Add a case

**Triage** — append to `datasets/triage/instances.json`:

```json
{
  "instance_id": "triage__my-case",
  "repo": "lastlight-evals/widget",
  "workflow": "issue-triage",
  "problem_statement": "short title",
  "issue": { "number": 110, "title": "…", "body": "…", "labels": [] },
  "triage_gold": { "category": "bug", "state": "ready-for-agent" },
  "expect_github": { "labels_added": ["bug"] }
}
```

**Code-fix** — add three things keyed by `instance_id`:

```
datasets/code-fix/instances.json          # the SweBenchInstance (FAIL_TO_PASS / PASS_TO_PASS)
datasets/code-fix/repos/<id>/             # fixture repo at base_commit (NO held-out tests)
datasets/code-fix/tests/<id>/             # held-out test files, copied in at grade time
```

Held-out tests are run with `node --test --experimental-strip-types`
(zero-dependency, pure TypeScript). Tests are kept out of the seeded repo so the
agent can't edit them — exactly like SWE-bench's `test_patch`. For React/DOM
fixtures, set a custom test command (future work — see below).

## Notes / future work

- **agentic-pi dependency.** The GitHub-mock seam (`githubApiBaseUrl`) ships in
  agentic-pi ≥ 0.2.11; Last Light depends on `^0.2.11`. The deterministic
  `mechanism.test.ts` exercises the seam against the installed package.
- **Backend.** Runs on the in-process `none` backend (no Docker): the fake
  GitHub is host-local at `127.0.0.1` and the real workflow/prompts/skills/agent
  loop all run unchanged. A Docker-backed eval (full isolation/egress fidelity)
  would need the fake reachable in-container — a future upgrade.
- **Real SWE-bench Lite.** The schema is compatible; ingesting real instances
  needs per-repo Python Docker environments — a separate effort.
- **React fixtures.** Need a real test runner (vitest + jsdom) and per-fixture
  deps; the harness already supports a per-instance test command override.
- **LLM-as-judge.** Deterministic-only today, by design.
