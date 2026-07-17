# Author a code-fix or triage eval case from a real GitHub PR or issue

`lastlight-evals add-case --pr <url> --code-fix` turns a real GitHub **PR** into a
code-fix (build) case; `--issue <url>` turns an **issue** into a triage case. It
does the mechanical, reproducible extraction with `gh` + `git`; **you** refine the
judgement parts. The result is a **git-source** case — no fixture repo is
vendored; at run time the harness clones the repo into the gitignored
`./.eval-cache/` and checks out `base_commit` (see the `instance-schema.md`
"Git-source" flavor).

> A PR seeds two different evals. Use `--code-fix` (this doc) to hide the fix and
> have the agent reproduce it; use `--review` (see **`authoring-pr-review.md`**)
> to grade a review of the PR against its human review. `--pr` **requires** one of
> the two — it no longer defaults to code-fix.

## Two grading modes (default: suite)

- **Suite (default).** Nothing is held out. The agent works on the repo, then the
  case is graded by running the repo's own `test_cmd` against the agent's **final
  tree** — resolved iff it exits 0. This grades "did the agent leave the repo with
  a passing suite?", and matches how the agent itself judges done (it ran the same
  tests). Note: for a *feature* PR the suite is usually already green at base, so a
  no-op would resolve it — `add-case` warns when it detects this.
- **Hold-out (`--hold-out`).** SWE-bench style: the PR's test files are **hidden**
  from the agent and applied only at grade time, scored by named `FAIL_TO_PASS`
  red→green (+ `PASS_TO_PASS`). Use this when you want to grade against the
  maintainer's exact tests the agent must satisfy blind. Stored as
  `hold_out_tests: true` on the instance.

> **Trust + network.** Validation and the run-time checkout execute the repo's own
> code (`setup_cmd` / `test_cmd` / its tests). Only point this at repos you trust.
> The first run per repo fetches over the network; after that the cache makes it
> offline.

## Prerequisites

- `gh` on PATH and authenticated (`gh auth login`) — used to read PR/issue metadata.
- `git`. Node 24+ (same as the rest of the harness).

## Command

```bash
lastlight-evals add-case --pr <github-pr-url> --code-fix [options]
lastlight-evals add-case --issue <github-issue-url> [options]
```

Options:

| flag | meaning |
|---|---|
| `--pr <url>` | a GitHub PR url (pair with `--code-fix` here, or `--review` for a pr-review case) |
| `--code-fix` | with `--pr` → a **code-fix** (build) case |
| `--issue <url>` | a GitHub issue url → a **triage** case |
| `--tier <name>` | target tier dir (default `code-fix` for `--pr --code-fix`, `triage` for `--issue`) |
| `--id <slug>` | `instance_id` (default derived from repo + number) |
| `--datasets <dir>` | datasets root to write into (a `<tier>/` subdir). Default `./datasets`, else `./evals/datasets` |
| `--overlay <dir>` | write into `<dir>/evals/datasets` instead |
| `--test-cmd "<cmd>"` | test command (default `node --test`); stored as `test_cmd` |
| `--setup-cmd "<cmd>"` | install/build run before tests (e.g. `"npm ci"`); stored as `setup_cmd` |
| `--hold-out` | SWE-bench mode: hold the PR's tests out, grade named `FAIL_TO_PASS` (default is suite mode) |
| `--pass-list` | (hold-out only) enumerate every green test in `PASS_TO_PASS` (default `["*"]`) |
| `--no-validate` | don't run the repo's tests to validate the case (just scaffold) |
| `--dry-run` | print the proposed instance JSON; don't write |

## The recommended flow (CLI extracts → you refine)

1. **Dry-run first.** `add-case --pr <url> --code-fix --dry-run` prints the proposed
   instance. The CLI derives:
   - `repo`, `base_commit` (the **merge-base** of the base branch and the PR head —
     the true fork point, not the base-branch tip), and `head_commit`;
   - gold `patch` — the diff of the non-test files (reference only, never graded);
   - `test_cmd` / `setup_cmd` — the suite command + install step you pass;
   - **suite mode (default):** validation just *probes* the suite — green at head ⇒
     gradeable; green at base ⇒ a no-op would resolve it (a warning to reconsider
     the case or use `--hold-out`). No `test_patch` / `FAIL_TO_PASS` written.
   - **`--hold-out`:** also derives `test_patch` (the PR's **test** files; path
     heuristic `test/`, `tests/`, `__tests__/`, `spec/`, `*.test.*` / `*.spec.*` /
     `*_test.*`), auto-detects `FAIL_TO_PASS` (base+test_patch → red, head → green),
     sets `PASS_TO_PASS: ["*"]` (or `--pass-list`), and `hold_out_tests: true`;
   - `issue` + `problem_statement` (the PR's linked issue if it closes one, else the
     PR title/body) and `expect_github: { pr_opened: { base, head_is_branch } }`.

