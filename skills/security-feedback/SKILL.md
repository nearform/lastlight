---
name: security-feedback
description: Process a maintainer's comment on a security scan-summary issue — break selected findings out into individual actionable issues, or record accepted risks / false positives in SECURITY.md.
version: 2.0.0
tags: [github, security, feedback]
---

# Security Feedback

A maintainer commented on a `security`-labelled issue — almost always a per-run
**security scan summary** (one issue per scan, a task-list of findings). Based on
the comment, either:

- **Break selected findings into individual issues** (each can later feed `build`). Primary flow.
- **Record a suppression** in `SECURITY.md` (accepted risk / false positive).
- Reply for discussion, or ignore noise.

The parent issue's grammar is the contract defined in
`skills/security-review/references/issue-format.md`. This skill is staged into its
own workspace and **cannot read that file**, so it carries its own copy of the
row/severity regex below — **if you change the grammar, update both in lockstep.**

## Context

- `context.repo` — `owner/name`
- `context.issueNumber` — the security summary issue (parent)
- `context.commentBody` — the triggering comment
- `context.sender` — the commenter's GitHub login

The parent body is not passed — fetch it at step 1.

## 1. Fetch and parse the parent issue

`github_get_issue({ owner, repo, issue_number: issueNumber })`.

**Version check.** The body MUST start with `<!-- lastlight-security-scan-version: 1 -->`.
If the marker is missing or the version isn't `1`, reply: "Unknown scan-summary
format — this skill is at version 1 but the parent reports a different version.
Ask the maintainer to re-run `@last-light security-review`." Do not parse further.

**Parse each finding row** with this canonical regex (all three states):

