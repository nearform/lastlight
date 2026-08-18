# Phase 1 — The base a fix merges is stale by design

**Risk: low.** About three lines of production code, reusing a function
that is already tested and already called on two other paths. No new
concepts, no schema change, no prompt dependency.

This is the highest-value change in the plan. Everything else makes a
stuck PR *recoverable*; this makes it *stuck less often*.

## The defect

A fix run merges the base branch as it stood when the run's **first phase**
provisioned its workspace — not as it stands when the merge happens.

`prePopulateWorkspace` (`apps/server/src/sandbox/index.ts:287`) is called
per phase, from `createTaskSandbox`. It has three paths:

| Path | Base ref refreshed? |
|---|---|
| Fresh clone (no `.git`) | ✅ `ensureBaseAvailable` at `:374` |
| Different run reusing the workspace | ✅ `refreshExistingClone` → `ensureBaseAvailable` at `:621` |
| **Same run, later phase** | ❌ **early `return` at `:319-324`, before any fetch** |

The same-run path exists for a good reason — "earlier phases may have
written uncommitted scratch here" — and it must not touch the working tree.
But it currently skips the base fetch along with everything else, and the
base fetch does not touch the working tree.

So for a multi-phase fix run, `refs/remotes/origin/<base>` is frozen for
the entire run. On `#1016` that was 31 minutes; `diagnose` alone accounted
for 6 of them.

## Why the prompt's own fetch does not save it

`workflows/prompts/dependabot-ci-fix.md` step 1 already instructs the
agent:

```
git fetch origin {{baseBranch}}
git merge --no-edit origin/{{baseBranch}}
```

That looks correct and is not. The clone is made with `--depth 50`
(`sandbox/index.ts:358`), and **`--depth` implies `--single-branch`** unless
`--no-single-branch` is passed — which it is not, because `shallowArgs` is
empty for non-shallow workflows and the depth flag does the implying on its
own. So `remote.origin.fetch` covers only the PR head branch.

Since Git 1.8.4, `git fetch origin <branch>` updates the remote-tracking
ref *opportunistically* — but only when the configured refspec would have
covered it. `<base>` is not covered here, so the fetch writes `FETCH_HEAD`
and leaves `refs/remotes/origin/<base>` **exactly as it was**. The very next
line then merges that stale ref.

`ensureBaseAvailable` gets this right, which is why the ref exists at all:
it fetches with an explicit destination refspec
(`+refs/heads/<base>:refs/remotes/origin/<base>`, `:485`). It is simply
never called again after the run's first phase.

## Evidence from `#1016`

- Workspace provisioned ~09:52. `origin/main` = `449996d3` (main as of
  02:05).
- `5dd5fd26` lands on `main` at 10:00:03 — inside the window.
- `fix_iter_1` merges at 10:08. Merge commit `921c375c`'s parents are
  `cd6fd571` and **`449996d3`**.
- Result: `ahead 5, behind 1`, still `dirty`.

Verify independently:

```bash
gh api repos/cliftonc/drizzle-cube/commits/921c375c --jq '[.parents[].sha[0:8]]'
gh api "repos/cliftonc/drizzle-cube/compare/main...renovate/typescript-7.x" \
  --jq '{status,ahead_by,behind_by}'
```

## The downstream damage

This is worse than "the fix didn't work", because a `dirty` PR is a **CI
blind spot**:

- GitHub cannot compute `refs/pull/N/merge` for a conflicting PR, so no
  `pull_request`-triggered workflow is created at all. Not failed —
  *absent*.
- Commit-status apps (GitGuardian, in this case) still report, because they
  key on the push, not on the merge ref.
- So `getChecksConclusion` sees one green status and returns `"passing"`.
  `settledCheckCount` falls from 11 to 1 and nothing treats that as a
  signal.
- The next sweep sees a green-looking, still-`dirty` PR and spends another
  fix cycle on it.

## The fix

### 1. Refresh the base ref on the same-run path (primary)

In `prePopulateWorkspace`, before the early `return` at `:323`, call
`ensureBaseAvailable`.

