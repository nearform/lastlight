# security-feedback templates

## Sub-issue body (create-issues)

`github_create_issue` with `title` = the finding's `title` (exactly as parsed, no
prefix/suffix), `labels` = `["security", severity]` (e.g. `["security",
"p0-critical"]`), and this body:

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

## SECURITY.md scaffold (accept-risk / false-positive)

Create this if `SECURITY.md` is missing, then append the row:

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

Appended row (to whichever table matches the intent):

| Column | Value |
|--------|-------|
| Fingerprint | First 16 hex chars of the finding's `fp` |
| Title | Finding's `title` |
| Reason | Extracted reason (text after the first `:`; "no reason given" if absent) |
| Date | Today's date (YYYY-MM-DD, UTC) |
| Issue | `#{parentIssueNumber}` |
