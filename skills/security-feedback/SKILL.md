---
name: security-feedback
description: Process a maintainer's comment on a security-labelled scan-summary issue — either break selected findings out into individual actionable issues or suppress accepted risks.
---

# Security Feedback Skill

Process a maintainer's comment on a `security`-labelled issue. The triggering issue is almost always a per-run **security scan summary** (one issue per scan, containing a task-list of findings). Based on the comment intent, either:

- **Break out selected findings into individual issues** (so each can later be fed to the `build` skill). This is the primary flow.
- Update `SECURITY.md` to suppress accepted risks / false positives.
- Reply conversationally for discussion / ignore noise.

The parent issue's structure is defined in `skills/security-review/SKILL.md § Issue format`. **If you change the grammar here, update that file in lockstep.**

## Context

- `context.repo` — `owner/name`
- `context.issueNumber` — the security summary issue number (parent)
- `context.commentBody` — the triggering comment text
- `context.sender` — GitHub login of the commenter

The parent issue's body is NOT passed directly — fetch it via `github_get_issue` at step 1.

## Procedure

### 1. Fetch and parse the parent issue

Call `github_get_issue({ owner, repo, issue_number: issueNumber })` to retrieve the parent issue body.

**Version check.** The body MUST start with:

```
<!-- lastlight-security-scan-version: 1 -->
```

If this marker is missing or the version is anything other than `1`, reply: "Unknown scan-summary format — this skill is at version 1, but the parent issue reports a different version. Ask the maintainer to re-run `@last-light security-review` to regenerate." Do not attempt to parse further.

**Parse each finding row** using this canonical regex (from `§ Issue format`, covers all three row states):

