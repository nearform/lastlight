# PR review findings schema

The `pr-review` skill writes its findings to `.lastlight/pr-review/findings.json`
(relative to the repo checkout — your cwd). The first-class `post-review` action
reads this file and posts **one** formal GitHub review:

- Each finding is anchored by matching its **`existingCode`** excerpt against the
  diff. If the excerpt resolves to a line that appears in the PR diff, the finding
  becomes an **inline comment** on that exact line.
- Any finding whose anchor isn't in the diff is **demoted** into the review body
  under an "Additional findings" heading (GitHub rejects comments off the diff).
- If the diff can't be computed (git failure), **all** findings go into the
  body — the review still posts, so nothing is lost.

You write only the review **content** — `skip?` / `summary` / `event` /
`findings[]`. The PR number, base ref, head SHA and diff come from the harness's
own run context and the checkout, so you do **not** record any of that metadata.
You never call `github_create_pull_request_review` yourself; writing this file is
how you submit.

## Top-level object

| Field | Type | Required | Meaning |
|---|---|---|---|
| `skip` | boolean | no | `true` → you decided not to review (bot-authored / merged / already reviewed at head). The action posts nothing. |
| `summary` | string | yes | One or two sentences on what the PR does + your overall assessment. Becomes the review body. |
| `event` | string | yes | `APPROVE` \| `REQUEST_CHANGES` \| `COMMENT`. A clean PR is `APPROVE` with an empty `findings` array — but never `APPROVE` over an open human `CHANGES_REQUESTED`, or while one of your own prior findings is still open (SKILL.md §2/§2b). |
| `findings` | array | yes | The surviving Critical/Important findings (may be empty). |

## Finding object

| Field | Type | Required | Meaning |
|---|---|---|---|
| `path` | string | yes | Repo-relative file path, matching the diff path exactly. |
| `existingCode` | string | **yes** | The **verbatim excerpt** the finding is about, copied character-for-character out of the code. This is the anchor of record — see below. |
| `line` | number | no | **Advisory.** A hint at where the excerpt is; the harness derives the real line and overwrites this. Wrong is survivable, absent is fine. |
| `side` | string | no | `RIGHT` (added/context line — default) or `LEFT` (removed/context line). Also derived. |
| `start_line` | number | no | Derived for you from a multi-line `existingCode`. Do not set it. |
| `severity` | string | yes | `Critical` or `Important` only. |
| `title` | string | yes | Short label for the finding. |
| `body` | string | yes | Concrete impact — what breaks, for which input or caller. |
| `suggestion` | string | no | Exact replacement text for the anchored line(s). Rendered as an applyable ```suggestion block. Include only when a concrete one-to-few-line fix is obvious. |

## Quote the code; do not count the lines

**`existingCode` is how a finding gets anchored, and it is the field to get
right.** Models quote code accurately and count lines badly, so the harness stops
asking you to count: it takes your excerpt and finds it, in this order — the
file's own diff hunks, then the whole head-side file, then (on a *unique* match)
any other file in the diff, which is how a finding you filed against the wrong
file of a declaration/implementation pair still lands correctly.

Two rules follow:

- **Copy, never paraphrase.** Leading and trailing whitespace is ignored, nothing
  else is. A reconstructed-from-memory excerpt does not match and the finding is
  demoted to the review body.
- **Quote enough to be unique, and no more.** One distinctive line is usually
  right. An excerpt that appears in two files is ambiguous and the harness
  declines to guess rather than anchoring you to the wrong one.

A finding whose excerpt cannot be found is still **posted**, in the review body.
Nothing is lost by an excerpt that fails to resolve — but an inline comment at
the defect site is worth substantially more than a body entry, so it is worth
copying carefully.

## Example — findings with an inline suggestion

```json
{
  "skip": false,
  "summary": "Adds a `--config` flag to the CLI and threads it into the connect path. Solid overall; one crash on the default path and one missing-await.",
  "event": "REQUEST_CHANGES",
  "findings": [
    {
      "path": "src/cli.ts",
      "existingCode": "const host = cfg.host;",
      "line": 42,
      "severity": "Critical",
      "title": "Null deref when --config is omitted",
      "body": "`cfg.host` is undefined when no config file is passed, so every default-path invocation throws before connecting.",
      "suggestion": "const host = cfg.host ?? DEFAULT_HOST;"
    },
    {
      "path": "src/connect.ts",
      "existingCode": "  disconnect();",
      "line": 88,
      "severity": "Important",
      "title": "Missing await on disconnect()",
      "body": "`disconnect()` returns a promise that's never awaited, so the socket can leak if the caller exits immediately after."
    }
  ]
}
```

## Example — clean PR (approve, no findings)

```json
{
  "skip": false,
  "summary": "Small, well-tested refactor of the retry helper. No correctness or regression concerns.",
  "event": "APPROVE",
  "findings": []
}
```

## Example — skip (already reviewed this SHA)

```json
{
  "skip": true,
  "summary": "A last-light[bot] review already exists on the current head SHA; nothing new to add."
}
```
