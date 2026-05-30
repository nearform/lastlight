---
name: security-review
description: Diff-scoped security review covering SDLC concerns GitHub's built-in scanners miss (workflow/CI hardening, auth changes, secret handling, supply-chain churn). Files one dated summary issue with a task-list of findings.
---

# Security Review Skill

Review **what changed in the repo since the last scan** with a security lens, focused on SDLC concerns that GitHub's built-in scanners (Dependabot, Code Scanning, Secret Scanning) and Renovate don't cover. File **one summary issue per run**, dated, containing a GitHub task list of any findings — Renovate-style. Honour `SECURITY.md` to suppress accepted risks and false positives.

This skill is intentionally **not** a general-purpose vulnerability scanner. It does not run `npm audit` (Dependabot does that). It does not run `semgrep --config auto` over the whole tree (GitHub Code Scanning does that). It looks at the diff since the prior scan and surfaces things that humans introduced — workflow/CI hardening, auth changes, secret handling in new code, supply-chain churn.

A maintainer can later comment on the summary issue to break selected findings out into individual issues (see the `security-feedback` skill). The exact issue structure defined in **§ Issue format** below is the contract between the two skills — **if you change it here, update `skills/security-feedback/SKILL.md` in lockstep**.

## Context

- `context.repo` — `owner/name` of the repo to scan
- `context.deliverSlackSummary` — if true, output a one-line Slack summary as the final response
- `context.issueDir` — directory for writing the run summary file (e.g. `.lastlight/security-<date>`)

## Procedure

### 1. Clone, find the prior-scan anchor, read SECURITY.md

1. Clone the target repo via `github_clone_repo`.
2. **Find the prior scan anchor.** Query GitHub issues with label `security-scan` (open OR closed), sorted by created descending, and take the most recent. Read its body for the `<!-- lastlight-security-scan-ts: ... -->` HTML comment and use that ISO-8601 timestamp as `priorScanTs`. If no prior scan issue exists, set `priorScanTs = now - 30 days` (bootstrap floor — keeps the first run finite).
3. Read `SECURITY.md` at the repo root (if present) and parse:
   - **Tool config** — per-tool severity floors (default: `medium`; skip `low`/`info`)
   - **Accepted risks table** — fingerprints of findings the maintainer has accepted
   - **False positives table** — fingerprints classified as not real

### 1.5. Compute the changeset

This step decides what gets reviewed. **Most weeks the diff is dominated by Renovate/Dependabot churn — strip that out so the actual scope is what humans wrote.**

1. List commits since the anchor:
   `git log --since="${priorScanTs}" --pretty=format:'%H|%an|%ae|%s'`
2. Drop a commit when **any** of these match:
   - Author email matches `*[bot]@users.noreply.github.com` AND author name is `dependabot[bot]`, `renovate[bot]`, or `github-actions[bot]`.
   - Commit subject starts with one of: `chore(deps)`, `chore(deps-dev)`, `build(deps)`, `build(deps-dev)`, `fix(deps)`.
3. For the remaining commits, accumulate changed files via `git diff-tree --no-commit-id --name-only -r ${sha}` into a deduplicated `changedFiles` set.
4. From `changedFiles`, drop entries that are **only** to lockfiles: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `composer.lock`. Lockfile-only commits are also skipped at step 2 by the dep-prefix filter, but this catches lockfile changes that slipped in via human commits with mixed scope.
5. Build a short list `commitsReviewed` = the surviving commits with `{ shortSha, subject }` (used in § 9 for the scope note).

**Early exit.** If `changedFiles` is empty after filtering, **stop here**. Do not run any scanner. Do not create an issue. Do not emit a Slack message. Write the run summary file (§ 10) recording "no relevant changes since prior scan" and return.

### 2. Ensure labels exist

Call `github_create_label` for each of (idempotent — ignore 422 "already exists"):

| Label | Color | Purpose |
|-------|-------|---------|
| `security` | `ee0701` | Any security-related issue |
| `security-scan` | `fbca04` | The per-run summary issue (distinguishes from sub-issues) |
| `p0-critical` | `b60205` | Severity |
| `p1-high` | `d93f0b` | Severity |
| `p2-medium` | `fbca04` | Severity |
| `p3-low` | `0e8a16` | Severity |

