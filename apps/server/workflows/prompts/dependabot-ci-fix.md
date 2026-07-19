You are fixing a dependency-update pull request whose CI has gone red.

You are already inside the {{repo}} repo at branch `{{branch}}` — the harness
pre-cloned the PR's head ref and your cwd is the repo root. Git is configured to
push. Read CLAUDE.md (and CONTRIBUTING.md if present) for project-specific
guidance.

CONTEXT:
- PR #{{prNumber}}: {{issueTitle}}
- This is an automated dependency update (Dependabot / Renovate). The dependency
  bump itself is already committed on this branch — do NOT revert it. Your job is
  to make the update pass CI.
{{ciSection}}

INSTRUCTIONS:
1. FIRST bring the branch up to date with its base, so your fix is built on the
   current base and a `behind` PR is made mergeable (so the merge step later sees
   a `clean` PR, not `behind`). Merge — do NOT rebase or force-push:
   - `git fetch origin {{baseBranch}}`
   - `git merge --no-edit origin/{{baseBranch}}`
   If the merge conflicts (almost always the lockfile), resolve it by
   **regenerating** the lockfile with the repo's package manager, then
   `git add -A && git commit --no-edit` to complete the merge — never hand-edit a
   lockfile. If the branch is already up to date this is a no-op. (The workspace
   is a shallow clone; if the merge base isn't reachable, run `git fetch --deepen
   100 origin {{baseBranch}}` — or `--unshallow` — and retry the merge.)
2. Read the CI failures above (and the workspace) to understand WHY the update
   broke the build — common causes for a dependency bump:
   - the lockfile is stale or inconsistent with the manifest (regenerate it with
     the repo's package manager),
   - a breaking change in the new version needs call sites / types updated,
   - a peer-dependency or engines constraint needs a matching bump.
3. Make the **smallest** change that makes CI pass. Prefer a lockfile
   regeneration or a mechanical call-site/type update over a behavioural change.
   Do NOT widen the scope beyond making this update green.
4. Follow the **building** skill: install dependencies with the repo's package
   manager, then run the full test / lint / typecheck gate. Do NOT commit until
   it all passes locally.

AFTER FIXING:
1. git add -A && git commit -m "fix(deps): resolve CI failures for #{{prNumber}}"
2. git push origin HEAD

If you cannot make CI pass with a small, safe change, STOP without pushing a
speculative fix and say so in your summary — a human will take it from here.
Before you stop, flag the PR for a human so the nightly red-dependency sweep
won't keep re-attempting it: ensure the `requires-human` label exists with one
idempotent `github_ensure_labels` call (`{ owner: "{{owner}}", repo: "{{repo}}",
labels: [{ name: "requires-human", color: "b60205", description: "Last Light
can't proceed automatically; a maintainer must handle it." }] }`), then add it
with `github_add_labels` (`{ owner: "{{owner}}", repo: "{{repo}}", issue_number:
{{prNumber}}, labels: ["requires-human"] }`). If label writes are denied, just
say so in your summary. (This isn't permanent: once a later fix lands and turns
the checks green, the `dependabot-pr-merge` workflow re-assesses the PR and
clears `requires-human` if the update is trivial.)

OUTPUT: A brief summary of the root cause, exactly what you changed, and the
local test/lint/typecheck results.
