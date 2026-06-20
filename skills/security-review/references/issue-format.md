# § Issue format

This is the **contract** between `security-review` (producer) and
`security-feedback` (consumer). Every rule here is machine-parsed; do not
deviate. `security-feedback` is staged into a separate workspace and cannot read
this file, so it keeps its own copy of the row/severity grammar — **if you change
the grammar here, update `skills/security-feedback/SKILL.md` in lockstep.**

## Title

```
Security scan — YYYY-MM-DD
```

- Exactly one em-dash (` — `, U+2014), surrounded by single spaces.
- Date is the scan's UTC date in ISO form.
- Same-day re-scans produce a second issue with the same title. GitHub disambiguates by issue number; the scanner never edits a prior-run issue.

## Body

The body is assembled from eight blocks, in this exact order, separated by blank lines:

```
{header comments}

{intro paragraph}

{how-to-respond section}

{summary table}

{suppression note}

{scope note}

{overflow note — omitted when overflow == 0}

{findings sections}
```

### Block 1 — header comments

Three HTML comments, each on its own line, in this exact order:

```
<!-- lastlight-security-scan-version: 1 -->
<!-- lastlight-security-scan-date: YYYY-MM-DD -->
<!-- lastlight-security-scan-ts: YYYY-MM-DDTHH:MM:SSZ -->
```

- `version` is a format version. Bump if the structure changes incompatibly — `security-feedback` will check this and refuse to parse unknown versions.
- `date` matches the title.
- `ts` is an ISO-8601 UTC timestamp with second precision (no milliseconds).

### Block 2 — intro paragraph

Exactly one paragraph, with the commit count and short-SHA range substituted:

```
Reviewing {N} commits since {priorScanDate} ({firstShortSha}..{lastShortSha}). Findings here focus on SDLC and workflow changes — Dependabot, GitHub Code Scanning, and Renovate handle the rest. Tick the box once the underlying issue is resolved or recorded in `SECURITY.md`.
```

`{N}` is the size of `commitsReviewed`. `{priorScanDate}` is the YYYY-MM-DD of the prior scan (or the bootstrap floor). When `N == 1`, both short SHAs are the same — render as `({onlyShortSha})` rather than `({sha}..{sha})`.

### Block 3 — how-to-respond section

Verbatim, including the heading:

```
## How to respond

**Preferred flow** — tick the boxes on the findings you want broken out, then comment:

- `@last-light create issues` — files one issue per **ticked** finding (default)

**Other shortcuts:**

- `@last-light create issues for the criticals` — every Critical finding (ticked or not)
- `@last-light create issues for the highs` — same, for High
- `@last-light create issues for items 1, 3, 5` — specific items by number (1-based, top to bottom)
- `@last-light create issues for all` — every finding in this scan
- `@last-light accept-risk for item N: <reason>` — suppress this finding in future scans
- `@last-light false-positive for item N: <reason>` — suppress this finding in future scans
- Comment freely to ask questions or discuss
```

