# Phase 2 — The `fixing` skill and the `diagnose` phase

**Risk: medium — this is the design crux.** Depends on Phase 1 for evidence
quality (it works without it, just less well).

The core insight behind #251: *retrying is only useful if you know why it
failed.* A blind second attempt on a PR whose CI needs a database, or whose
base branch is already red, spends a full install + test cycle to learn nothing.
So the loop classifies first and retries second.

## 2.1 — A `fixing` skill, distinct from `building`

`apps/server/skills/building/SKILL.md` is about **implementing**: install-first,
package-manager detection, the test/lint/typecheck gate, TDD discipline. It
assumes you know what you are trying to build.

`apps/server/skills/fixing/SKILL.md` (new) is about **diagnosing a failure that
already happened** and repairing it minimally. Both `pr-fix` and
`dependabot-ci-fix` switch from `skill: building` to
`skills: [fixing, building]` — `fixing` is the primary (the runner directs the
agent to it), `building` stays available for install/gate mechanics.

Frontmatter:

```yaml
---
name: fixing
description: Diagnose why a PR's CI failed — compare the CI definition against the sandbox, classify the failure, and make the minimal repair. Use when a PR is red and you must work out why before changing anything.
version: 1.0.0
tags: [ci, diagnosis, fix, sandbox]
---
```

### The procedure the skill encodes

1. **Read the real failure.** Start from the structured `{{ciSection}}`. When
   the excerpt is inconclusive, pull the full job log via `github_get_job_logs`
   (Phase 1). If `{{ciSection}}` says logs were unavailable, say so in the
   verdict rather than inventing a cause.
2. **Read the CI definition.** `.github/workflows/*.yml` is already in the
   checkout — the harness pre-cloned the PR head. Extract: runner OS, toolchain
   versions (`setup-node`, `setup-python`, matrix entries), the *exact*
   commands, `services:`, `env:` and which secrets they reference, cache
   config, install flags (`--frozen-lockfile`, `npm ci`).
