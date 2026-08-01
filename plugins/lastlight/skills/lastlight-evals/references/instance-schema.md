# Eval instance schema & authoring cases

An eval case is a **`SweBenchInstance`** — SWE-bench-compatible core fields plus
Last Light extensions (the GitHub fixtures + behavioral expectations that let the
harness drive and grade the real workflow against a mocked GitHub).

Datasets are discovered from (overlay > user > built-in): `<overlay>/evals/datasets/`,
`--datasets <dir>` / `LASTLIGHT_EVALS_DATASETS`, and the package's built-in
`datasets/`. A tier is a directory with a `tier.json` and an `instances.json`.

## `tier.json`

```json
{ "name": "triage", "defaultWorkflow": "issue-triage", "description": "..." }
```

## `SweBenchInstance` fields

```jsonc
{
  // ── SWE-bench core ──
  "instance_id": "triage__my-case",      // unique id
  "repo": "owner/repo",                   // logical; fixture origin is a local bare repo
  "base_commit": "0000000...",            // code-fix. UNUSED for vendored fixtures
                                           // (harness synthesizes one); for a
                                           // git-source case it's the real SHA
                                           // checked out at run time.
  "problem_statement": "short issue text",
  "patch": "...",                          // gold patch — reference only, NOT graded
  "test_patch": "...",                     // held-out tests (code-fix), git-apply form
  "hold_out_tests": true,                 // opt into SWE-bench held-out grading (default: suite mode)
  "FAIL_TO_PASS": ["test id 1"],          // hold-out only: must go red→green. Empty ⇒ suite mode
  "PASS_TO_PASS": ["*"],                  // hold-out only: must stay green; ["*"] = whole suite
  "test_cmd": ["npm", "test"],            // held-out test argv (default: node --test)
  "setup_cmd": ["npm", "ci"],             // optional install/build before tests (git-source)
  "head_commit": "abc123...",             // PR head SHA — reference/authoring only

  // ── Last Light extensions ──
  "workflow": "issue-triage",             // optional; defaults to the tier's defaultWorkflow
  "issue": {                               // seed state for the fake GitHub
    "number": 110, "title": "...", "body": "...",
    "labels": [], "user": "alice",
    "comments": [{ "user": "bob", "body": "..." }],
    "state": "open"
  },
  "triage_gold": { "category": "bug", "state": "ready-for-agent" },  // triage grading
  "pr": {                                  // pr-review: the PR fixture (base/head refs + SHAs)
    "number": 37429, "title": "...", "body": "...",
    "base_ref": "main", "head_ref": "feature-x",
    "base_commit": "f3c8e8f...", "head_commit": "02f48f7...",
    "user": "author"                       // do NOT put the human review here — see below
  },
  "review_gold": [                          // pr-review: the held-out judge gold
    { "file": "src/x.ts", "line": 42, "severity": "high", "description": "..." },
    { "severity": "medium", "description": "..." }   // file/line optional (judge matches on substance)
  ],
  "expect_github": {                       // behavioral assertions on recorded GitHub calls
    "labels_added": ["bug"],
    "labels_absent": ["wontfix"],
    "issue_closed": false,
    "comment_matches": "(?i)thanks",
    "pr_opened": { "base": "main", "head_is_branch": true, "title_matches": "(?i)fix" },
    "pr_merged": false,                    // dependency-merge: merged outright?
    "auto_merge_enabled": true,            // …or the CI-gated route (a different decision)
    "review_submitted": {}                 // pr-review: proxy check that a review was posted
  },

  // ── PR-scoped workflows (fix / dependency-merge) ──
  "pr_state": {                            // the snapshot a dispatch would have resolved
    "head_sha": "a41f0c8",
    "checks_state": "failing",             // passing | failing | pending | none
    "settled_check_count": 1,
    "base_checks_state": "passing",        // the fact that separates "this PR broke it"
    "attempt": 3,                          // drives "{{attempt}} of {{maxAttempts}}"
    "flaky_deferrals": 2,                  // 2 ⇒ {{flakyPromoted}} is true
    "prior_attempts": ["DIAGNOSIS_COMPLETE: … class=flaky …"],
    "notes": [{ "kind": "ruled-out", "text": "not the lockfile" }],
    "ci_jobs": [                            // feeds BOTH {{ciSection}} and the Actions tools
      { "name": "CI / test", "log_excerpt": "…", "failing_step": "npm test" }
    ],
    "fix": { "maxAttempts": 2 },            // overrides on the policy blocks; rest = shipped defaults
    "dependencies": { "autoMergeMaxImpact": "low" }
  },
  "expect_markers": {                      // the marker line the run signed off with
    "diagnosis_class": "reproducible",     // or diagnosis_class_any_of: [...]
    "fix_outcome": "pushed", "fix_gate": "green",
    "assessment_impact": "high", "assessment_action_any_of": ["comment"]
  }
}
```

Every `expect_github` field is optional — only the present ones are checked.

**`pr_state` is not optional in practice for a PR-scoped workflow.** In production
those workflows are *dispatched*, and everything their prompts reason with —
`{{ciSection}}`, `{{attempt}}`, `{{mayMerge}}`, `{{priorNotes}}` — is
`renderContext`'s projection of that snapshot. The harness hands your seed to
core's own projection; a case without one runs the workflow with every `{{#if}}`
guard on the empty branch, which is not a smaller version of production but a
different one.

## Add a triage case

