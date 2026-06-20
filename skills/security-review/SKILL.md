---
name: security-review
description: Diff-scoped security review of SDLC concerns GitHub's scanners miss — workflow/CI hardening, auth changes, secret handling, supply-chain churn. Files one dated summary issue with a task-list of findings. Use on a security cron or when asked to scan a repo.
version: 2.0.0
tags: [github, security, review]
---

# Security Review

Review **what changed in the repo since the last scan** with a security lens,
focused on SDLC concerns that GitHub's built-in scanners (Dependabot, Code
Scanning, Secret Scanning) and Renovate don't cover. File **one summary issue
per run**, dated, containing a GitHub task list of any findings. Honour
`SECURITY.md` to suppress accepted risks and false positives.

This is **not** a general vulnerability scanner. It does not run `npm audit`
(Dependabot does). It does not run `semgrep --config auto` over the whole tree
(Code Scanning does). It looks at the diff since the prior scan and surfaces what
humans introduced — CI hardening, auth changes, secret handling in new code,
supply-chain churn.

The summary issue's structure is the machine-parsed contract a maintainer's
later comment is processed against (the `security-feedback` skill). It is defined
in **[references/issue-format.md](references/issue-format.md)** — follow it
exactly when composing the issue (§9).

## Context

- `context.repo` — `owner/name` to scan
- `context.deliverSlackSummary` — if true, output a one-line Slack summary as the final response
- `context.issueDir` — directory for the run summary file (e.g. `.lastlight/security-<date>`)

## Procedure

### 1. Clone, find the prior-scan anchor, read SECURITY.md

1. Clone the target repo via `github_clone_repo`.
2. **Prior scan anchor.** Query issues labelled `security-scan` (open OR closed),
   newest first. Read the latest one's body for the
   `<!-- lastlight-security-scan-ts: ... -->` comment and use that ISO-8601
   timestamp as `priorScanTs`. No prior scan issue → `priorScanTs = now - 30 days`
   (bootstrap floor — keeps the first run finite).
3. Read `SECURITY.md` at the repo root (if present): per-tool severity floors
   (default `medium`; skip `low`/`info`), the accepted-risks table, and the
   false-positives table (both keyed by finding fingerprint).

### 1.5. Compute the changeset

Most weeks the diff is dominated by Renovate/Dependabot churn — strip it so the
scope is what humans wrote.

1. `git log --since="${priorScanTs}" --pretty=format:'%H|%an|%ae|%s'`.
2. Drop a commit when **either**: author email matches
   `*[bot]@users.noreply.github.com` and name is `dependabot[bot]` /
   `renovate[bot]` / `github-actions[bot]`; OR the subject starts with
   `chore(deps)`, `chore(deps-dev)`, `build(deps)`, `build(deps-dev)`, `fix(deps)`.
3. Accumulate changed files from the surviving commits
   (`git diff-tree --no-commit-id --name-only -r ${sha}`) into a deduped
   `changedFiles` set.
4. Drop entries that are **only** lockfiles (`package-lock.json`, `pnpm-lock.yaml`,
   `yarn.lock`, `bun.lockb`, `Gemfile.lock`, `poetry.lock`, `uv.lock`,
   `Cargo.lock`, `composer.lock`) — catches lockfile changes mixed into human commits.
5. Build `commitsReviewed` = surviving commits as `{ shortSha, subject }` (used in the scope note).

**Early exit.** If `changedFiles` is empty after filtering, **stop**: run no
scanner, create no issue, emit no Slack message. Write the run summary file (§10)
recording "no relevant changes since prior scan" and return.

### 2. Ensure labels exist

`github_create_label` for each (idempotent — ignore 422):

| Label | Color | Purpose |
|-------|-------|---------|
| `security` | `ee0701` | Any security-related issue |
| `security-scan` | `fbca04` | The per-run summary issue |
| `p0-critical` | `b60205` | Severity |
| `p1-high` | `d93f0b` | Severity |
| `p2-medium` | `fbca04` | Severity |
| `p3-low` | `0e8a16` | Severity |

### 3. Run change-scoped scanners

Three sources, all narrowed to the changeset. Do **not** run `npm audit` or
`semgrep --config auto .` over the whole tree (covered elsewhere; the noise
drowns the signal).

- **Gitleaks (commit range):**
  `gitleaks detect --source . --log-opts="--since=${priorScanTs}" --report-format json --report-path /tmp/gitleaks.json`
  — secrets introduced in the new history.
- **Semgrep (changed files only):**
  `semgrep --config auto --json $(printf -- '--include=%s ' "${changedFiles[@]}")`
  — only files that changed; far less noise.
