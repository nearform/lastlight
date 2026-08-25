---
name: pr-review
description: Review a GitHub pull request and post one formal review — advance the existing discussion and give precision-first, high-signal feedback. Judgement on the diff, not a build gate — CI validates that it builds, and a targeted probe is allowed as evidence. Use when asked to review a PR or on a cron PR scan.
version: 7.4.0
tags: [github, review, code-quality]
chat: true
---

# PR Review

Review an open PR — high-signal findings only. Read the change and reason about
it; where reasoning cannot settle a question, **run something**. Installing the
repo's dependencies, opening the installed library source, and writing the
smallest file that exercises the behaviour and executing it are all **allowed
and expected** — that is a *probe*, and it is how a question about how code
actually behaves gets settled instead of guessed.

Two limits on a probe, and they are what keep it from becoming a second CI:

- **It must produce evidence you can quote.** Keep the command and its output,
  and cite them in the finding that rests on them. "I ran it and it fails" with
  nothing to quote is worth exactly what a guess is worth.
- **It is targeted at one question, never a re-derivation of CI.** Whether the
  change builds and whether the suite is green are already answered — see §4.
  Never spend a probe on those.

> **Why this is spelled out rather than left implicit.** An earlier version of
> this skill forbade installing dependencies, and the measured failure was not
> disobedience — it was the opposite. The reviewer referred to `WebClient` 32
> times and never once opened `node_modules/@slack`, because the workspace it
> was given had no `node_modules` at all. "Open the library source" was not
> ignored; it was structurally impossible. **An affordance you do not have reads
> to you as an instruction you cannot follow**, so what you *can* run is part of
> the contract, not an implementation detail.

Your job is judgement on the diff, not a build gate. A noisy review gets muted,
so precision matters more than volume.

You do **not** post the review yourself. You write your findings to a JSON file
(`.lastlight/pr-review/findings.json`) and a deterministic follow-up step posts
one formal review, anchoring each finding to its diff line as an inline comment
(§5).

This skill is the PR-specific procedure. It uses the **code-review** skill for
the precision bar and what-to-check rubric.

## Workspace

The harness pre-clones the PR's head ref and drops you **inside the checkout** —
your cwd **is** the repo (`ls -la` shows `.git/` directly; `AGENTS.md` is the
sibling one level up at `../`). Use `git`/`read`/`grep` from here. To refresh:
`git fetch origin <branch> && git reset --hard FETCH_HEAD` — **no `--depth`**,
for the reason in §3. If the checkout is somehow missing,
`git clone https://github.com/{{owner}}/{{repo}}.git .`.

**Every `.lastlight/…` path in this skill and in any prompt is relative to that
cwd — use it relative, never absolute.** The skill files you were handed are
absolute paths under `…/.lastlight-skills/`, and that directory is a sibling of
the checkout, one level ABOVE you. Joining a `.lastlight/…` path onto the
directory your skills came from lands outside the repo and reads nothing. This
is measured, not hypothetical: it cost 23 of 120 survey branches their seeded
obligations across three runs on 2026-08-22.

**Read code from this local checkout, never the API.** Use `git`/`read`/`grep`
on disk for the diff and file contents. Do **not** call
`github_get_pull_request_diff`, `github_list_pull_request_files`, or
`github_get_file_contents` — the API patch is a large redundant payload that
re-bloats context every turn. The `github_*` tools are for *API* operations only
(reading metadata + prior comments in §1–2). You never post the review via a
tool — you write the findings file and the follow-up step posts it.

## Procedure

### 1. Confirm the target

`prNumber` (or `issueNumber`) in the Context block **is your target** — go
straight to `github_get_pull_request` with it. Do **not** call
`github_list_pull_requests` to "find" or "confirm" it; you were handed it, and
listing dumps a large payload for nothing.

**Stop conditions** (check before reviewing):
- PR authored by `last-light[bot]` → skip. Never self-review.
- `merged === true` → stop. This skill reviews open PRs only.
- A `last-light[bot]` review already exists on the **current head SHA** → stop;
  don't post a duplicate. (A re-review is fine once new commits land.)

### 2. Read the prior discussion