Append a `SweBenchInstance` to `datasets/triage/instances.json` with `issue`,
`triage_gold`, and the `expect_github` assertions (e.g. `labels_added`). That's
it — triage is graded on the triage decision + GitHub mutations.

## Two flavors of code-fix case

A code-fix instance gets its repo from **one of two** provenances; the rest of the
machinery (grading, dashboard) is identical.

**A. Vendored fixture** (three things, keyed by `instance_id`):

1. **`datasets/code-fix/instances.json`** — append the instance with
   `FAIL_TO_PASS`, `PASS_TO_PASS`, `issue`, and `expect_github` (e.g. `pr_opened`).
2. **`datasets/code-fix/repos/<instance_id>/`** — the fixture repo at the base
   commit (the buggy code *before* the fix; no held-out tests here).
3. **`datasets/code-fix/tests/<instance_id>/`** — the held-out test files, copied
   into the repo at grade time and run to compute `FAIL_TO_PASS` / `PASS_TO_PASS`.

**B. Git-source (from a real PR)** — set `repo` + a real `base_commit` and a
`test_patch`; **no** `repos/<id>/` is vendored. At run time the harness clones the
repo into the gitignored `./.eval-cache/` and checks out `base_commit`. Don't
hand-build these — use `lastlight-evals add-case --pr <url>` (see
**`authoring-from-pr.md`**), which fills `base_commit`, `head_commit`,
`test_patch`, and the verdicts for you.

## Add a pr-review case

A pr-review instance has a **`pr`** fixture + a **`review_gold`** set and
`workflow: "pr-review"`. The `pr` fixture drives both the mocked PR endpoints and
the workspace checkout: at run time the harness checks out the PR **head**, and
the review workflow diffs `base..head`. `review_gold` is the held-out gold the
posted review is scored against by an LLM judge (each entry: `severity` ∈
`low`|`medium`|`high`|`critical` + `description`; `file`/`line` optional — the
judge matches on substance). Set `expect_github.review_submitted: {}` (a cheap
proxy that a review was posted).

> **Never** put the human/gold review in `pr.reviews` / `pr.review_comments` —
> those seed the mocked GitHub the agent can read, spoiling the case. The gold
> lives only in `review_gold`.

Don't hand-build these — use `lastlight-evals add-case --pr <url> --review` (see
**`authoring-pr-review.md`**), which pins the `pr` fixture and seeds a candidate
`review_gold` from the PR's human review for you to curate. Or bulk-import the
Martian Code Review Bench with `npx tsx scripts/import-martian.ts`.

## Add a fix / dependency-merge case

Give the case a `pr` seed, a `pr_state` block and an `expect_markers` verdict. For a
`fix` case that also needs a checkout, `repos/<id>/` is the tree at the **base**
commit and `repos-head/<id>/` is the PR's own commit applied on the branch — both
are needed, or base and head are identical and a diagnosing agent correctly
answers that `main` is broken too, turning every red-dependency case into
`upstream-broken`.

Calibrate the expectation against the **shipped skill**, not intuition:
`skills/fixing/SKILL.md` defines the five diagnosis classes (a network blip is
`flaky`, not `infra-dependent`), and `skills/dependency-impact/SKILL.md` gives
`low` to any dev-only dependency. When a case and the skill disagree, the skill
wins — otherwise the eval measures the fixture author.

## Add a custom tier

Create `datasets/<tier-name>/` with `tier.json` (`name`, `defaultWorkflow`,
`description`) + `instances.json`. For code-fix-style tiers also add `repos/<id>/`
and `tests/<id>/`. Discovery auto-finds it — no code change. Run it with
`lastlight-evals run <tier-name> --overlay .`.

## Grading (how a case passes)

- **Behavioral:** did the workflow take the expected GitHub actions
  (`expect_github`)?
- **Markers (fix / dependency-merge):** did the run sign off with the verdict the
  case expects (`expect_markers`)? For those tiers this is the primary signal —
  a diagnosis that reaches the wrong class misroutes the whole retry loop while
  touching no GitHub state, so behavioral grading alone would score it green.
  Parsed with core's own marker parsers, so a bare mention of a tag never counts.
- **Triage:** did the decision match `triage_gold`?
- **Review (pr-review):** an LLM judge matches the posted review's findings against
  `review_gold` → **precision / recall / F-beta** (β via `EVAL_F_BETA` or
  `--f-beta`; default F1). Needs a judge model (`EVAL_JUDGE_MODEL`, else a strong
  default per provider key); independent of the model under test. The judge trace
  is inspectable in the dashboard.
- **Execution (code-fix)** — two modes:
  - **Suite (default).** Nothing held out: run the repo's own `test_cmd` against the
    agent's final tree, **resolved iff it exits 0**. Grades "did the agent leave the
    repo with a passing suite?" The captured output (setup log + TAP) is saved per
    case and shown in the dashboard's **tests** view, for resolved and unresolved
    cases alike.
  - **Hold-out (`hold_out_tests: true`).** SWE-bench style: the maintainer's
    `test_patch` is hidden from the agent and applied only at grade time; resolved
    iff all `FAIL_TO_PASS` go green AND all `PASS_TO_PASS` stay green. `PASS_TO_PASS:
    ["*"]` is a wildcard meaning "the whole suite must stay green" (robust to tests
    being renamed/added; `--pass-list` to enumerate). If the runner emits no TAP
    names, hold-out also falls back to exit-code grading.
- With `--runs N` (N>1) the binary verdict is **worst-case** (passes only if every
  trial passed); the scorecard also shows per-verdict pass counts to expose
  variance.