(Item positions in commands map to the `item:N` HTML-comment markers defined below. Ticking a box in GitHub's UI rewrites the row from `[ ]` to `[x]` — the feedback skill treats that as your selection.)

### Block 4 — summary table

Verbatim header, with numbers substituted. Always include all four severity rows, even when the count is 0.

`{nC}`, `{nH}`, `{nM}`, `{nL}` and `{nTotal}` are **TRUE counts** (post-filtering, pre-cap) — i.e. how many findings of each severity actually survived the SECURITY.md filtering, regardless of whether each individual row is listed below the cap. The same numbers appear in the `### 🔴 Critical ({nC})` etc. section headers. The overflow note (Block 6) communicates how many of those counts were truncated from the listed rows.

```
## Summary

| Severity | Count |
|----------|------:|
| Critical | {nC} |
| High     | {nH} |
| Medium   | {nM} |
| Low      | {nL} |
| **Total**| **{nTotal}** |
```

### Block 5 — suppression note

A single line:

```
Suppressed by `SECURITY.md`: {nSuppressed} (accepted: {nA}, false-positives: {nFP}). Below severity floor: {nFloor}.
```

Set each count to 0 when N/A. Emit the line unconditionally so the structure is stable.

### Block 6 — scope note

Always emit, immediately after the suppression note. Lists the human (non-bot) commits actually reviewed, so a maintainer can see what diff produced these findings:

```
> Commits reviewed: {short-sha-1} {subject-1}, {short-sha-2} {subject-2}, …
```

Cap at 10 entries; if there are more, append ` +{N} more` after the last item. Subjects are truncated to 60 chars with `…` if longer. Renovate/Dependabot commits are filtered out at § 1.5 and never appear here.

### Block 7 — overflow note

Emit **only** when `overflow > 0`:

```
> **Note** — {overflow} lower-severity findings are not listed here. The cap is: ALL critical and high, plus the first 10 medium/low (after sort). Tighten `SECURITY.md` severity floors or break out items from this scan, then re-run to surface the rest.
```

### Block 8 — findings sections

Four sections, in this **exact order** (Critical → High → Medium → Low). Always emit all four headers, even when a section has zero findings — the feedback skill relies on stable anchors.

The header counts (`{nC}` etc.) are the **true** post-filter counts, identical to those in Block 4's summary table. The rows listed under each header are subject to the § 7 cap: critical and high are always complete; medium + low are truncated to the first 10 combined. When a section is partially listed, append `(showing first N of {nM})` after the marker — see the per-section header rule below.

```
## Findings

### 🔴 Critical ({nC})

{rows or "_No findings._"}

### 🟠 High ({nH})

{rows or "_No findings._"}

### 🟡 Medium ({nM}){if truncated: " (showing first {kM} of {nM})"}

{rows or "_No findings._"}

### 🟢 Low ({nL}){if truncated: " (showing first {kL} of {nL})"}

{rows or "_No findings._"}
```

Where `kM` and `kL` are the actual rows listed in this issue (sum of the two ≤ 10). When `kM == nM` or `kL == nL` (no truncation in that section), omit the parenthetical.

### Finding-row grammar

Every finding is exactly two lines: a task-list row, then a `<details>` block (one blank line between rows within a section).

The task-list row is **one physical line** with this exact shape:

```
- [ ] <!-- item:N fp:FINGERPRINT --> **TITLE** — `FILE:LINE` (TOOL · `RULE`)
```

Matched by this canonical regex (multiline, case-sensitive) — covers all three row states:

```
/^- \[([ x])\] <!-- item:(\d+) fp:([0-9a-f]{8,}) --> (?:~~)?\*\*(.+?)\*\* — `([^`]+):(\d+)` \(([a-z][a-z0-9-]*) · `([^`]+)`\)(?:~~ → #(\d+))?$/m
```

Capture groups, in order:

1. `checkbox` — `" "` (unticked) or `"x"` (ticked or broken-out)
2. `itemNumber` (1-based across all severities)
3. `fingerprint` (lowercase hex, ≥ 8 chars)
4. `title` (plain text; no backticks, no asterisks)
5. `file` (no backticks, forward-slash path)
6. `line` (integer; use `0` when not line-scoped)
7. `tool` (lowercase, hyphenated — e.g. `npm-audit`, `semgrep`, `gitleaks`, `claude`)
8. `rule` (the tool's native rule id; may contain dots, hyphens)
9. `subIssueNumber` — present **only** when the row has been broken out to a sub-issue; `undefined` otherwise

Derived state (the feedback skill computes these from the captures):

| State | Written as | `checkbox` | `subIssueNumber` |
|-------|------------|------------|------------------|
| **pending** | `- [ ] <!-- item:N fp:FP --> **TITLE** — …` | `" "` | `undefined` |
| **user-ticked** (maintainer clicked the box in GitHub's UI) | `- [x] <!-- item:N fp:FP --> **TITLE** — …` | `"x"` | `undefined` |
| **broken-out** (feedback skill created a sub-issue) | `- [x] <!-- item:N fp:FP --> ~~**TITLE** — …~~ → #SUBISSUE` | `"x"` | the sub-issue number |

Rules:

- `alreadyBrokenOut` ≡ `subIssueNumber != null`. Broken-out rows are immutable — the feedback skill never re-opens them, never touches their checkbox, never re-creates sub-issues from them.
- `userTicked` ≡ `checkbox === "x" && subIssueNumber == null`. These are the candidates the default `@last-light create issues` command selects.
- When creating sub-issues from ticked rows, the feedback skill transitions each row from **user-ticked** → **broken-out** by wrapping the visible text in `~~…~~` and appending ` → #{subIssueNumber}`. The checkbox stays `[x]`; the strikethrough + link is the canonical broken-out marker.
- Un-ticking (moving a user-ticked row back to `[ ]`) is fine — the row just becomes pending again. The scanner doesn't police this.

The per-finding detail block follows immediately on the next line:

````
<details><summary>Details</summary>

```{LANGUAGE}
{SNIPPET}
```

{EXPLANATION}

**Suggested fix:** {SUGGESTED_FIX}

</details>
````

Rules:
- `LANGUAGE` is the fenced-code language tag; empty string when unknown.
- `SNIPPET` is the code excerpt; no surrounding fences, no trailing blank line inside the fence.
- `EXPLANATION` and `SUGGESTED_FIX` are markdown strings; they may contain their own fenced code blocks and line breaks.
- The `<details>` block ends with `</details>` on its own line.

## Worked example

A scan with 1 critical + 1 high finding renders like:

````markdown
<!-- lastlight-security-scan-version: 1 -->
<!-- lastlight-security-scan-date: 2026-04-21 -->
<!-- lastlight-security-scan-ts: 2026-04-21T10:00:00Z -->

Reviewing 3 commits since 2026-04-14 (a1b2c3d..f9e8d7c). Findings here focus on SDLC and workflow changes — Dependabot, GitHub Code Scanning, and Renovate handle the rest. Tick the box once the underlying issue is resolved or recorded in `SECURITY.md`.

## How to respond

- `@last-light create issues for the criticals` — file individual issues for every Critical finding
- `@last-light create issues for the highs` — same, for High
- `@last-light create issues for items 1, 3, 5` — file issues for specific items by number (1-based, top to bottom)
- `@last-light create issues for all` — every finding in this scan
- `@last-light accept-risk for item N: <reason>` — suppress this finding in future scans
- `@last-light false-positive for item N: <reason>` — suppress this finding in future scans
- Comment freely to ask questions or discuss

## Summary

| Severity | Count |
|----------|------:|
| Critical | 1 |
| High     | 1 |
| Medium   | 0 |
| Low      | 0 |
| **Total**| **2** |

Suppressed by `SECURITY.md`: 0 (accepted: 0, false-positives: 0). Below severity floor: 0.

> Commits reviewed: a1b2c3d wire user-supplied repo into git clone, e5f6a7b add admin shell endpoint, f9e8d7c rotate webhook secret

## Findings

### 🔴 Critical (1)

- [ ] <!-- item:1 fp:abc123def4567890 --> **Command injection in git clone** — `mcp-github-app/src/index.js:42` (semgrep · `javascript.lang.security.exec-shell-command`)
<details><summary>Details</summary>

```javascript
execSync(`git clone ${userInput}`)
```

`userInput` originates from an HTTP request and is concatenated directly into a shell command, allowing arbitrary command execution.

**Suggested fix:** use `execFileSync('git', ['clone', userInput])` so arguments aren't re-parsed by a shell.

</details>

### 🟠 High (1)

- [ ] <!-- item:2 fp:def456abc7890123 --> **Hardcoded API key in config** — `src/config.ts:18` (gitleaks · `generic-api-key`)
<details><summary>Details</summary>

```typescript
const API_KEY = "sk_live_abc123..."
```

A live API key is committed to the repo. Anyone with read access to the repo (or the git history of a former branch) can use it.

**Suggested fix:** move the key to an environment variable (`process.env.API_KEY`) and rotate the exposed one immediately.

</details>

### 🟡 Medium (0)

_No findings._

### 🟢 Low (0)

_No findings._
````