It is safe on this path — that is the whole argument, so state it in the
code comment. `ensureBaseAvailable` writes only
`refs/remotes/origin/<base>` and `refs/remotes/origin/<head>` and adjusts
shallow depth. It never touches `HEAD`, the index, or the working tree, so
it cannot disturb the uncommitted scratch the preserve path exists to
protect.

```ts
if (!pre.runId || lastRun === pre.runId) {
  // Preserve the checkout — but NOT the base ref. `origin/<base>` was
  // fetched when this run's FIRST phase provisioned, and the fix phase
  // merges it minutes later; on a repo taking several dependency bumps a
  // day the merge lands a base that is already superseded, leaving the PR
  // `dirty` and therefore un-buildable by GitHub (no merge ref → no
  // `pull_request` workflows at all). This writes remote-tracking refs
  // only — never HEAD, the index or the working tree — so it cannot
  // disturb the scratch this path exists to keep.
  ensureBaseAvailable(repoDir, pre, authArgs, url, scrub);
  console.log(
    `[sandbox] Pre-clone skipped: ${repoDir} already a git repo (same run); ` +
    `refreshed origin/${pre.baseBranch ?? "(none)"}.`,
  );
  return;
}
```

Note `ensureBaseAvailable` already no-ops when `pre.baseBranch` is unset,
equal to the head branch, or `recreateFromBase` is set (`:484`), so no
extra guard is needed.

### 2. Make the ref refreshable, so the prompt's fetch means something

Add the base to the fetch refspec once, at provision time:

```ts
git remote set-branches --add origin <base>
```

After this, `git fetch origin <base>` updates
`refs/remotes/origin/<base>` the way every reader expects, which makes the
agent's own step-1 fetch a real second line of defence rather than a no-op.

**Caution during execution:** plain `git fetch` into a shallow repository
has awkward depth semantics and can deepen further than intended. Keep the
existing explicit `--depth` handling in `ensureBaseAvailable` rather than
relying on a bare fetch, and verify the resulting `.git/shallow` in the
integration test below rather than assuming.

### 3. Harden the prompt (belt)

In `workflows/prompts/dependabot-ci-fix.md` step 1, merge the thing that
was just fetched rather than a ref that may not have moved:

```
git fetch origin {{baseBranch}}
git merge --no-edit FETCH_HEAD
```

`FETCH_HEAD` is unambiguous and correct regardless of refspec
configuration. Apply the same change to `workflows/prompts/pr-fix.md` if it
carries the same instruction.

### 4. Treat a check-count collapse as a signal (optional, same phase)

`PrState` already records `settledCheckCount`, and its own doc comment says
*"`passing` on its own is not evidence"*. Nothing acts on that today.

A PR whose settled-check count drops sharply against its own history — 11
to 1 — is almost always a PR GitHub has stopped building, which for a
dependency PR almost always means `dirty`. At minimum, the fix prompt
should be told the count so the agent stops reading "CI is green" off one
commit-status app. Deciding whether it should *gate* anything is out of
scope here; recording the reasoning is not.

## Tests

Unit, in `apps/server/tests/sandbox/` alongside the existing pre-clone
tests:

- Same-run reuse **calls** `ensureBaseAvailable`, and a base commit created
  after the first provision is reachable as `origin/<base>` on the second.
- Same-run reuse still preserves an uncommitted working-tree file and an
  uncommitted `.git/lastlight-verify.sh` — the property the early return
  exists for, which must not regress.
- `recreateFromBase` and "base equals head" still no-op.

Integration (opt-in, alongside `tests/sandbox/command-exec.integration.test.ts`):

- Provision, advance the origin's base branch, provision again for the same
  run, and assert `git merge origin/<base>` lands the newer commit.
- Assert the repository is still shallow afterwards and the depth has not
  silently escalated.

## Done when

- A fix phase merges the base as it stood when *that phase* started, not
  when the run started.
- Re-running the `#1016` shape — base advances mid-run — produces a merge
  commit whose second parent is the newer base tip.
- The prompt's `git fetch` is either load-bearing (fix 2) or bypassed by
  `FETCH_HEAD` (fix 3), and no longer silently does nothing.