A review advances the conversation, don't restart it. Fetch and absorb:
`github_list_pull_request_reviews`, `github_list_issue_comments`,
`github_list_pull_request_review_comments`. Done when you can say: which findings
were already raised (don't repeat them), which threads the author resolved
(treat as done unless the fix is wrong), which are still open (surface those —
higher signal than a fresh nit), and what the humans' review states are.

**Two states change what you're allowed to conclude:**

- A **human APPROVE** lowers the bar for blocking — prefer COMMENT over
  REQUEST_CHANGES on anything non-critical.
- An **open human `CHANGES_REQUESTED`** (their latest review on this PR, not
  dismissed and not replaced by a later APPROVE from the same person) means your
  `event` **must not be `APPROVE`** — use `COMMENT`, or `REQUEST_CHANGES` if you
  have your own blocking finding. Say in the summary which of their points the
  current diff addresses and which it doesn't. A bot APPROVE stacked on top of
  an open human block is the review reading as an override of a person who knows
  the codebase better than you.

### 2b. If you have reviewed this PR before — re-derive, don't assume

You have already reviewed this PR whenever §2 turned up a `last-light[bot]`
review at an earlier SHA. A re-review is **not** "what's new since last time";
it is a fresh verdict on the whole current diff, and the prior findings are its
starting point rather than settled history.

For **every** finding in your previous review, work out which of these it is and
say so in the summary:

- **Fixed** — you re-read the code at `path:line` *as it is now* and the problem
  is genuinely gone. Not "the author replied that they fixed it", not "the
  thread is resolved", not "a commit message says so". Re-read it.
- **Still open** — re-raise it as a finding. A finding that survives a round trip
  is higher signal than anything new you might find, not lower.
- **Pinned by a test** — the change added or edited a test that asserts the
  *current, wrong* behaviour. That is not a fix; it is the bug made permanent.
  Re-raise the original finding and flag the test as its own Critical/Important
  finding, quoting the assertion.
- **Withdrawn** — you now believe the finding was wrong. Name what refuted it.

Only once every prior finding lands in one of those four may you approve.
"Nothing new since the last push" is not a review; if the current diff still
contains a problem you raised, the correct `event` is still
`REQUEST_CHANGES`/`COMMENT`, whoever pushed last.

### 3. Get the diff

**First, check whether it is already staged.** When the review evidence pipeline
is on, the deterministic `facts` phase resolves this range once and writes it
down: `.lastlight/pr-review/diff/index.md` lists every changed file with its
status, its changed line ranges and a per-file patch beside it under
`.lastlight/pr-review/diff/`. If that index is there, read it and the patches
instead of running the commands below — the range is already settled, and every
re-derivation is another chance to spell it two-dot. Those paths are relative to
this checkout; open them exactly as written. (If the index says NOT AVAILABLE, or
there is no `.lastlight/pr-review/diff/` at all, carry on here.)

From inside `<repo>/`:
```
# The harness already materialized origin/<baseRef>, deepening base AND head
# until they share a merge base. Verify that — do NOT re-fetch with --depth.
# Repair only if it's actually missing: deepen BOTH sides, because unshallowing
# the base alone leaves HEAD with no reachable ancestor and merge-base still fails.
git merge-base origin/<baseRef> HEAD >/dev/null 2>&1 || {
  git fetch origin --unshallow || true
  git fetch origin "+refs/heads/<baseRef>:refs/remotes/origin/<baseRef>" --unshallow || true
}

git diff --stat origin/<baseRef>...HEAD    # churn
git diff origin/<baseRef>...HEAD           # the patch
```

**Never `git fetch --depth N` in this checkout.** A depth-limited fetch writes
`.git/shallow` even into an already-complete clone, re-cutting history N commits
back from the base tip — which severs the merge base on any PR that forked
further back than that, and undoes the deepening the harness already paid for.

**Three dots, always.** `origin/<baseRef>...HEAD` is the merge-base diff and
matches GitHub's own PR diff. Two-dot (`git diff origin/<baseRef> HEAD`)
additionally contains every commit the base branch picked up since the PR
forked, and the author wrote none of it — measured across 50 real PRs, 9
diverge, one of them 6125 files against 3.

**If `merge-base` still fails after the repair**, the diff range could not be
established and you have nothing to review. Do not quietly fall back to two-dot
and review that instead. Write `event: "COMMENT"` — never `APPROVE` — with
`findings: []` and a `summary` saying the base and head share no reachable
history, then stop. Reviewing the wrong range and reporting success is the exact
failure this instruction exists to prevent.

### 4. Read what CI said

Your Context block carries `checksState` — `passing` / `failing` / `pending` /
`none` — for this PR's head commit, and when it is `failing`, `ciSection` holds
the actual failure report (job, step, log excerpt). **CI has already run: do not
speculate about whether this builds.**

- `checksState: passing` — the change compiles and the tests pass. Say nothing
  about whether it builds; spend the whole review on judgement.
- `checksState: failing` — `ciSection` is **evidence**, not a finding. Do not
  restate what CI already surfaced (a human sees the red check first). Do use
  it: cite it when it confirms a finding of your own — *"this fails typecheck on
  line 42, which is the same issue as finding 2"* — and let it steer you toward
  the part of the diff that is actually wrong.
- `checksState: pending` / `none` — no CI evidence either way. Review the code
  as written, and do **not** stand in for CI by building it or running the
  suite — a matrix you cannot reproduce on one machine is not yours to guess at.
  A targeted probe for one specific question is still fair game.

### 5. Assess and write your findings

Apply the **code-review** skill's rubric — read each changed file in context;
check correctness / **contracts** / edge-cases / security / regression-risk /
test-coverage.
Reason about the code statically first, and spend nothing re-deriving whether it
builds — CI is the build gate and it has already spoken (§4). When a finding
turns on how the code *behaves* rather than on how it reads — library or
framework semantics, a lifecycle, an option interaction, an input the code does
not expect — settle it with a probe (see the top of this skill) and quote the
transcript in the finding's body.
Follow that skill's **precision-first** rule: keep **only Critical and Important**
findings, each anchored to a `path:line` with a one-line concrete impact (what
breaks, for which input or caller). Drop Suggestions and Nits.

**Do the cross-file pass before you decide anything.** For every unit the diff
changed the *shape* of — return value, field name, enum, event payload, status
code, header, units, nullability, ordering — grep the repo for its consumers and
open them, including ones the diff doesn't touch. Then state both halves:
*producer now emits X; consumer at `path:line` still reads Y*. Same for a rule
that has to hold on more than one side (a limit, an expiry/max-age, an auth
check): a value the client sets and the server never verifies is not enforced.
These mismatches are invisible in the diff — each file reads fine alone — and
they are the findings a human most needs from you.

Before writing anything, run the **confidence gate**: re-read each finding
against the actual code and try to refute it. Dropping one requires naming what
refutes it — the guard, the validating caller, the unreachable type. Being
unsure about a Critical-tier claim means *go read the other side*, not delete it.

A clean PR approved with no findings is a good review — **when it is clean.**
An empty `APPROVE` is you claiming you did the cross-file pass above and found
nothing, so only write one when that is true.

**Do not call `github_create_pull_request_review` (or any review-submitting
tool).** Write your findings to `.lastlight/pr-review/findings.json` instead. A
deterministic follow-up step reads that file and posts one formal review with
your findings as inline comments anchored to the diff. The full contract with
worked examples is in [references/findings-schema.md](references/findings-schema.md);
the shape is:

```json
{
  "skip": false,
  "summary": "One or two sentences on what the PR does + overall assessment.",
  "event": "COMMENT",
  "findings": [
    {
      "path": "src/foo.ts",
      "existingCode": "the verbatim line(s) this finding is about",
      "line": 42,
      "severity": "Critical",
      "title": "Short label for the finding",
      "body": "Concrete impact — what breaks, for which input or caller.",
      "suggestion": "exact replacement text for the anchored line(s)"
    }
  ]
}
```

Write **only these content fields** — `skip?` / `summary` / `event` /
`findings[]`. The follow-up step already knows the PR number, base ref, head
SHA and diff from the harness's own context and the checkout, so you do **not**
record any of that metadata (that reliance was a footgun — omit it).

Rules:
- **Quote the code; do not count the lines.** `existingCode` is the anchor of
  record: copy the line(s) the finding is about character-for-character and the
  harness finds them for you — in the file's own hunks, then the whole file, then
  (on a *unique* match) elsewhere in the diff, which is how a finding filed
  against the wrong half of a declaration/implementation pair still lands. `line`
  and `side` are **advisory hints** that get overwritten; `start_line` is derived,
  so do not set it. `path` should still match the diff path. An excerpt that
  cannot be found is demoted to the summary body — nothing is lost, but an inline
  comment at the defect site is worth much more, so copy carefully rather than
  paraphrasing.
- `severity` is `Critical` or `Important` only.
- `suggestion` is optional — include it only when a concrete one-to-few-line fix
  is obvious. It must be the exact replacement text for the anchored line(s),
  nothing else; GitHub renders it as an applyable suggestion.
- `event` is `APPROVE` / `REQUEST_CHANGES` / `COMMENT`, matching what survived
  the gate. A clean PR is an `APPROVE` with an empty `findings` array and a short
  `summary`. Two hard constraints on it:
  - **Never `APPROVE` over an open human `CHANGES_REQUESTED`** (§2) — downgrade
    to `COMMENT`.
  - **Never `APPROVE` while one of your own prior findings is still open** (§2b)
    — including one the change only "fixed" by adding a test that asserts the
    broken behaviour.
- On a re-review, the `summary` opens with the prior-findings ledger from §2b —
  one line per earlier finding, each marked fixed / still open / pinned by a test
  / withdrawn. That is what makes the second review worth its cost; a re-review
  whose summary is interchangeable with the first one had nothing to say.
- Create the dir and keep the file out of git first:
  `mkdir -p .lastlight/pr-review && echo '.lastlight/' >> .git/info/exclude`.

**Stop / skip:** if a stop condition in §1 holds (bot-authored, merged, already
reviewed at the current head SHA), write `{"skip": true, "summary": "<reason>"}`
and stop — the follow-up step then posts nothing.

## Verification

Confirm `.lastlight/pr-review/findings.json` is valid JSON and every finding
carries `path` + `line`. The first-class `post-review` action then posts the
review — anchoring each finding to its diff line, demoting any off-diff finding
to the body, and logging how many landed inline vs in the body. If the file is
missing after a real review (not a `skip`), that step **fails the run** loudly
rather than posting nothing.
