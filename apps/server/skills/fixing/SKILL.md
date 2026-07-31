---
name: fixing
description: Diagnose why a PR's CI failed — compare the CI definition against the sandbox, classify the failure, and make the minimal repair. Use when a PR is red and you must work out why before changing anything.
version: 1.0.0
tags: [ci, diagnosis, fix, sandbox]
---

# Fixing

`building` is about *implementing*. This is about **a failure that already
happened**: find out why, decide whether it can be fixed here at all, and only
then repair it — minimally.

The discipline is **diagnose-first**. A blind second attempt on a PR whose tests
need a database, or whose base branch is already red, spends a full install and
test cycle to learn nothing. So you classify first and repair second.

## The procedure

**1. Read the real failure.** Start from the structured CI report in your
prompt. When an excerpt is inconclusive, pull the full job log with
`github_get_job_logs`. If the report says logs were **unavailable**, say so in
your verdict — do not invent a cause from an annotation that was truncated.

**2. Read the CI definition.** `.github/workflows/*.yml` is already in the
checkout (the harness pre-cloned the PR head). Extract, per failing job: runner
OS, toolchain versions (`setup-node`, `setup-python`, matrix entries), the
*exact* commands, `services:`, `env:` and which secrets they reference, cache
config, and install flags (`npm ci`, `--frozen-lockfile`).

**3. Name the differences between CI and this sandbox — explicitly.** Toolchain
version (`node -v` against the workflow's), OS, absent services (postgres,
redis), absent secrets, no browser on the lean image, the egress allowlist. This
is the step that turns *"the tests fail"* into *"the tests fail **here** because
CI runs Node 22 and this sandbox is on Node 20"*. Write the comparison down even
when it comes out empty — "no relevant difference" is itself a finding.

**4. Reproduce.** Run the *exact* failing command, aligned to CI's toolchain
where you can (`fnm use <version>` read from the workflow file). Install first
per the **building** skill.

**5. Classify** into exactly one of the five classes below. Done when you have
emitted the `DIAGNOSIS_COMPLETE` marker.

## The five classes

| Class | Meaning | What happens next |
|---|---|---|
| `reproducible` | The same command fails here too | Fix it. Consumes an attempt. |
| `env-mismatch` | Passes here, fails in CI on a version / OS / flag difference | Align to CI and re-verify. The repair is often config (engines, matrix, lockfile) rather than code. Consumes an attempt. |
| `flaky` | A timeout or network blip, or the same job passed on a prior SHA | **Change nothing.** No fix phase runs; no attempt is consumed. |
| `infra-dependent` | Needs secrets, a live service, a deployed backend, a browser | Cannot be fixed here. Escalate, naming the checks. |
| `upstream-broken` | The base branch is red too | Not this PR's fault. Skipped without `requires-human` — it self-heals when the base goes green. |

The last three are **stopping** verdicts: the run ends there, correctly and
successfully. Reaching one is a good outcome, not a failure — stopping cheaply
is the entire point of diagnosing first. Never round a stopping verdict up to
`reproducible` to look useful.

Distinguishing `flaky` from `reproducible` is what `github_list_workflow_runs`
is for: *did this same job pass on an earlier SHA of this branch?* Without that
evidence, reserve `flaky` for an explicit timeout or network error in the log —
a test that simply fails is `reproducible`.

`infra-dependent` is a property of the **check**, not of the PR. A PR whose unit
tests are red *and* whose e2e suite needs a deployed backend is `reproducible`:
fix what you can reproduce, and list the rest under `unreproducible=`.

## The markers

Emit exactly one, as the **last line** of your output, on a single line.

Diagnosis phase:

```
DIAGNOSIS_COMPLETE: pr=<N> attempt=<K> class=<reproducible|env-mismatch|flaky|infra-dependent|upstream-broken> cause=<one line> ci_vs_local=<one line> unreproducible=<comma-separated check names>
```

Fix phase:

```
CI_FIX_COMPLETE: pr=<N> attempt=<K> outcome=<pushed|no-change|gave-up> tried=<one line> gate=<green|red|skipped>
```

Three rules, all load-bearing — these lines are parsed:

- **One line, bounded.** Each marker is persisted per attempt and replayed into
  the next attempt's prompt. `cause=` is *why CI failed*; `ci_vs_local=` is
  *what differs between CI and this sandbox* (write `none` when nothing does).
  Keep every field to a clause, not a paragraph.
- **Write `class=` nowhere else in your output.** The class is read off that
  token, so a "this is not `class=flaky` because…" aside in your prose changes
  what the workflow does. Say "not flaky" in words.
- **Report the outcome you got.** `gate=skipped` when no gate ran. Never claim
  `pushed` without a push or `green` without a passing gate — the next attempt
  reasons from this line.

## Repair discipline

**Smallest change that lands the PR.** Prefer a lockfile regeneration or a
mechanical call-site/type update over a behavioural change. Don't refactor,
don't chase failures unrelated to the diagnosed cause, and don't sink your
budget into one slow or unreproducible check.

**Push only on a green local gate.** The gate is the repo's own build + test +
lint + typecheck, run per the **building** skill. If it is still red when you
run out of iterations, emit `outcome=gave-up` and **do not push a speculative
fix** — an unverified push costs a full CI cycle to prove nothing.

**Write the gate command to `../.lastlight-verify.sh`.** The right command is
whatever CI runs, with the package manager detected from the lockfile — so it is
knowable only at runtime, by you. Write it at the workspace root (a sibling of
the checkout, outside the git tree, so `git clean` cannot remove it and you
cannot commit it), and rewrite it on every attempt: a stale script from a
superseded diagnosis silently gates the wrong thing. Exit 0 means green.