3. **Compare CI against this sandbox — name the differences explicitly.**
   Toolchain version (`node -v` vs the workflow's), OS, absent services
   (postgres/redis), absent secrets, no browser on the lean image, the egress
   allowlist. This is the step that turns "the tests fail" into "the tests fail
   *here* because CI runs Node 22 and this sandbox is on Node 20".
4. **Reproduce.** Run the *exact* failing command, aligned to CI's toolchain
   where possible (`fnm use <version>` from the workflow file).
5. **Classify** into exactly one class — the load-bearing output.

### The five failure classes

| Class | Meaning | Policy |
|---|---|---|
| `reproducible` | The same command fails here too | Fix it. **Consumes an attempt.** |
| `env-mismatch` | Passes locally, fails in CI on a version/OS/flag difference | Align to CI and re-verify; the repair may be config (engines, matrix, lockfile) rather than code. **Consumes an attempt.** |
| `flaky` | Timeout or network blip, or the same job passed on a prior SHA | Do **not** change code. **Does not consume an attempt.** |
| `infra-dependent` | Needs secrets, a live service, a deployed backend, a browser | Cannot be fixed here — **escalate immediately**, naming the checks. |
| `upstream-broken` | The base branch is red too (`{{baseChecksState}}`) | Not this PR's fault — **skip without `requires-human`**; it self-heals when base goes green. |

`flaky` and `upstream-broken` are the two classes that matter most for cost and
for not poisoning the `requires-human` label: neither should consume budget,
and neither should permanently suppress the PR.

Distinguishing `flaky` from `reproducible` is exactly what
`github_list_workflow_runs` buys — "did this same job pass on an earlier SHA of
this branch?" Without Phase 1's agent tools, `flaky` degrades to
timeout/network heuristics only.

The skill also owns:
- **Push discipline** — push only when the local gate is green (see
  [04-retry.md](04-retry.md)).
- **Writing `../.lastlight-verify.sh`** — the exact gate command derived from
  the CI workflow file, which the within-run loop re-runs (Phase 4).
- **The completion markers** below.

## 2.2 — The `diagnose` phase

A new first phase in **both** `pr-fix` and `dependabot-ci-fix`:

```yaml
  - name: diagnose
    label: Diagnose the failure
    prompt: prompts/diagnose-ci.md
    skill: fixing
    model: "{{models.diagnose}}"   # cheap — it reads logs, it does not write code
    output_var: diagnosis
    on_output:
      requires_marker: "DIAGNOSIS_COMPLETE"
      contains_BLOCKED:
        action: fail
        message: "Can't fix this here — {{phaseOutputs.diagnosis}}"
```

Why a separate phase rather than a section of the fix prompt:

- **It gates spend.** It runs against the already-pre-cloned workspace (free)
  but *before* the expensive install + test cycle. A non-retryable failure
  costs one cheap agent call instead of a full gate run.
- **Its verdict must be able to stop the run.** `infra-dependent` and
  `upstream-broken` should not proceed to a fix at all.
- **Its output is the cross-attempt memory** (see [04-retry.md](04-retry.md)).

A `BLOCKED` verdict fails the phase, which cascades `fix` to a skip. That reads
oddly as "a correct outcome recorded red", but it is already how this workflow
speaks: `dependabot-ci-fix`'s `messages.on_failure` is *"Couldn't auto-fix the
failing checks — leaving it for a human."*

### The marker

```
DIAGNOSIS_COMPLETE: pr=<N> attempt=<K> class=<reproducible|env-mismatch|flaky|infra-dependent|upstream-broken> cause=<one line> ci_vs_local=<one line> unreproducible=<comma-separated check names>
```

One line, bounded — it is persisted per attempt and replayed into the next
attempt's prompt, so it must not grow. `cause` is *why CI failed*;
`ci_vs_local` is *what differs between CI and this sandbox* (empty when
nothing does).

The `fix` phase gains a sibling marker, which also closes the missing-postcondition
gap noted in [00-current-behaviour.md](00-current-behaviour.md):

```
CI_FIX_COMPLETE: pr=<N> attempt=<K> outcome=<pushed|no-change|gave-up> tried=<one line> gate=<green|red|skipped>
```

## 2.3 — `prompts/diagnose-ci.md`

New prompt. Shared by both workflows — the only difference between them is
already carried in context (`{{reason}}` is dependency-specific,
`{{commentBody}}` is the maintainer's request). It should render:

`{{ciSection}}` (structured, Phase 1), `{{baseChecksState}}`, `{{branch}}`,
`{{baseBranch}}`, `{{prNumber}}`, `{{attempt}}`, `{{maxAttempts}}`,
`{{priorAttempts}}` (the previous attempts' marker lines), and `{{reason}}`.

It must be explicit that the agent **changes nothing** in this phase — it
reads, reproduces, and reports. The repair is the `fix` phase's job.

## Files

| File | Change |
|---|---|
| `apps/server/skills/fixing/SKILL.md` | new |
| `apps/server/workflows/prompts/diagnose-ci.md` | new |
| `apps/server/workflows/pr-fix.yaml` | add `diagnose` phase; `fix` → `skills: [fixing, building]` |
| `apps/server/workflows/dependabot-ci-fix.yaml` | same |
| `apps/server/workflows/prompts/pr-fix.md` | consume `{{phaseOutputs.diagnosis}}`, `{{attempt}}`, `{{priorAttempts}}` |
| `apps/server/workflows/prompts/dependabot-ci-fix.md` | same; move the "triage unreproducible checks" prose out into the `fixing` skill |

## Tests

- `apps/server/tests/workflows/dependabot-ci-fix.test.ts` — **update**: the
  phase list becomes `["diagnose", "fix"]`; assert the `diagnose` marker and
  the `contains_BLOCKED` rule.
- New `apps/server/tests/workflows/pr-fix.test.ts` — the same contract for the
  generic workflow (it has no contract test today).
- New `apps/server/tests/skills/fixing.test.ts` — assert the five class names
  appear verbatim in `SKILL.md`, pinned against the enum used by the retry
  policy in Phase 4. Same pattern as `tests/cron/label-vocab.test.ts`, and for
  the same reason: markdown cannot import.

## Done when

- `fixing` exists, is the primary skill on both fix workflows, and documents
  all five classes.
- Both workflows run `diagnose` before `fix`, and a `BLOCKED` diagnosis
  prevents the fix phase running at all.
- Both markers are emitted and enforced by `requires_marker`.
