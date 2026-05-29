Create a pull request for the workflow authoring work on branch {{branch}}.

Use the MCP tool create_pull_request with:
- owner: {{owner}}
- repo: {{repo}}
- head: {{branch}}
- base: main
- title: A concise title for the workflow authoring change{{#if issueNumber}} (reference #{{issueNumber}}){{/if}}
- body: A markdown body with these sections:

{{#if issueNumber}}
Refs #{{issueNumber}}
{{/if}}

## Summary
- Describe the workflow YAML and prompt-template changes.
- Name the workflow that was created or edited.
- Note whether this PR changes routing/triggers or only adds workflow definitions.

## Request
- Mode: `{{workflowMode}}`
- Workflow name: `{{workflowName}}`
- Requested by: `{{sender}}`

## Validation
Paste the validation/test output from the workflow-author summary.

## Planning and execution docs
Before adding links, run `ls -1 {{issueDir}}/` and omit missing files.
- [Workflow author summary]({{branchUrl workflow-author-summary.md}})
- [Status]({{branchUrl status.md}})

Then, when `issueNumber` is present, use add_issue_comment on issue #{{issueNumber}} to post the PR link.

Update status.md if it exists: current_phase = complete, add pr_number.
git add .lastlight/ && git commit -m "status: workflow author PR created{{#if issueNumber}} for #{{issueNumber}}{{/if}}" && git push origin HEAD, but only if status files changed.

OUTPUT: The PR number and URL.