### 3. Run change-scoped scanners

Three sources of findings — all narrowed to the changeset. **Do not** run `npm audit` (Dependabot covers that) and **do not** run `semgrep --config auto .` over the whole tree (GitHub Code Scanning covers that and the noise drowns the signal).

- **Gitleaks (commit range)**: scan only commits since the anchor.
  `gitleaks detect --source . --log-opts="--since=${priorScanTs}" --report-format json --report-path /tmp/gitleaks.json`
  Catches secrets introduced in the new history. Belt-and-braces with GitHub Secret Scanning, which doesn't detect every key shape and doesn't run on private repos without GHAS.

- **Semgrep (changed files only)**: targeted, not whole-tree.
  `semgrep --config auto --json $(printf -- '--include=%s ' "${changedFiles[@]}")`
  Only emits findings for files that actually changed. Far less noise than a full-tree scan; everything reported is in the diff under review.

- **Claude SDLC review** — the unique value-add of this skill. Read the diff (`git diff ${priorScanTs}..HEAD`) plus the current contents of changed files, with this checklist. Each match becomes a finding with `tool: "claude"` and the severity from § 4.

  - **GitHub Actions / CI** (any change under `.github/workflows/*.yml`):
    - Action references pinned by floating ref (`uses: foo/bar@main`, `@master`, `@v1`) instead of a commit SHA — supply-chain risk if the action is compromised.
    - `pull_request_target` triggers that check out the PR head ref — well-known privilege-escalation pattern.
    - Missing top-level or job-level `permissions:` block (GITHUB_TOKEN defaults to write).
    - `${{ secrets.* }}` interpolation into shell scripts, `run:` blocks, or echo statements where the secret can land in logs.
    - Untrusted PR body / title / branch name interpolated into a `run:` block (script injection).
  - **Dockerfile / docker-compose changes**:
    - Base images on floating tags (`FROM node:latest`, no digest) introduced in this diff.
    - New `RUN curl … | sh` / `wget … | bash` pipelines.
    - New `--privileged`, `--cap-add`, `security_opt: []` removals, or `read_only: false` flips on services that previously had hardening.
    - New ports exposed to the host without an obvious need.
  - **Auth / authorization surfaces**: any modified middleware, route guard, role check, CORS config, JWT verification, OAuth handler, webhook signature verification (HMAC compare, `crypto.timingSafeEqual` removed/replaced with `===`).
  - **Secret handling in new code**:
    - New `process.env.*` reads — flag if the value flows into a log statement or HTTP response.
    - New code paths that log Authorization headers, cookies, or tokens.
    - Hardcoded literals matching key/URL shapes that gitleaks missed.
  - **Shell exec on attacker-influenced args**: new `execSync` / `exec` / `spawn` calls where any argument is non-static (string concatenation, template-literal interpolation, request-derived values).
  - **Supply-chain churn** (`package.json` diff):
    - **New** top-level entries in `dependencies` / `devDependencies` (not version bumps — those are filtered out at § 1.5 step 2). Flag the package name + publisher; new typosquat-shaped names get higher severity.
    - Removed integrity controls: switching `npm ci` → `npm install` in CI, removing `--ignore-scripts`, removing provenance flags.
  - **Release / publish flows**: changes to publish scripts, `npm publish` invocations, release CI steps, signing keys, or anything that touches what users download.

If the only changes are docs / tests / unrelated config and none of the above categories applied, the run can return **no findings** legitimately — proceed to § 8 (early exit).

### 4. Normalize findings

Convert each finding to:

```
{
  fingerprint: string,   // sha1(tool + ":" + rule + ":" + file + ":" + 3-line-context), LOWERCASE HEX
  severity: "p0-critical" | "p1-high" | "p2-medium" | "p3-low",
  tool: "npm-audit" | "semgrep" | "gitleaks" | "claude",  // lowercase, hyphenated
  rule: string,          // tool-native rule id, keep as-is (no spaces)
  file: string,          // path relative to repo root, forward slashes
  line: number,          // 1-based; use 0 when a finding isn't line-scoped (e.g. npm-audit)
  title: string,         // short, one line, NO backticks or asterisks
  language: string,      // fenced-code language tag for the snippet (e.g. "javascript", "typescript", "")
  snippet: string,       // code excerpt, no surrounding fences
  explanation: string,   // why this is a security issue (markdown, multi-line ok)
  suggestedFix: string,  // concrete fix with code example where possible (markdown)
}
```

