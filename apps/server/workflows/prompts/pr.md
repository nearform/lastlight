Create a pull request for the work on branch {{branch}}.

Use the MCP tool github_create_pull_request with the following:
- owner: {{owner}}
- repo: {{repo}}
- head: {{branch}}
- base: {{baseBranch}}
- title: A concise title describing the change (reference #{{issueNumber}})
- body: A markdown body that includes EXACTLY these sections in order:

  Closes #{{issueNumber}}

  ## Summary
  (3-6 bullet points describing what changed)

  ## Planning and execution docs
  - [Guardrails report]({{artifactUrl guardrails-report.md}})
  - [Architect plan]({{artifactUrl architect-plan.md}})
  - [Executor summary]({{artifactUrl executor-summary.md}})
  - [Reviewer verdict]({{artifactUrl reviewer-verdict.md}})
  - [Status]({{artifactUrl status.md}})

  Before adding each link above, run `ls -1 {{issueDir}}/`
  and OMIT any line whose file doesn't exist on disk. Use the
  exact full https URLs above as written — do NOT shorten to relative paths,
  they will not render in the PR description.

  ## Test results
  (paste the actual test/lint/typecheck output from executor-summary.md){{#if !review.approved}}

Note: There are unresolved reviewer issues after {{review.cycles}} fix cycles. See reviewer-verdict.md on the branch.{{/if}}

Do NOT post a comment with the PR link — the harness adds it to the status
checklist on the issue automatically. Just create the PR.

Update status.md: current_phase = complete, add pr_number.
{{#if !externalizeArtifacts}}Then `github_publish` with `{ owner: "{{owner}}", repo: "{{repo}}", message: "status: PR created for #{{issueNumber}}" }` — it commits the working tree as one signed commit.{{/if}}{{#if externalizeArtifacts}}Do NOT git add or commit {{issueDir}}/ — the harness persists it to the Last Light server automatically.{{/if}}

OUTPUT: The PR number and URL (so the harness can link the PR from the checklist).