```
/^- \[([ x])\] <!-- item:(\d+) fp:([0-9a-f]{8,}) --> (?:~~)?\*\*(.+?)\*\* — `([^`]+):(\d+)` \(([a-z][a-z0-9-]*) · `([^`]+)`\)(?:~~ → #(\d+))?$/m
```

Captures: `checkbox` (` `/`x`), `item`, `fp`, `title`, `file`, `line`, `tool`,
`rule`, and `subIssueNumber` (only when already broken out). Derive per row:

| Derived | Definition |
|---------|------------|
| `alreadyBrokenOut` | `subIssueNumber != null` — turned into a sub-issue on a prior run |
| `userTicked` | `checkbox === "x" && !alreadyBrokenOut` — the maintainer ticked the box, selecting it |

`userTicked` is the primary selection signal; `alreadyBrokenOut` rows are never
re-selected regardless of checkbox state.

**Severity** comes from the nearest preceding section header (tolerating a
trailing truncation suffix like `(showing first 7 of 25)`):

```
/^### (🔴|🟠|🟡|🟢) (Critical|High|Medium|Low) \((\d+)\)(?:\s.*)?$/m
```

Map Critical/High/Medium/Low → `p0-critical`/`p1-high`/`p2-medium`/`p3-low`.

**Parse the `<details>` block** after each row (starts `<details><summary>Details</summary>`,
ends `</details>`): the fenced block → `snippet` + `language`; paragraphs between
the fence and `**Suggested fix:**` → `explanation`; text after `**Suggested fix:**`
→ `suggestedFix`.

Store each finding as `{ item, fp, title, file, line, tool, rule, severity,
language, snippet, explanation, suggestedFix, userTicked, alreadyBrokenOut, subIssueNumber? }`.

## 2. Classify the comment intent

Pick the single best-fit bucket:

- **create-issues** — break selected findings out. Signals: bare `@last-light
  create issues` (defaults to ticked), "create issues for…", "make issues for…",
  "break out…", "file sub-issues for…", "create an issue for items 1, 3".
- **accept-risk** — accept a finding's risk. Signals: "accept-risk:", "we know
  about this", "won't fix", "accepted".
- **false-positive** — not real. Signals: "false-positive:", "not a vulnerability",
  "not applicable".
- **reopen** — re-evaluate a suppressed finding. Signals: "reopen", "re-evaluate".
- **discuss** — a question or conversation about the findings.
- **ignore** — noise (thanks, unrelated remark).

`accept-risk` / `false-positive` / `reopen` MUST name a specific finding via
`item N` / `item: N` — fall through to `discuss` if unresolved.

## 3. Act

### create-issues

1. **Resolve the selection** (first match wins):
   - **`ticked` / `checked` / `selected`** → every `userTicked` finding. Preferred UX.
   - **Default (no qualifier)** → treat as `ticked`. If no rows are ticked, reply:
     ```
     No rows are ticked. Tick the checkboxes on the findings you want broken out, then comment again — or use one of:
     - `@last-light create issues for the criticals`
     - `@last-light create issues for items 1, 3, 5`
     - `@last-light create issues for all`
     ```
   - `all` / `every` → every parsed finding regardless of tick state.
   - `criticals` / `the criticals` / `p0-critical` → every `p0-critical` (same for
     highs/mediums/lows). A count in the comment ("5 criticals") is ignored.
   - `items N, M` / `item N` → specific 1-based item numbers from `<!-- item:N -->`.

   In every form, silently drop `alreadyBrokenOut` findings and mention them in the
   summary. If the selection is empty, reply:
   ```
   No findings matched `{selection text}`. This scan has: {nC} critical, {nH} high, {nM} medium, {nL} low. Ticked: {nTicked}. Already broken out: {nDone}.
   ```
   and create nothing. If the form is unrecognised (ambiguous), ask for clarification — don't guess.

2. **For each selected finding**, `github_create_issue` using the sub-issue body
   template in [references/templates.md](references/templates.md). Record each new
   `subIssueNumber` against its `item`.

3. **Rewrite the parent body.** For every finding just broken out, transition its
   row to **broken-out**:
   ```
   - [x] <!-- item:N fp:FP --> ~~**TITLE** — `FILE:LINE` (TOOL · `RULE`)~~ → #SUBISSUE
   ```
   (checkbox `[x]`, title+location wrapped in `~~…~~`, ` → #SUBISSUE` appended).
   Match by `item:N`. Do **not** touch rows that weren't selected, even if ticked.
   Preserve all other content byte-for-byte. `github_update_issue`.

4. **Post a summary comment** on the parent:
   ```
   Created {N} sub-issue(s) at @{sender}'s request:

   - #{subN1} — {title 1} (item {item1})
   …

   {if any skipped}: Skipped {M} item(s) already broken out: items {list}.

   Comment `@last-light build` on any sub-issue to start a fix.
   ```

### accept-risk / false-positive

1. Resolve the target by `item N`; fall through to `discuss` if absent/unknown.
2. Extract the reason (text after the first `:`, trimmed; "no reason given" if absent).
3. `github_clone_repo`. Read `SECURITY.md`; create from the scaffold in
   [references/templates.md](references/templates.md) if missing.
4. Append a row to the matching table (accepted risks OR false positives) per the
   template.
5. Commit on branch `security/feedback-{parentIssueNumber}-{shortFingerprint}`,
   push, and open a PR titled `security: record {accept-risk|false-positive} for {shortFingerprint}`.
6. Comment on the parent: `Opened PR #{prNumber} to record this in SECURITY.md.
   Once merged, this finding will be suppressed in future scans.`
7. Do **not** tick the task-list checkbox — that marker is reserved for "broken out to sub-issue".

### reopen

Reply: "To re-evaluate this finding, run `@last-light security-review` — the next
scan re-picks it up if `SECURITY.md` has been updated." Do not modify `SECURITY.md`.

### discuss

Reply conversationally using the finding's `<details>` block (risk, tool, suggested
fix). Don't modify `SECURITY.md` or create sub-issues.

### ignore

Take no action.

## Tool usage

GitHub operations via `github_*` MCP tools only — never `gh` CLI, `curl`, or raw HTTP.