Severity mapping:

| Tool | Source severity | Mapped to |
|------|----------------|-----------|
| npm-audit | critical | p0-critical |
| npm-audit | high | p1-high |
| npm-audit | moderate | p2-medium |
| npm-audit | low | p3-low |
| semgrep | ERROR | p1-high |
| semgrep | WARNING | p2-medium |
| semgrep | INFO | p3-low |
| gitleaks | (all) | p1-high |
| claude | critical | p0-critical |
| claude | high | p1-high |
| claude | medium | p2-medium |
| claude | low | p3-low |

### 5. Apply severity floor

Drop any finding below the SECURITY.md severity floor (default: `medium` → drops `p3-low`).

### 6. Filter accepted risks and false positives

Drop any finding whose fingerprint prefix (first 16 hex chars) appears in the SECURITY.md accepted-risks or false-positives tables.

### 7. Sort and cap

Sort findings by `(severity, file, line)` in this exact order:

1. Severity rank: `p0-critical` < `p1-high` < `p2-medium` < `p3-low`
2. Then `file` ascending (string compare)
3. Then `line` ascending

**Severity-aware cap (the issue body has a hard 65,536-char GitHub limit, and detailed findings blow through that on noisy repos):**

- Keep **ALL** `p0-critical` findings.
- Keep **ALL** `p1-high` findings.
- For `p2-medium` + `p3-low` combined, keep at most **10** (the first 10 after the sort above — severity then file then line, so all medium come before any low). Drop the rest.

Assign `item` numbers 1-based, top-to-bottom, across the **kept** findings (so items 1–2 might be `p0-critical`, items 3–7 are `p1-high`, items 8–17 are the kept medium/low).

`overflow` = total findings that survived filtering minus kept findings. The dropped items are counted in `overflow` and surfaced in the overflow note. Re-running the scan after `SECURITY.md` is tightened is the way to dig into them — we don't bloat one issue with everything.

**Note on unbounded high counts:** the cap above intentionally puts no ceiling on `p0-critical` or `p1-high` — those need to be visible regardless of count. On a repo where a noisy scanner (e.g. a misconfigured semgrep that maps every match to `ERROR`) emits hundreds of highs, the issue body can still exceed the 65,536-char GitHub limit. If that happens, raise the severity floor in `SECURITY.md` (`floor: high` keeps only criticals on the visible list) or tune the scanner's rule severities — both adjust at the source rather than papering over with a cap that hides real findings.

### 8. Early exit: no findings

If the filtered-and-capped list is empty, **do not** create the summary issue. Write the run summary file (§ 10) recording why (typically "no relevant changes" or "scanners clean") and return **silently** — do not emit a Slack message. The cron is intentionally low-noise: only changes that produce actual findings are surfaced.

### 9. Compose and create the summary issue

Use the exact grammar in **§ Issue format** below. Call `github_create_issue` with:

- `title`: `Security scan — {YYYY-MM-DD}` (UTC date)
- `labels`: `["security", "security-scan"]`
- `body`: the rendered body described in § Issue format

Record the new issue number as `summaryIssueNumber`. Do **not** close or touch prior `security-scan`-labelled issues — each scan is a point-in-time snapshot; maintainers process them at their own pace.

### 10. Write the run summary file

Write `{issueDir}/security-summary.md`:

```markdown
# Security Scan Summary — {repo}

**Date**: {YYYY-MM-DD}
**Prior scan anchor**: {priorScanTs} (issue #{priorScanIssueNumber} or "bootstrap floor")
**Commits reviewed**: {N} (after filtering Renovate/Dependabot/lockfile-only commits)
**Changed files**: {nFiles}
**Summary issue**: #{summaryIssueNumber} (or "none — no findings")

**Scanner raw counts**: gitleaks: {n}, semgrep: {n}, claude: {n}
**After severity floor**: {n}
**After SECURITY.md filtering**: {n} (filed)
**Suppressed**: {n} (accepted: {nA}, false-positive: {nFP})
{if overflow > 0}: **Overflow**: {overflow} lower-severity findings omitted from the summary issue (cap: ALL critical/high + first 10 medium/low)
```

