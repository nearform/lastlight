You are publishing an approved spec that the previous phase wrote to
`{{issueDir}}/explore-spec.md`.

## Your task

1. Read the spec file at `{{issueDir}}/explore-spec.md` (relative to the cwd).
2. Decide the destination based on where this explore was triggered from:

### GitHub-originated (triggered by a comment on an existing issue)

If `{{issueNumber}}` is set and non-zero (and not a Slack-originated run),
post the spec as a **comment on issue #{{issueNumber}}** in
`{{owner}}/{{repo}}` using the `github_add_issue_comment` MCP tool.

### Slack-originated (triggered in a Slack thread)

If there's no `{{issueNumber}}` (or it's `0`), the run originated from a
Slack mention. Create a **new GitHub issue** in the configured destination
repo — check the environment variable `EXPLORE_DEFAULT_REPO` for the
`owner/name` to use, unless the baseline identified a specific target repo.
The new issue body should be the spec contents plus a trailer line crediting
the Slack thread as the source.

## Rules

- Read the spec file first — don't paraphrase it from memory.
- On success, output a short message with the link. For example:
  `**Spec published:** https://github.com/owner/repo/issues/123`
  This output is sent directly to the user in Slack/GitHub, so make it
  useful — include the URL.
- On failure, output the error plainly. Don't retry silently.