2. **Review and repair** what the CLI can't get right on its own:
   - **Held-out tests.** If the heuristic mislabeled files (warns "No test files
     detected", or grabbed a non-test), fix `test_patch` by hand, or rely on the
     repo's in-repo tests via `--test-cmd`.
   - **Verdicts.** If validation couldn't run (custom runner, deps), set
     `FAIL_TO_PASS` to the genuinely bug-revealing test name(s). Leave it **empty
     for suite mode** (graded on the test command's exit code) when the runner
     emits no TAP names.
   - **Problem statement.** Tighten it to what the agent should act on — drop PR
     chatter; keep the bug description.
   - **`test_cmd` / `setup_cmd`** for non-`node --test` repos, e.g.
     `--test-cmd "npm test" --setup-cmd "npm ci"`.

3. **Write it.** Re-run without `--dry-run` (add `--datasets <dir>` / `--overlay
   <dir>` to target a specific workspace). The instance is appended to
   `<root>/<tier>/instances.json` (creating `tier.json` if the tier is new).

4. **Verify end-to-end.** Run the case with the cheapest model just to confirm the
   plumbing — the sandbox seeds from the real repo at `base_commit` and grading
   runs the held-out tests:

   ```bash
   EVAL_INSTANCE=<instance_id> lastlight-evals run code-fix --model haiku
   ```

## Test runners & grading

- **`node --test` (default).** Emits TAP; the CLI extracts per-test names and grades
  each `FAIL_TO_PASS` / `PASS_TO_PASS` by name.
- **Any other runner via `--test-cmd`.** If it emits TAP with stable names, named
  grading still works. Most runners can be told to emit TAP — prefer this so you get
  per-test `FAIL_TO_PASS` grading instead of all-or-nothing:
  - **vitest:** `--test-cmd "npx vitest run --reporter=tap"` (vitest 4 emits nested
    TAP the CLI parses; a bare `npm test` uses the default reporter → no names).
  - **mocha:** `--test-cmd "npx mocha --reporter tap"`.
  - **jest:** `--test-cmd "npx jest"` with `jest-tap-reporter` configured, else suite mode.
  Otherwise the case runs in **suite mode**: `FAIL_TO_PASS` stays empty and the case
  is resolved iff the test command exits 0 (after the held-out `test_patch` is
  applied). Use `--setup-cmd` for install/build. The CLI prints which mode it picked.

## Triage from an issue

`add-case --issue <url>` builds a triage case from a **resolved** issue — its
content plus the human triage outcome:

- `problem_statement` + the `issue` seed from the title/body. **Seed labels are
  emptied on purpose** so the agent triages from scratch (the applied labels are
  the gold it must reproduce, not an input).
- `expect_github.labels_added` = the labels that were applied to the issue (read
  from the issue **events** API, so the evidence block also shows *who* applied
  each — maintainer vs bot), and `issue_closed: true` if the issue was closed.
- An **evidence block** prints the applied labels and the reviewer comments
  (author + first line) — the raw signal you turn into the gold decision.

What you refine before running:

- **`triage_gold`** (`{ category, state }`) — assign from the applied labels per
  **the deployment's triage taxonomy** (the CLI can't know which label is the
  category vs the workflow state, so it leaves `triage_gold` empty). `gradeTriage`
  checks these label strings end up on the issue.
- **Prune** any non-triage labels (e.g. `good first issue`) out of `labels_added`.
- **Reviewer comments** — optionally turn a representative one into a
  `comment_matches` regex (asserting the agent's triage comment covers the same
  point), or move a genuinely *pre-triage* maintainer comment into `issue.comments`
  as context the agent should see.

See `instance-schema.md` for the full triage field reference.
