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
    "review_submitted": {}                 // pr-review: proxy check that a review was posted
  }
}
```

Every `expect_github` field is optional — only the present ones are checked.

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

## Add a custom tier

Create `datasets/<tier-name>/` with `tier.json` (`name`, `defaultWorkflow`,
`description`) + `instances.json`. For code-fix-style tiers also add `repos/<id>/`
and `tests/<id>/`. Discovery auto-finds it — no code change. Run it with
`lastlight-evals run <tier-name> --overlay .`.

## Grading (how a case passes)

- **Behavioral:** did the workflow take the expected GitHub actions
  (`expect_github`)?
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