- **Claude SDLC review** — the unique value-add. Read `git diff ${priorScanTs}..HEAD`
  plus the current contents of changed files against the checklist below. Each
  match becomes a finding with `tool: "claude"` and the §4 severity.

  - **GitHub Actions / CI** (`.github/workflows/*.yml`): actions pinned by
    floating ref (`@main`/`@master`/`@v1`) not a commit SHA; `pull_request_target`
    that checks out the PR head; missing top-level/job `permissions:` block;
    `${{ secrets.* }}` interpolated into shell/`run:`/echo where it can land in
    logs; untrusted PR body/title/branch interpolated into a `run:` block.
  - **Dockerfile / compose**: base images on floating tags (no digest) introduced
    here; new `RUN curl … | sh` / `wget … | bash`; new `--privileged`/`--cap-add`,
    removed `security_opt`/`read_only` hardening; new host-exposed ports without need.
  - **Auth / authorization**: modified middleware, route guards, role checks, CORS,
    JWT verification, OAuth handlers, webhook signature verification (HMAC compare,
    `crypto.timingSafeEqual` replaced with `===`).
  - **Secret handling in new code**: new `process.env.*` reads whose value flows
    into a log or HTTP response; new code logging Authorization headers/cookies/tokens;
    hardcoded key/URL-shaped literals gitleaks missed.
  - **Shell exec on attacker-influenced args**: new `execSync`/`exec`/`spawn` where
    any argument is non-static (concatenation, interpolation, request-derived).
  - **Supply-chain churn** (`package.json` diff): **new** top-level
    `dependencies`/`devDependencies` entries (not version bumps — filtered at §1.5);
    flag package name + publisher, higher severity for typosquat-shaped names;
    removed integrity controls (`npm ci` → `npm install`, dropped `--ignore-scripts`
    or provenance flags).
  - **Release / publish flows**: changes to publish scripts, `npm publish`, release
    CI steps, signing keys — anything touching what users download.

  If the only changes are docs/tests/unrelated config and none of the above
  applied, the run legitimately has **no findings** — proceed to §8.

### 4. Normalize findings

Convert each to: `{ fingerprint, severity, tool, rule, file, line, title,
language, snippet, explanation, suggestedFix }`.

- `fingerprint` = `sha1(tool + ":" + rule + ":" + file + ":" + 3-line-context)`, lowercase hex.
- `severity` ∈ `p0-critical | p1-high | p2-medium | p3-low`.
- `tool` ∈ `npm-audit | semgrep | gitleaks | claude` (lowercase, hyphenated).
- `rule` = tool-native id, as-is. `file` = repo-relative, forward slashes.
- `line` = 1-based; `0` when not line-scoped. `title` = one line, no backticks/asterisks.

Severity mapping: npm-audit critical/high/moderate/low → p0/p1/p2/p3;
semgrep ERROR/WARNING/INFO → p1/p2/p3; gitleaks (all) → p1-high;
claude critical/high/medium/low → p0/p1/p2/p3.

### 5. Apply severity floor

Drop findings below the SECURITY.md floor (default `medium` → drops `p3-low`).

### 6. Filter accepted risks / false positives

Drop findings whose fingerprint prefix (first 16 hex chars) appears in the
SECURITY.md accepted-risks or false-positives tables.

### 7. Sort and cap

Sort by `(severity rank p0<p1<p2<p3, then file asc, then line asc)`.

The issue body has a hard 65,536-char GitHub limit. Cap: keep **ALL** `p0-critical`
and **ALL** `p1-high`; keep at most **10** of `p2-medium`+`p3-low` combined (the
first 10 after the sort). Assign 1-based `item` numbers top-to-bottom across the
**kept** findings. `overflow` = survived-filtering minus kept; surface it in the
overflow note.

The cap intentionally puts no ceiling on critical/high — if a misconfigured
scanner emits hundreds of highs and the body still overflows, raise the
`SECURITY.md` floor or tune the scanner's rule severities (fix at the source, not
by hiding real findings).

### 8. Early exit: no findings

If the filtered-and-capped list is empty, **do not** create the summary issue.
Write the run summary file (§10) recording why and return **silently** — no Slack
message. The cron is intentionally low-noise: only actual findings surface.

### 9. Compose and create the summary issue

Render the body per [references/issue-format.md](references/issue-format.md) and
`github_create_issue` with `title: Security scan — {YYYY-MM-DD}` (UTC),
`labels: ["security", "security-scan"]`. Record `summaryIssueNumber`. Do **not**
touch prior `security-scan` issues — each scan is a point-in-time snapshot.

### 10. Write the run summary file

Write `{issueDir}/security-summary.md`:

```markdown
# Security Scan Summary — {repo}

**Date**: {YYYY-MM-DD}
**Prior scan anchor**: {priorScanTs} (issue #{priorScanIssueNumber} or "bootstrap floor")
**Commits reviewed**: {N} (after filtering Renovate/Dependabot/lockfile-only)
**Changed files**: {nFiles}
**Summary issue**: #{summaryIssueNumber} (or "none — no findings")

**Scanner raw counts**: gitleaks: {n}, semgrep: {n}, claude: {n}
**After severity floor**: {n}
**After SECURITY.md filtering**: {n} (filed)
**Suppressed**: {n} (accepted: {nA}, false-positive: {nFP})
{if overflow > 0}: **Overflow**: {overflow} lower-severity findings omitted (cap: ALL critical/high + first 10 medium/low)
```

On a §1.5 early exit, still write the file and state `**Early exit**: no human
commits since prior scan`.

### 11. Slack summary (optional)

If `context.deliverSlackSummary` is true, output as the final response:

- **With findings:**
  ```
  *Security scan: {repo}* — {n} findings filed in #{summaryIssueNumber} ({N} commits since {priorScanDate})
  Critical: {nC} · High: {nH} · Medium: {nM} · Low: {nL}
  ```
- **No findings** (scanners ran clean) or **§1.5 early exit** → emit nothing;
  silence matches the cron's low-noise design. The run summary file still records
  what was reviewed.

Otherwise output the run summary file contents as the final response.
