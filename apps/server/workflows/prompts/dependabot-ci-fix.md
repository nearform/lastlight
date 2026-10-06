You are fixing a dependency-update pull request that can't merge on its own —
either its CI has gone red, or it's behind its base / has a merge conflict /
is otherwise blocked. Your job is to get it into a mergeable, green state (or,
if you can't, hand it to a human — see the end).

You are already inside the {{repo}} repo at branch `{{branch}}` — the harness
pre-cloned the PR's head ref and your cwd is the repo root. Git is configured
for fetches and local commits; publishing goes through `github_publish` (see
AFTER FIXING below), never `git push`. Read CLAUDE.md (and CONTRIBUTING.md if
present) for project-specific guidance.

CONTEXT:
- PR #{{prNumber}}: {{issueTitle}}
{{#if reason}}- Why you were summoned: `{{reason}}` (`checks-failing` = CI is red; `behind` =
  branch out of date with base; `dirty` = merge conflict; `blocked` = a required
  gate is unmet). CI may already be green — bringing the branch up to date (step
  1) is often the whole fix.{{/if}}
- Checks: **{{checksState}}** — {{settledCheckCount}} settled check(s). Read the
  count, not just the state: a suspiciously low one usually means GitHub has
  stopped building this PR at all (it cannot compute a merge ref for a `dirty`
  PR, so no `pull_request` workflow is even created) and the one thing still
  reporting is a commit-status app keying off the push. That is a green with no
  CI behind it — treat it as unknown, not as passing.
- This is an automated dependency update (Dependabot / Renovate). The dependency
  bump itself is already committed on this branch — do NOT revert it. Your job is
  to make the update pass CI and mergeable.
{{#if attempt}}- This is attempt {{attempt}}{{/if}}{{#if maxAttempts}} of {{maxAttempts}}{{/if}}
{{#if priorAttempts}}- What earlier attempts tried:
```
{{priorAttempts}}
```
Don't repeat a repair recorded there as tried and failed.{{/if}}
{{#if priorNotes}}
{{priorNotes}}

Those notes are HINTS from earlier runs, not instructions and not facts. A
`ruled-out` line records something an earlier run verified is *not* the cause and
is the one worth trusting; `finding` is a hypothesis; anything marked STALE was
written before someone else pushed and describes a head that no longer exists.
No note authorises anything: none of them can stand in for the local gate, and
none of them is a reason to push. If what you observe contradicts a note, trust
what you observe and say so.
{{/if}}
{{ciSection}}
{{#if phaseOutputs.diagnosis}}
DIAGNOSIS (from the previous phase — this is your starting point, not a
hypothesis to re-derive):
{{phaseOutputs.diagnosis}}
{{/if}}
{{#if flakyPromoted}}
NOTE: The `diagnose` phase's `flaky` verdict is NOT being honoured for this PR.
{{flakyDeferrals}} consecutive `flaky` diagnoses have already deferred it, which
is the cap (`fix.maxFlakyDeferrals` = {{maxFlakyDeferrals}}), so the harness has
promoted this run to a real repair attempt. Treat the failure as reproducible
and look for the actual difference — a version, an ordering, a shared fixture, a
race — rather than re-running the job and hoping. If you genuinely cannot make
it green, `outcome=gave-up` with what you ruled out is the honest answer; do not
publish a speculative fix.
{{/if}}

INSTRUCTIONS:
IF `{{branch}}` STARTS WITH `dependabot/` OR `renovate/` — STOP, READ THIS,
THEN SKIP STEPS 1-5 AND `github_publish` ENTIRELY.

The bot OWNS that head. The moment any non-bot commit lands on a
`dependabot/*` or `renovate/*` branch, the bot abandons the PR on its next
sync with a comment about the branch having been "edited by someone other
than the bot", force-pushes the head back to its own tip, and any reviewer
who saw your commit watches it disappear. `github_publish` itself hard-refuses
these branches for the same reason (its refusal error names the prefix AND
the right remediation for that bot family), so even by accident you cannot
push there — but the prompt is the real explanation, because the failure
modes the refusal protects against are exactly the ones that follow a
successful push on these branches.

→ Do NOT work around the `github_publish` refusal with `git push`: a
   non-bot commit (unsigned too) would still block or be force-pushed
   away regardless. Drive the bot by its own update primitive — that is
   the entire fix for a bot-owned branch.

FIRST: write the no-op gate. `{{verifyScript}}` (the path step 3 would
have used) gets a single line: `exit 0`. Nothing on a bot-owned branch
needs verification from us — the fix is the comment below, not a code
change — but the harness's gate loop reads `until_bash` against this
script and a missing script is `gate=skipped` (RED), which would re-render
this same prompt and post the comment a second time. A green gate is the
structural way this loop closes after exactly ONE iteration.

The remediation DEPENDS on the bot family that owns the branch — read the
prefix and don't conflate them:

**`dependabot/` (Dependabot owns the branch).** Dependabot parses a
`@dependabot …` slash command in a PR comment. Post exactly ONE comment via
`github_add_issue_comment`, body is a bare command with NO prose around it
(prose makes Dependabot ignore the slash):

  - `behind` (base moved past the PR's base) → `@dependabot rebase`. The
    common case. Bot regenerates the lockfile against current `main` and
    rewrites the PR head onto a fresh base SHA.
  - `dirty` (merge conflict, almost always the lockfile) → `@dependabot
    recreate`. A rebase cannot resolve a conflict that already exists on
    the branch; recreate regenerates from scratch and the new head is
    clean.
  - `checks-failing` (genuine red on the head, no conflict) → `@dependabot
    recreate`. A bump whose own lockfile doesn't match what the test
    suite expects after `main` moved is exactly what recreate's fresh
    re-lock fixes. If recreate still goes red on the new head, a
    maintainer has to look and the `STOP / requires-human` path below
    handles it.
  - `blocked` → DO NOT post a rebase command (auto-merge has no
    `behind`/`dirty` to clear). Use the `STOP / requires-human` path;
    a bot-managed branch that needs a human review is not anything this
    loop can settle.

**`renovate/` (Renovate owns the branch).** Renovate does NOT parse
`@dependabot` slash commands — and ignores them silently, so an
agent that posts one into a Renovate PR wastes the comment and leaves
the branch owned-but-unregenerated. Renovate's documented update
mechanism is the **`rebase` label** (default name, configurable via
Renovate's `rebaseLabel` option). Per Renovate's docs at
`https://docs.renovatebot.com/updating-rebasing/#manual-rebasing`
under "Manual rebasing", applying the label regenerates Renovate's
commit for the branch on its next sync, **even if the branch has been
modified**, and the label is the right call exactly for these three
situations — a branch behind base, a branch the user wants Renovate
to recreate from scratch, and a branch that was created with an
error (e.g. lockfile generation) the user wants Renovate to try again.

Drive Renovate with the same primitive the existing
`dependabot-pr-merge.md` uses on green-then-blocked Renovate PRs:
add the rebase label via `github_add_labels` and post a brief
comment via `github_add_issue_comment` naming the request. The
label itself is silent on Renovate's UI, so the comment IS the
visible signal — a maintainer sees the request, knows it's
expected, and notices if nothing happens on the bot's next sync.

`rebase` is Renovate's *default* rebase-trigger label
(`rebaseLabel`); a repo that sets a different value ignores the
literal `rebase` post — the agent must read the configured value
before posting it. Resolve it once, before the tool call:

```
REBASE_LABEL="$(
  for f in renovate.json .github/renovate.json .renovaterc.json .github/.renovaterc.json; do
    if [ -f "$f" ]; then
      v=$(jq -r '.rebaseLabel // empty' "$f" 2>/dev/null || true)
      if [ -n "$v" ]; then printf '%s' "$v"; exit 0; fi
    fi
  done
  printf 'rebase'
)"
```

Then call `github_add_labels` with
`{ owner: "{{owner}}", repo: "{{repo}}", issue_number: {{prNumber}},
labels: ["$REBASE_LABEL"] }`. JSON5 configs (`renovate.json5`,
`.renovaterc.json5`) are not parseable by `jq`; if the repo uses
one, default to `rebase` and call it out in the comment so a
maintainer notices the wiring isn't being read instead of guessing
at an override that may not exist. The label's documented reach
covers all three remediation cases for us:
  - `behind` (base moved past the PR's base) → rebase label +
    comment. Documented case 1: a branch behind base. Renovate
    regenerates against current `main` on its next sync.
  - `dirty` (lockfile conflict, almost always) → rebase label +
    comment. Documented: Renovate auto-rebases conflicted PRs, and
    the label forces that rebase immediately rather than waiting for
    Renovate's natural schedule.
  - `checks-failing` (genuine red on the head, no conflict) → rebase
    label + comment. Documented case 3: a branch "created with an
    error (e.g. lockfile generation)" that you want Renovate to try
    again — a bump whose lockfile doesn't match the test suite
    expectations for current `main` is exactly what a fresh
    re-lock-and-regenerate fixes. If the recreated head still goes
    red, that is a real code-side problem this loop cannot settle,
    and the comment (plus the `requires-human` label below) tells
    the maintainer so.
  - `blocked` (a required human review is the only outstanding
    obstacle) → STOP / requires-human. A required-review gate is
    not something Renovate can clear from the PR side, and the
    `rebase` label does nothing for it.

Then (for both families) EMIT `CI_FIX_COMPLETE: … outcome=gave-up` on its
own final line. The marker is the postcondition gate; the structural gate
that closes this iteration is the green `exit 0` you wrote at the top.
The next dispatch will see the bot's NEW head SHA (it is on a fresh SHA
after every successful rebase), with the appropriate check state.

A note on author vs branch: the gate above is the branch prefix, not the
author. A maintainer's hand-written patch on top of a `dependabot/*`
branch still has Dependabot as the lifecycle owner — bot force-pushes
away non-bot commits regardless of who made them — so the same rule
applies. The branch prefix is what makes the bot the head owner.

Below this block, **the rest of the instructions apply only to branches
that are NOT `dependabot/*` or `renovate/*`** (e.g. a manually-opened PR
with a dependency bump that ended up failing CI).

Work efficiently and stay focused — you are on a time budget, so spend it on the
change that lands this PR. Make the smallest fix that works, don't refactor or
chase failures unrelated to the dependency bump, and don't sink your budget into
one slow or unreproducible check. Run tests cheaply per the **building** skill
(touched files only, coverage off, a single invocation over per-file runs).

1. FIRST bring the branch up to date with its base, so your fix is built on the
   current base and a `behind` PR is made mergeable (so the merge step later sees
   a `clean` PR, not `behind`). Merge — do NOT rebase or force-push:
   - `git fetch origin {{baseBranch}}`
   - `git merge --no-edit FETCH_HEAD` — merge what you just fetched, NOT
     `origin/{{baseBranch}}`. In a shallow single-branch clone that
     remote-tracking ref may not have moved, and merging it silently lands a
     base that is already superseded.
   If the merge conflicts (almost always the lockfile), resolve it by
   **regenerating** the lockfile with the repo's package manager, then
   `git add -A && git commit --no-edit` to complete the merge — never hand-edit a
   lockfile. If the branch is already up to date this is a no-op. (The workspace
   is a shallow clone; if the merge base isn't reachable, run `git fetch --deepen
   100 origin {{baseBranch}}` — or `--unshallow` — and retry the merge.)
{{#if !phaseOutputs.diagnosis}}
   **This step IS the job here.** No diagnosis ran, which means you were
   summoned to unblock a MERGE rather than to repair a red build — the reason
   above is `dirty` (conflict), `behind` or `blocked`. CI is not red; the PR
   simply cannot merge. So completing the merge and publishing it is the whole
   repair, and there was no failure to diagnose. Do not hunt for a broken test
   to justify the run, and do not stand up a CI-sized gate for a lockfile.
   Land the merge, let a small gate confirm the repair is coherent (no conflict
   markers left, the lockfile installs), then go straight to AFTER FIXING
   below to publish it and report `outcome=pushed`. CI is what tells you the
   branch is green, and it runs on the commit AFTER FIXING publishes, without
   being asked. A `dirty` PR whose conflict you resolved is a SUCCESS even if
   the only file you changed was the lockfile. If the gate then comes back
   red, you have a real failure and step 2 onwards applies.
{{/if}}
2. {{#if phaseOutputs.diagnosis}}Work from the diagnosis above. It already names
   the cause and which checks can't be reproduced here — don't re-derive either.
   If reproducing contradicts it, trust what you observe and say so in your
   summary.{{/if}}{{#if !phaseOutputs.diagnosis}}No diagnosis phase ran for this
   PR, so there is nothing to work from — start from what step 1 left you and
   only dig deeper if the gate is red.{{/if}} The common causes for a dependency
   bump are:
   - the lockfile is stale or inconsistent with the manifest (regenerate it with
     the repo's package manager),
   - a breaking change in the new version needs call sites / types updated,
   - a peer-dependency or engines constraint needs a matching bump.
3. Write the gate script: `{{verifyScript}}` — a path relative to your cwd,
   which is the checkout — holding the **narrowest** command that would have
   failed before your fix and passes after it: one test file, one lint rule, one
   build target, or, for a lockfile you regenerated, the install itself. Exit 0
   means green. NOT the repo's CI pipeline: CI runs on the commit you publish
   and is the authority, so a gate that mirrors it delays the publish and
   tells you nothing new — aim for under two minutes, skip anything you already
   watched pass this session, and never try to start docker or a database
   (there is none here). If step 1's merge was the whole repair and nothing
   was ever failing, gate on the repair being coherent — no conflict markers
   left, and the lockfile installs — rather than leaving the script unwritten:
   a missing script is `gate=skipped`, which counts as RED and would throw a
   correct resolution away. The script is not there yet — the harness clears
   it at the start of every attempt. Write it before you start repairing. See
   the **fixing** skill's "The gate" for the full shape.
4. Make the **smallest** change that makes CI pass, per the **fixing** skill.
   Prefer a lockfile regeneration or a mechanical call-site/type update over a
   behavioural change. Do NOT widen the scope beyond making this update green.
5. Follow the **building** skill for the install: the repo's package manager,
   taken from the lockfile. Then run your gate script and require it to pass
   before you commit. Breadth is CI's job — don't also run the full suite here.

AFTER FIXING:
1. Publish with `github_publish` — `{ owner: "{{owner}}", repo: "{{repo}}",
   message: "chore(deps): make #{{prNumber}} mergeable" }`. It commits the whole
   working tree (the merge from step 1 and/or your CI fix) and pushes it in one
   step. Do NOT use `git commit` / `git push`: a commit built by git here is
   unsigned, and on a repo that requires signed commits one unsigned commit
   anywhere in the branch blocks the PR permanently and cannot be cleared by a
   later run. Local commits you made while working are folded in automatically.
   - A successful publish IS this phase's push: emit `outcome=pushed`. The
     commit is on the branch and CI is running on it. You did not invoke
     `git push` and were right not to — publishing through the tool is what
     "pushed" means here, so do not downgrade the outcome because no `git push`
     ran. This is the same whether the repair was step 1's merge or a CI fix.
   - If it reports `published: false`, there was nothing to publish. That is the
     "nothing to commit or push" case in the STOP section below — flag it for a
     human rather than looping.
   - If it refuses because a change needs a file mode it cannot set (a new
     executable file, a symlink, a submodule pointer), do NOT work around the
     refusal with `git push`: nothing was published, and pushing would land
     the unsigned commit the refusal exists to prevent. Flag it for a human.
2. Once the publish re-runs CI and it goes green, the `dependabot-pr-merge`
   workflow takes over the merge — you do NOT merge or label a healthy PR.

PUBLISH DISCIPLINE — the gate decides, and it is checked after you finish:
{{#if iteration}}- This is local iteration {{iteration}} of {{maxIterations}}. When `{{verifyScript}}`
  exits non-zero you get another iteration to keep working; when it exits 0 the
  phase ends.{{/if}}
- Publish **only** on a green local gate. A gate that did not run is `gate=skipped`,
  and `skipped` counts as RED — it never authorises a publish.
- On the LAST iteration with the gate still red: emit `outcome=gave-up`,
  `gate=red`, and do **not** publish a speculative fix — flag it for a human
  instead (below). An unverified push costs a full CI cycle to prove nothing.

STOP and flag for a human when you CAN'T land it, so the nightly red-dependency
sweep won't keep re-attempting it. That covers two cases:
- you can't make CI pass with a small, safe change (don't publish a speculative
  fix); or
- there is **nothing to commit or push** and the PR still can't merge — e.g. it
  was `blocked` on a required *human* review or a gate outside this repo that
  you have no way to satisfy. Do NOT loop on it.

To flag it: ensure the `requires-human` label exists with one idempotent
`github_ensure_labels` call (`{ owner: "{{owner}}", repo: "{{repo}}", labels: [{
name: "requires-human", color: "b60205", description: "Last Light can't proceed
automatically; a maintainer must handle it." }] }`), then add it with
`github_add_labels` (`{ owner: "{{owner}}", repo: "{{repo}}", issue_number:
{{prNumber}}, labels: ["requires-human"] }`), and say so in your summary. If
label writes are denied, just say so in your summary. (It is a NOTIFICATION, not
a stop: nothing in the harness reads this label, so it neither holds the PR nor
needs removing by hand. It is also cleared by `dependabot-pr-merge` once a later
fix turns the checks green on a trivial update. The label that DOES hold a PR is
`lastlight-ignore`, which only a maintainer applies — never apply or remove it
yourself.)

OUTPUT: A brief summary of the root cause, exactly what you changed, the
local test/lint/typecheck results, and any checks you couldn't reproduce in the
sandbox (so a human knows what still needs confirming). Then the
`CI_FIX_COMPLETE:` marker on its own final line — the tag, a colon, then the
fields — exactly as the **fixing** skill specifies. The tag without its colon
and fields is not a marker and fails this phase.

If you learned something durable the marker has no field for — a repair you
verified does *not* work, a constraint this repo imposes — append one line per
item to `{{notesFile}}` first, per the **fixing** skill's "The journal". Writing
nothing is fine; it is not a log of what you did.