When the run early-exited at § 1.5 (no relevant changes), the file should still be written and should explicitly state `**Early exit**: no human commits since prior scan` so the operator can see in `data/sandboxes/.../.lastlight/` why the cron tick produced no issue.

### 11. Slack summary (optional)

If `context.deliverSlackSummary` is `true`, output as the final agent response:

- **With findings**:
  ```
  *Security scan: {repo}* — {n} findings filed in #{summaryIssueNumber} ({N} commits since {priorScanDate})
  Critical: {nC} · High: {nH} · Medium: {nM} · Low: {nL}
  ```
- **No findings, but the changeset was non-empty** (scanners ran clean): emit nothing to Slack — staying silent matches the cron's low-noise design. The run summary file (§ 10) still records what was reviewed.
- **Early exit at § 1.5** (no human commits, or only deps/lockfile churn): emit nothing.

Otherwise output the contents of the run summary file as the final response.

---

## § Issue format

This is the **contract** between `security-review` (producer) and `security-feedback` (consumer). Every rule here is machine-parsed; do not deviate.

### Title

```
Security scan — YYYY-MM-DD
```

- Exactly one em-dash (` — `, U+2014), surrounded by single spaces.
- Date is the scan's UTC date in ISO form.
- Same-day re-scans produce a second issue with the same title. GitHub disambiguates by issue number; the scanner never edits a prior-run issue.

### Body

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

#### Block 1 — header comments

Three HTML comments, each on its own line, in this exact order:

```
<!-- lastlight-security-scan-version: 1 -->
<!-- lastlight-security-scan-date: YYYY-MM-DD -->
<!-- lastlight-security-scan-ts: YYYY-MM-DDTHH:MM:SSZ -->
```

- `version` is a format version. Bump if the structure changes incompatibly — `security-feedback` will check this and refuse to parse unknown versions.
- `date` matches the title.
- `ts` is an ISO-8601 UTC timestamp with second precision (no milliseconds).

#### Block 2 — intro paragraph

Exactly one paragraph, with the commit count and short-SHA range substituted:

```
Reviewing {N} commits since {priorScanDate} ({firstShortSha}..{lastShortSha}). Findings here focus on SDLC and workflow changes — Dependabot, GitHub Code Scanning, and Renovate handle the rest. Tick the box once the underlying issue is resolved or recorded in `SECURITY.md`.
```

`{N}` is the size of `commitsReviewed` from § 1.5. `{priorScanDate}` is the YYYY-MM-DD of the prior scan (or the bootstrap floor). When `N == 1`, both short SHAs are the same — render as `({onlyShortSha})` rather than `({sha}..{sha})`.

#### Block 3 — how-to-respond section

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

#### Block 4 — summary table

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

#### Block 5 — suppression note

A single line:

```
Suppressed by `SECURITY.md`: {nSuppressed} (accepted: {nA}, false-positives: {nFP}). Below severity floor: {nFloor}.
```

Set each count to 0 when N/A. Emit the line unconditionally so the structure is stable.

#### Block 6 — scope note

Always emit, immediately after the suppression note. Lists the human (non-bot) commits actually reviewed, so a maintainer can see what diff produced these findings:

```
> Commits reviewed: {short-sha-1} {subject-1}, {short-sha-2} {subject-2}, …
```

Cap at 10 entries; if there are more, append ` +{N} more` after the last item. Subjects are truncated to 60 chars with `…` if longer. Renovate/Dependabot commits are filtered out at § 1.5 and never appear here.

#### Block 7 — overflow note

Emit **only** when `overflow > 0`:

```
> **Note** — {overflow} lower-severity findings are not listed here. The cap is: ALL critical and high, plus the first 10 medium/low (after sort). Tighten `SECURITY.md` severity floors or break out items from this scan, then re-run to surface the rest.
```

#### Block 8 — findings sections

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

#### Finding-row grammar

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

### Worked example

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
