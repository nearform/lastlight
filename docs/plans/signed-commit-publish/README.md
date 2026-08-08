# Signed commits via a publish helper

Issue [#268](https://github.com/nearform/lastlight/issues/268) and its
[spec comment](https://github.com/nearform/lastlight/issues/268#issuecomment-5193641020).

On repos enforcing GitHub's `required_signatures` branch-protection rule, every
commit Last Light produces is unsigned and therefore blocked. Every code-writing
workflow ends by running `git add -A && git commit && git push` inside the
sandbox, authenticated only by the `http.extraheader` token
(`apps/server/src/sandbox/sandbox.ts:212`). A locally-built commit object carries
no signature, so on a signature-enforcing repo the whole
build → review → fix → PR flow breaks at the *first* commit.

The fix: stop building the published commit locally. Have GitHub build it, and
sign it, on our behalf.

## Correction to the spec

**The spec's proposed mechanism does not sign.** It proposes generalizing
`GitHubClient.pushFiles()` (`packages/agentic-pi/src/extensions/github/client.ts:259`)
— `createBlob` → `createTree` → `createCommit` → `updateRef` — on the claim that
"GitHub applies its own web-flow signature server-side at `createCommit` time".

It does not. GitHub's REST reference for
[Create a commit](https://docs.github.com/en/rest/git/commits) documents
`signature` as an **input you supply**:

> The PGP signature of the commit. GitHub adds the signature to the `gpgsig`
> header of the created commit. […] To pass a `signature` parameter, you need to
> first manually create a valid PGP signature, which can be complicated.

So `pushFiles()` produces unsigned commits *today*, and generalizing it would
have shipped the entire feature while fixing nothing.

**The mechanism that does sign is the GraphQL `createCommitOnBranch` mutation**,
shipped in 2021
([changelog](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/))
specifically so GitHub Apps could push verified commits without holding a key.
GitHub signs the commit server-side and attributes it to the installation's
`[bot]` identity — which is exactly the spec's stated goal, reached by a
different API.

Everything else in the spec stands: no held key, no machine user, no host-side
shim, commits attributed to `nearform-lastlight[bot]`, one shared publish
primitive, fail loudly with no fallback to `git push`.

## What changes as a consequence

Three things fall out of the mechanism swap. All were verified against the live
GraphQL schema by introspection, not assumed.

### 1. The blob/tree dance disappears

`createCommitOnBranch` takes the whole change set in one mutation:

```graphql
mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url committer { name email } signature { isValid state wasSignedByGitHub } }
  }
}
```

with

```
CreateCommitOnBranchInput {
  branch: CommittableBranch!   # { repositoryNameWithOwner, branchName }
  message: CommitMessage!      # { headline, body }
  expectedHeadOid: GitObjectID!
  fileChanges: FileChanges     # { additions: [{path, contents}], deletions: [{path}] }
}
```

No `createBlob` fan-out, no `createTree`, no `updateRef`. The spec's "Key files
to modify" table shrinks accordingly.

### 2. The concurrent-tip race is answered, and mandatorily

`expectedHeadOid` is **non-null** — you cannot call the mutation without stating
the tip you expect. If the remote branch moved between our read and the write,
GitHub rejects it. The spec listed this as an open question ("refetch/rebase-and-
retry, or fail loudly?"); the API decides it for us, in favour of failing loudly.
There is no retry path to design.

### 3. `createCommitOnBranch` cannot express file modes

`FileAddition` has exactly two input fields — `path` and `contents` (base64).
There is no mode. So these changes are **inexpressible** through the signed path:

| Change | Why |
|---|---|
| New executable file (`100755`) | lands as `100644`; the `+x` bit is silently lost |
| Any symlink (`120000`) | would be committed as a regular file holding the target path |
| Any submodule pointer (`160000`) | gitlink entries have no blob to send |
| A mode *change* on an existing file | no field carries it |

This contradicts the spec's acceptance criterion verbatim — *"A working tree
containing added, modified, deleted, executable, and binary files publishes
correctly through the helper (tree matches the working dir)"*. Binary and
deleted files are fine. Executable is not.

**Resolution (decided):** a **pre-flight check that fails loudly**. The helper
diffs the working tree, detects any change requiring a mode it cannot express,
and refuses *before publishing anything*, naming the exact files. Atomic and
honest, consistent with the spec's no-silent-fallback rule. The cost is real: a
build phase that adds a shell script hard-stops and needs a human. That is the
correct trade against silently publishing a tree that differs from the one the
agent tested.

## Decisions

| Question | Decision |
|---|---|
| Signing mechanism | GraphQL `createCommitOnBranch`. **Corrects the spec.** |
| Publish surface | Pi tool `github_publish`, registered in `tools.ts`, gated to the `repo-write` profile. Gets the registration-time profile gate (agentic-pi hard rule #5) and the existing `safeRun` error shaping; adds no new CLI entry point. |
| Concurrent tip | Fail loudly. Not a choice — `expectedHeadOid` is required. |
| Mode gap | Pre-flight check, refuse before publishing, name the files. |
| Empty publish | No-op **success** with `published: false` and a reason. Prompts already branch on "there is nothing to commit or push" (`dependabot-ci-fix.md:149`); a hard failure there would turn a correct outcome into a phase failure. |
| Verification | The mutation returns the commit's `signature` in the same round trip. The tool asserts `wasSignedByGitHub` on **every** publish and fails loudly if absent — so the feature self-checks in production rather than relying on a one-off test. |
| `git-http-auth` / `agentGitIdentityEnv` | **Keep.** `clone` / `fetch` / `merge` still need the token, and the local scratch commits still need an identity. Narrowing it is a separate change with its own risk; out of scope here. |

## Plan

[`01-publish-helper.md`](01-publish-helper.md) — the task-by-task implementation
plan.