```
/^- \[([ x])\] <!-- item:(\d+) fp:([0-9a-f]{8,}) --> (?:~~)?\*\*(.+?)\*\* — `([^`]+):(\d+)` \(([a-z][a-z0-9-]*) · `([^`]+)`\)(?:~~ → #(\d+))?$/m
```

Captures, in order: `checkbox` (` ` or `x`), `item`, `fp`, `title`, `file`, `line`, `tool`, `rule`, and (when already broken out) `subIssueNumber`.

Derive two booleans per row:

| Derived | Definition |
|---------|------------|
| `alreadyBrokenOut` | `subIssueNumber != null` — the row has been turned into a sub-issue on a prior run |
| `userTicked` | `checkbox === "x" && !alreadyBrokenOut` — the maintainer clicked the checkbox in GitHub's UI, selecting this finding |

`userTicked` is the primary selection signal; `alreadyBrokenOut` rows are never re-selected regardless of checkbox state.

**Determine severity** from the nearest preceding `### 🔴 Critical (n)` / `### 🟠 High (n)` / `### 🟡 Medium (n)` / `### 🟢 Low (n)` header. Medium and Low headers may carry an optional truncation suffix (e.g. `### 🟡 Medium (25) (showing first 7 of 25)`) when the security-review cap kicks in — the regex tolerates anything that follows `(\d+)` on the same line so the trailing suffix doesn't cause severity assignment to fail silently:

```
/^### (🔴|🟠|🟡|🟢) (Critical|High|Medium|Low) \((\d+)\)(?:\s.*)?$/m
```

Map to internal severity labels:

| Header text | Label |
|-------------|-------|
| Critical | `p0-critical` |
| High | `p1-high` |
| Medium | `p2-medium` |
| Low | `p3-low` |

**Parse the `<details>` block** for each finding (starts with `<details><summary>Details</summary>` on the line after the task-list row, ends with `</details>`). Extract:
- The fenced code block (language tag + body) → `snippet`, `language`
- The paragraphs between the fence and `**Suggested fix:**` → `explanation`
- The text after `**Suggested fix:**` up to `</details>` → `suggestedFix`

Store every finding as:

```
{
  item, fp, title, file, line, tool, rule, severity,
  language, snippet, explanation, suggestedFix,
  userTicked: bool,
  alreadyBrokenOut: bool,
  subIssueNumber?: number,
}
```

### 2. Classify the comment intent

Pick the single best-fit bucket:

- **create-issues** — break selected findings out into individual issues. Signals: bare `@last-light create issues` (defaults to ticked rows), "create issues for ticked", "create issues for…", "make issues for…", "file sub-issues for…", "break out…", "let's create issues for the N criticals", "create an issue for items 1, 3".
- **accept-risk** — maintainer accepts the risk of a specific finding. Signals: "accept-risk:", "we know about this", "won't fix", "accepted".
- **false-positive** — finding is not real. Signals: "false-positive:", "not a vulnerability", "not applicable".
- **reopen** — previously suppressed finding should be re-evaluated. Signals: "reopen", "re-evaluate".
- **discuss** — question or conversation about the findings.
- **ignore** — noise (thank-you, unrelated remark).

`accept-risk` / `false-positive` / `reopen` MUST identify a specific finding via `item N` or `item: N` in the comment — fall through to `discuss` if unresolved.

### 3. Act on classification

#### create-issues

1. **Resolve the selection** from the comment text. Supported forms, applied in this order (first match wins):

   - **`ticked` / `checked` / `selected`** → every finding where `userTicked === true`. This is the preferred UX: maintainer clicks checkboxes in the GitHub issue view, then comments.
   - **Default (no qualifier)** — when the comment is bare `@last-light create issues` with no scope word, treat it as `ticked`. If no rows are ticked, reply:

     ```
     No rows are ticked. Tick the checkboxes on the findings you want broken out, then comment again — or use one of:
     - `@last-light create issues for the criticals`
     - `@last-light create issues for items 1, 3, 5`
     - `@last-light create issues for all`
     ```
   - `all` / `every` → every finding in the parsed list (regardless of tick state).
   - `criticals` / `the criticals` / `p0-critical` → every `p0-critical` finding. Same for `highs`/`p1-high`, `mediums`/`p2-medium`, `lows`/`p3-low`. The count in the comment ("5 criticals") is ignored; "criticals" means all of them.
   - `items N, M, K` / `items: N, M` / `item N` — specific item numbers from the `<!-- item:N -->` markers. Comma- or space-separated. 1-based.

   In every form, silently drop findings with `alreadyBrokenOut === true` from the selection and mention them in the summary comment.

   If the parsed selection is empty (e.g. "criticals" with zero `p0-critical` findings, or "items 99" with no matching item), reply:

   ```
   No findings matched `{selection text}`. This scan has: {nC} critical, {nH} high, {nM} medium, {nL} low. Ticked: {nTicked}. Already broken out: {nDone}.
   ```

   Do not create anything.

   If the selection is ambiguous (no supported form matched), reply asking for clarification. Do not guess.

2. **For each selected finding**, call `github_create_issue` with:
   - `title`: the finding's `title` (use exactly as parsed — no prefix/suffix)
   - `labels`: `["security", severity]` (e.g. `["security", "p0-critical"]`)
   - `body`: the sub-issue body template below

   Sub-issue body template:

   ````markdown
   <!-- fp:{fingerprint} -->
   <!-- parent-security-scan: #{parentIssueNumber} -->

   Broken out from security scan #{parentIssueNumber} on {today's date} at @{sender}'s request.

   **File**: `{file}:{line}`
   **Tool**: {tool} · `{rule}`
   **Severity**: {severity}

   ```{language}
   {snippet}
   ```

   {explanation}

   ## Suggested fix

   {suggestedFix}

   ---

   _To build a fix for this finding, comment `@last-light build` on this issue._
   ````

   Record each new `subIssueNumber` paired with its `item` number.

3. **Rewrite the parent issue body.** For every finding that was just broken out, transition its row to the **broken-out** state. The row may have been either `[ ]` (unticked when selected via severity/items/all) or `[x]` (user-ticked) before — in both cases the new row is:

   ```
   - [x] <!-- item:N fp:FP --> ~~**TITLE** — `FILE:LINE` (TOOL · `RULE`)~~ → #SUBISSUE
   ```

   i.e. checkbox = `[x]`, title+location wrapped in `~~…~~`, ` → #SUBISSUE` appended. Match the existing row by `item:N` (the fingerprint is also suitable as a secondary key). Do **not** touch rows that weren't in the selection, even if they're ticked — leave user ticks as they were. Preserve all other content (summary table, other findings, `<details>` blocks) byte-for-byte. Call `github_update_issue({ owner, repo, issue_number: parentIssueNumber, body: newBody })`.

4. **Post a summary comment** on the parent issue:

   ```
   Created {N} sub-issue(s) at @{sender}'s request:

   - #{subN1} — {title 1} (item {item1})
   - #{subN2} — {title 2} (item {item2})
   …

   {if any skipped}: Skipped {M} item(s) that were already broken out: items {list}.

   Comment `@last-light build` on any sub-issue to start a fix.
   ```

#### accept-risk / false-positive

1. Resolve the target finding by `item N` reference in the comment. If the item doesn't exist or no number is given, fall through to `discuss`.
2. Extract the reason: everything after the first `:` in the comment, trimmed. Fall back to `"no reason given"` when absent.
3. Clone the repo via `github_clone_repo`.
4. Read `SECURITY.md`; create it from the template in § SECURITY.md template if missing.
5. Append a row to the matching table (accepted risks OR false positives):

   | Column | Value |
   |--------|-------|
   | Fingerprint | First 16 hex chars of the finding's `fp` |
   | Title | Finding's `title` |
   | Reason | Extracted reason |
   | Date | Today's date (YYYY-MM-DD, UTC) |
   | Issue | `#{parentIssueNumber}` |

6. Commit on a new branch `security/feedback-{parentIssueNumber}-{shortFingerprint}`.
7. Push and open a PR titled `security: record {accept-risk|false-positive} for {shortFingerprint}`.
8. Comment on the parent issue: `Opened PR #{prNumber} to record this in SECURITY.md. Once merged, this finding will be suppressed in future scans.`
9. Do **not** tick the task-list checkbox — that marker is reserved for "broken out to sub-issue".

#### reopen

Reply: "To re-evaluate this finding, run `@last-light security-review` on the repo — the next scan will re-pick it up if `SECURITY.md` has been updated." Do not modify `SECURITY.md`.

#### discuss

Reply conversationally: use the `<details>` block from the parent issue to explain the finding (risk, tool, suggested fix). Do not modify `SECURITY.md` or create sub-issues.

#### ignore

Take no action.

## § SECURITY.md template

```markdown
# SECURITY.md

This file configures the Last Light security scanner for this repository.

## Tool configuration

| Tool | Severity floor |
|------|---------------|
| npm-audit | medium |
| semgrep | medium |
| gitleaks | high |
| claude | medium |

## Accepted risks

Findings in this table are known risks the maintainers have explicitly accepted.
The scanner will not re-file issues for these findings.

| Fingerprint | Title | Reason | Date | Issue |
|-------------|-------|--------|------|-------|

## False positives

Findings in this table have been classified as not real security issues.
The scanner will not re-file issues for these findings.

| Fingerprint | Title | Reason | Date | Issue |
|-------------|-------|--------|------|-------|
```
