# Findings — `createCommitOnBranch`, measured 2026-08-07

Measured against a throwaway repo (`robinbowes/lastlight-sigtest`, since deleted)
with `gh` auth on a **user PAT**. Re-run the commands below to reproduce.

| Question | Verdict |
|---|---|
| `MODE_PRESERVED_ON_MODIFY` | **yes** — `100755` survived a content-only change |
| `SIGNATURE_IN_MUTATION_RESPONSE` | **populated** — `isValid`, `state`, `wasSignedByGitHub` all returned |
| `MAX_REQUEST_PAYLOAD` | **45 MB total request**, not per file (~33 MB of raw bytes after base64) |
| REST `git/commits` verification | `verified: false`, `reason: "unsigned"` |

Two things turned up that the plan did not ask about. Both are recorded below
because they change how the tool should behave, not just how it is built.

## 1. Mode is preserved on modify — the relaxation is justified

Base tree entry, pushed by ordinary `git`:

```
100755 blob fa3f85a717491e983714c66b955250a183606d75	run.sh
```

After `createCommitOnBranch` replaced only the *contents* (no mode field exists
in `FileAddition`):

```
100755 blob 5f526618fe579fd6d903b0ff2e804fcbb3907a3d	run.sh
```

The blob changed, the mode did not. GitHub patches the base tree and keeps the
existing entry's mode. So refusing a content-only change to an already-executable
file would be needless — **Task 5 Step 6's relaxation applies**: refuse only when
a mode would have to *change* (`dstMode !== PLAIN_FILE_MODE && dstMode !== srcMode`).

New executable files, new symlinks, submodule pointers, and genuine mode changes
remain inexpressible and must still be refused.

## 2. The signature is in the mutation response — the tool can self-assert

```json
"commit": {
  "oid": "cf9f9751279cbc35b52c4ddbe2364e062e52217e",
  "committer": { "name": "GitHub", "email": "noreply@github.com" },
  "signature": { "isValid": true, "state": "VALID", "wasSignedByGitHub": true }
}
```

No read-back call is needed. Task 5 Step 3's assertion stands as planned: the tool
checks `wasSignedByGitHub` on every publish and fails loudly if GitHub says it did
not sign.

## 3. REST really is unsigned — side by side, same repo, same token

```
REST  POST /repos/…/git/commits  → verified: false, reason: "unsigned"
GraphQL createCommitOnBranch     → verified: true,  reason: "valid"
```

This is the evidence for the correction in [`README.md`](README.md). The spec's
original mechanism would have shipped the feature and fixed nothing.

## 4. UNPLANNED — GitHub's own read-after-write lag causes spurious `STALE_DATA`

The size probe failed once with:

```
STALE_DATA: Expected branch to point to "cf9f9751…" but it did not.  Pull and try again.
```

Nothing else was pushing to that repo. The cause: a REST `GET /git/ref/heads/main`
issued moments after a successful GraphQL write returned the **pre-write** tip.
Six consecutive reads a few seconds later were all consistent, so it is transient
replication lag between GitHub's GraphQL write path and its REST read path.

**Why this matters.** `github_publish` reads the tip via REST `getRef` and writes
via GraphQL — exactly the cross-surface pattern that produced this. A publish
immediately following another publish on the same branch can therefore fail with
`STALE_DATA` even though no one raced us.

**Why it is still right to fail loudly.** Do *not* re-read the tip and retry.
The change set is computed as "working tree vs tip", so rebasing onto a tip that
genuinely moved would render every file the other party added as a **deletion** —
silently reverting their work. Failing loudly is correct for a real race, and a
retry cannot distinguish the two cases from the outside.

**What to do instead:** name the `STALE_DATA` case explicitly in the error so the
agent knows a re-run is likely to succeed, rather than reading a generic GraphQL
error and concluding the branch is broken. Follow-up for the tool's error text.

## 5. CAVEAT — `[bot]` attribution is NOT verified by this measurement

The committer came back `GitHub <noreply@github.com>` because these probes used a
**user PAT**. Under a GitHub App installation token the committer is expected to be
the App's `[bot]` identity — that is the premise of the whole spec, and of
[Asana/push-signed-commits](https://github.com/Asana/push-signed-commits) — but
**this measurement does not demonstrate it.** It cannot be checked without an App
installation token against a repo the App is installed on.

Treat the plan's acceptance criterion "authored by `nearform-lastlight[bot]`" as
**open** until someone runs a real workflow phase end to end.

## 6. The plan's own Task 1 commands were wrong

`gh api graphql -F input="{...}"` passes the JSON as a *string*, and GraphQL
rejects it: `Expected "…" to be a key-value object`. The working form builds a full
request body and pipes it in:

```bash
python3 - "$REPO" "$BR" "$OID" > /tmp/payload.json <<'PY'
import base64, json, sys
repo, br, oid = sys.argv[1:4]
q = """mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url committer { name email }
             signature { isValid state wasSignedByGitHub } }
  }
}"""
json.dump({"query": q, "variables": {"input": {
    "branch": {"repositoryNameWithOwner": repo, "branchName": br},
    "message": {"headline": "modify executable"},
    "expectedHeadOid": oid,
    "fileChanges": {"additions": [
        {"path": "run.sh", "contents": base64.b64encode(b"#!/bin/sh\necho v2\n").decode()}]},
}}}, sys.stdout)
PY
gh api graphql --input /tmp/payload.json
```

## Size probe, raw results

| Raw bytes | Request payload | Result |
|---|---|---|
| 1 MB | 1,398,514 B | OK |
| 4 MB | 5,592,818 B | OK |
| 16 MB | 22,370,035 B | OK |
| 40 MB | 55,924,467 B | `The request payload cannot be larger than 45MB` |

The limit is on the **whole request**, so it is the sum of every addition in one
publish, not a per-file cap. A `pnpm-lock.yaml` is single-digit MB, so ordinary
publishes are far under it; a phase that regenerates many large generated files
is the case that could approach it.
