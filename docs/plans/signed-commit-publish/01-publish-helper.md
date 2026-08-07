# Signed-commit publish helper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every commit Last Light publishes lands on GitHub `verified: true`,
attributed to the App bot, with no signing key anywhere.

**Architecture:** A new Pi tool `github_publish` replaces
`git commit && git push` as the final step of every code-writing prompt. It
diffs the working tree against the branch's current remote tip, refuses any
change whose file mode the API cannot express, and hands the whole change set to
GitHub's GraphQL `createCommitOnBranch` mutation — which builds the commit
server-side and signs it. Local git commits become scratch working state that
never leaves the sandbox.

**Tech Stack:** TypeScript (strict, ESM, `Node16` resolution — relative imports
keep their `.js` extensions), `@octokit/rest` (its `.graphql()` method),
`@sinclair/typebox` for tool schemas, `node:test` + `tsx` for agentic-pi tests,
`vitest` for `apps/server` tests, Biome for lint/format.

## Global Constraints

- **agentic-pi hard rule #5 — the profile gate is registration-time.** Add
  `github_publish` to `REPO_WRITE_TOOLS` in `profiles.ts`. Never add a runtime
  "is this allowed?" check.
- **agentic-pi hard rule #7 — the library path never writes to
  `process.stdout` / `process.stderr`.** No `console.*` anywhere in `src/`.
  Errors surface as thrown `Error`s; `safeRun` in `tools.ts` renders them.
- **agentic-pi hard rule #8 — the App PEM never enters the sandbox.** The tool
  uses the already-minted installation token via `auth.getToken()`. Nothing else.
- **agentic-pi hard rule #2 — don't change the JSONL event shape.** This work
  adds no events; `test/fixtures/*.jsonl` must stay byte-identical.
- Biome: 2-space indent, **line width 100**, double quotes, semicolons always.
  `npm run fix` auto-resolves formatting.
- Relative imports use `.js` extensions (`./worktree-diff.js` resolves to
  `worktree-diff.ts` at compile time). Dropping the extension breaks the build.
- No comment restates the code. Comments explain *why* — a constraint, a
  workaround, or an external reference.
- Every task ends with `npm run lint && npm run build && npm run test:unit`
  clean from `packages/agentic-pi/`.
- Conventional Commits. Branch: `feat/signed-commit-publish`.

---

### Task 1: Verify `createCommitOnBranch` behaviour against real GitHub

Three behaviours the rest of the plan depends on cannot be learned from the
schema or from a fake server. Measure them once, record the answers, and let
Tasks 3 and 5 read them off this file. Nothing else in the plan is blocked by
this task, so it can run in parallel with Task 2.

**Files:**
- Create: `docs/plans/signed-commit-publish/00-findings.md`

**Interfaces:**
- Consumes: nothing.
- Produces: three recorded verdicts —
  `MODE_PRESERVED_ON_MODIFY: yes | no`,
  `SIGNATURE_IN_MUTATION_RESPONSE: populated | null`,
  `MAX_OBSERVED_ADDITION_BYTES: <number>`.

- [ ] **Step 1: Create a scratch repo and a branch with a known executable file**

Use a throwaway repo you own. `gh repo create <you>/sigtest --private
--add-readme` if you need one.

```bash
REPO=<you>/sigtest
git clone "https://github.com/$REPO" /tmp/sigtest && cd /tmp/sigtest
printf '#!/bin/sh\necho v1\n' > run.sh && chmod +x run.sh
git add run.sh && git commit -m "add executable" && git push origin HEAD
git ls-tree HEAD run.sh   # expect: 100755 blob <sha>	run.sh
```

- [ ] **Step 2: Modify that file's contents through the mutation and read the resulting mode**

This is the question that decides Task 5. `createCommitOnBranch` has no mode
field; the open question is whether it *preserves* the mode already in the base
tree when only the contents change.

```bash
BR=main
OID=$(gh api "repos/$REPO/git/ref/heads/$BR" --jq .object.sha)
B64=$(printf '#!/bin/sh\necho v2\n' | base64)
gh api graphql -f query='
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url committer { name email }
             signature { isValid state wasSignedByGitHub } }
  }
}' -F input="{\"branch\":{\"repositoryNameWithOwner\":\"$REPO\",\"branchName\":\"$BR\"},\"message\":{\"headline\":\"modify executable\"},\"expectedHeadOid\":\"$OID\",\"fileChanges\":{\"additions\":[{\"path\":\"run.sh\",\"contents\":\"$B64\"}]}}"
git fetch origin "$BR" && git ls-tree FETCH_HEAD run.sh
```

Record `MODE_PRESERVED_ON_MODIFY: yes` if the mode is still `100755`, `no` if it
became `100644`.

- [ ] **Step 3: Record what `signature` contained in that mutation response**

Verification may be computed asynchronously, in which case `signature` comes back
`null` on the freshly created commit even though the commit is signed. Record
`SIGNATURE_IN_MUTATION_RESPONSE: populated` or `: null`. If it is `null`, also
run the read-back and record what it says:

```bash
NEW=$(gh api "repos/$REPO/git/ref/heads/$BR" --jq .object.sha)
gh api "repos/$REPO/commits/$NEW" --jq '.commit.verification'
```

- [ ] **Step 4: Confirm the REST path really is unsigned (the defect this fixes)**

Evidence that the spec's original mechanism does not work, captured once so
nobody re-litigates it:

```bash
OID=$(gh api "repos/$REPO/git/ref/heads/$BR" --jq .object.sha)
TREE=$(gh api "repos/$REPO/git/commits/$OID" --jq .tree.sha)
C=$(gh api -X POST "repos/$REPO/git/commits" -f message="rest path" \
      -f tree="$TREE" -f 'parents[]'="$OID" --jq .sha)
gh api "repos/$REPO/commits/$C" --jq '.commit.verification'
```

Expect `{"verified": false, "reason": "unsigned", ...}`.

- [ ] **Step 5: Probe the size ceiling with a lockfile-sized addition**

Real `pnpm-lock.yaml` files reach several MB and base64 adds ~33%. Find the point
where the mutation starts refusing:

```bash
for MB in 1 4 8 16; do
  head -c $((MB*1024*1024)) /dev/urandom | base64 -w0 > /tmp/big.b64
  OID=$(gh api "repos/$REPO/git/ref/heads/$BR" --jq .object.sha)
  gh api graphql -f query='mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid } } }' \
    -F input="{\"branch\":{\"repositoryNameWithOwner\":\"$REPO\",\"branchName\":\"$BR\"},\"message\":{\"headline\":\"size probe ${MB}MB\"},\"expectedHeadOid\":\"$OID\",\"fileChanges\":{\"additions\":[{\"path\":\"big.bin\",\"contents\":\"$(cat /tmp/big.b64)\"}]}}" \
    >/dev/null 2>&1 && echo "${MB}MB ok" || echo "${MB}MB REFUSED"
done
```

Record the largest size that succeeded as `MAX_OBSERVED_ADDITION_BYTES`.

- [ ] **Step 6: Write the findings file**

```markdown
# Findings — createCommitOnBranch, measured <YYYY-MM-DD>

Measured against `<repo>` with `gh` auth. Re-run the commands in
`01-publish-helper.md` Task 1 to reproduce.

| Question | Verdict |
|---|---|
| MODE_PRESERVED_ON_MODIFY | yes / no |
| SIGNATURE_IN_MUTATION_RESPONSE | populated / null |
| MAX_OBSERVED_ADDITION_BYTES | <n> |
| REST git/commits verification | verified=false, reason=unsigned |

<paste the raw command output under each>
```

- [ ] **Step 7: Delete the scratch repo and commit the findings**

```bash
gh repo delete <you>/sigtest --yes
cd /Users/robin/code/github.com/yo61/lastlight
git add docs/plans/signed-commit-publish/00-findings.md
git commit -m "docs(publish): record measured createCommitOnBranch behaviour"
```

---

### Task 2: Compute the change set between a commit and the working tree

The testable core, with zero GitHub knowledge: given a repo path and a base
commit OID, produce the additions, deletions, and the changes that cannot be
expressed. Separate file because it is pure git plumbing and deserves its own
tests against real repositories.

**Files:**
- Create: `packages/agentic-pi/src/extensions/github/worktree-diff.ts`
- Test: `packages/agentic-pi/test/extensions/github/worktree-diff.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface PublishAddition { path: string; contents: string }
  export interface PublishDeletion { path: string }
  export interface UnsupportedChange { path: string; reason: string }
  export interface WorktreeChangeSet {
    additions: PublishAddition[];
    deletions: PublishDeletion[];
    unsupported: UnsupportedChange[];
  }
  export function diffWorktreeAgainst(
    cwd: string, baseOid: string, exclude?: string[],
  ): WorktreeChangeSet
  export function hasLocalCommit(cwd: string, oid: string): boolean
  export function currentBranch(cwd: string): string
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/agentic-pi/test/extensions/github/worktree-diff.test.ts`:

```ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentBranch,
  diffWorktreeAgainst,
  hasLocalCommit,
} from "../../../src/extensions/github/worktree-diff.js";

/**
 * A real git repo in a temp dir. Mocking git here would test the mock — the
 * whole point of this module is that it agrees with git about what changed.
 */
function repo(): { dir: string; git: (...a: string[]) => string; base: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "worktree-diff-"));
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "keep.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  return { dir, git, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("diffWorktreeAgainst", () => {
  test("reports added, modified and deleted files against the base commit", () => {
    const r = repo();
    try {
      writeFileSync(join(r.dir, "keep.txt"), "two\n");
      writeFileSync(join(r.dir, "new.txt"), "hello\n");
      rmSync(join(r.dir, "keep.txt"));
      writeFileSync(join(r.dir, "keep.txt"), "two\n");
      rmSync(join(r.dir, "keep.txt"));
      writeFileSync(join(r.dir, "added.txt"), "x\n");
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.deepEqual(cs.deletions, [{ path: "keep.txt" }]);
      assert.deepEqual(
        cs.additions.map((a) => a.path).sort(),
        ["added.txt", "new.txt"],
      );
      assert.deepEqual(cs.unsupported, []);
    } finally {
      r.cleanup();
    }
  });

  test("base64-encodes binary content byte-for-byte", () => {
    const r = repo();
    try {
      const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f]);
      writeFileSync(join(r.dir, "blob.bin"), bytes);
      const cs = diffWorktreeAgainst(r.dir, r.base);
      const add = cs.additions.find((a) => a.path === "blob.bin");
      assert.ok(add);
      assert.deepEqual(Buffer.from(add.contents, "base64"), bytes);
    } finally {
      r.cleanup();
    }
  });

  test("picks up changes the agent already committed locally", () => {
    // Local commits are scratch state; the diff is against the REMOTE tip, so
    // a committed change must still show up as an addition.
    const r = repo();
    try {
      writeFileSync(join(r.dir, "committed.txt"), "c\n");
      r.git("add", "-A");
      r.git("commit", "-qm", "local scratch");
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.deepEqual(cs.additions.map((a) => a.path), ["committed.txt"]);
    } finally {
      r.cleanup();
    }
  });

  test("refuses a NEW executable file — the API cannot express 100755", () => {
    const r = repo();
    try {
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(r.dir, "run.sh"), 0o755);
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.deepEqual(cs.additions, []);
      assert.equal(cs.unsupported.length, 1);
      assert.equal(cs.unsupported[0].path, "run.sh");
      assert.match(cs.unsupported[0].reason, /100755/);
    } finally {
      r.cleanup();
    }
  });

  test("refuses a symlink", () => {
    const r = repo();
    try {
      symlinkSync("keep.txt", join(r.dir, "link.txt"));
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.equal(cs.unsupported.length, 1);
      assert.equal(cs.unsupported[0].path, "link.txt");
      assert.match(cs.unsupported[0].reason, /symlink/i);
    } finally {
      r.cleanup();
    }
  });

  test("honours exclude pathspecs and leaves the agent's real index alone", () => {
    const r = repo();
    try {
      mkdirSync(join(r.dir, ".lastlight"));
      writeFileSync(join(r.dir, ".lastlight", "plan.md"), "p\n");
      writeFileSync(join(r.dir, "src.txt"), "s\n");
      const cs = diffWorktreeAgainst(r.dir, r.base, [".lastlight"]);
      assert.deepEqual(cs.additions.map((a) => a.path), ["src.txt"]);
      // The real index must be untouched — the agent may still be working.
      assert.equal(r.git("status", "--porcelain", "--untracked-files=all").includes("A  "), false);
    } finally {
      r.cleanup();
    }
  });

  test("returns an empty change set when the tree matches the base", () => {
    const r = repo();
    try {
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.deepEqual(cs, { additions: [], deletions: [], unsupported: [] });
    } finally {
      r.cleanup();
    }
  });

  test("hasLocalCommit and currentBranch read the repo", () => {
    const r = repo();
    try {
      assert.equal(hasLocalCommit(r.dir, r.base), true);
      assert.equal(hasLocalCommit(r.dir, "0".repeat(40)), false);
      assert.equal(currentBranch(r.dir), "main");
    } finally {
      r.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/agentic-pi
npx tsx --test test/extensions/github/worktree-diff.test.ts
```

Expected: FAIL — `Cannot find module '.../worktree-diff.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/agentic-pi/src/extensions/github/worktree-diff.ts`:

```ts
/**
 * The change set a signed publish sends to GitHub.
 *
 * `createCommitOnBranch` takes files, not a tree: `{ additions: [{path,
 * contents}], deletions: [{path}] }`. So the publish path needs the difference
 * between a base commit and whatever is in the working directory right now —
 * including changes the agent already committed locally, because those local
 * commits are scratch state that never leaves the sandbox.
 *
 * The diff is computed through a TEMPORARY index (`GIT_INDEX_FILE`), so staging
 * the working tree here cannot disturb the index the agent is still using.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The only tree-entry mode `FileAddition` can express — it carries `path` and
 * base64 `contents`, and no mode. Anything else has to be refused rather than
 * silently published with the wrong bits (issue #268).
 */
const PLAIN_FILE_MODE = "100644";

const MODE_REASONS: Record<string, string> = {
  "100755": "executable (100755) — createCommitOnBranch cannot set file modes",
  "120000": "symlink (120000) — createCommitOnBranch would commit it as a regular file",
  "160000": "submodule pointer (160000) — createCommitOnBranch cannot write gitlinks",
};

export interface PublishAddition {
  path: string;
  /** base64 of the file's bytes — what `FileAddition.contents` wants. */
  contents: string;
}

export interface PublishDeletion {
  path: string;
}

export interface UnsupportedChange {
  path: string;
  reason: string;
}

export interface WorktreeChangeSet {
  additions: PublishAddition[];
  deletions: PublishDeletion[];
  unsupported: UnsupportedChange[];
}

function git(cwd: string, args: string[], indexFile?: string): Buffer {
  const env = indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env;
  return execFileSync("git", args, { cwd, env, stdio: "pipe", maxBuffer: 256 * 1024 * 1024 });
}

function gitText(cwd: string, args: string[], indexFile?: string): string {
  return git(cwd, args, indexFile).toString("utf8");
}

/** Is this commit object present in the local object store? */
export function hasLocalCommit(cwd: string, oid: string): boolean {
  try {
    git(cwd, ["cat-file", "-e", `${oid}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The checked-out branch name. Throws on a detached HEAD. */
export function currentBranch(cwd: string): string {
  const name = gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (name === "HEAD") {
    throw new Error("HEAD is detached — publish needs a branch; check one out first");
  }
  return name;
}

function reasonFor(srcMode: string, dstMode: string): string {
  const known = MODE_REASONS[dstMode];
  if (known) return known;
  return `mode ${srcMode} → ${dstMode} — createCommitOnBranch cannot set file modes`;
}

/**
 * Parse `git diff-tree -r -z` raw output. Records are
 * `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`.
 */
function* records(raw: string): Generator<{ srcMode: string; dstMode: string; dstSha: string; status: string; path: string }> {
  const parts = raw.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta) continue;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(meta);
    if (!m) throw new Error(`unparseable diff-tree record: ${meta}`);
    yield { srcMode: m[1]!, dstMode: m[2]!, dstSha: m[4]!, status: m[5]!, path: parts[i + 1]! };
  }
}

/**
 * Diff the working tree against `baseOid` and split the result into what the
 * signed publish path can send and what it must refuse.
 *
 * `exclude` takes git pathspecs (e.g. `.lastlight`) for build artifacts a phase
 * writes into the checkout but must not commit — mirroring the
 * `git reset -q -- .lastlight` the prompts used to run by hand.
 */
export function diffWorktreeAgainst(
  cwd: string,
  baseOid: string,
  exclude: string[] = [],
): WorktreeChangeSet {
  const scratch = mkdtempSync(join(tmpdir(), "agentic-pi-publish-"));
  const indexFile = join(scratch, "index");
  try {
    git(cwd, ["read-tree", baseOid], indexFile);
    git(cwd, ["add", "-A", "--", "."], indexFile);
    for (const spec of exclude) {
      git(cwd, ["reset", "-q", baseOid, "--", spec], indexFile);
    }
    const tree = gitText(cwd, ["write-tree"], indexFile).trim();
    const raw = gitText(cwd, ["diff-tree", "-r", "--no-renames", "-z", baseOid, tree], indexFile);

    const additions: PublishAddition[] = [];
    const deletions: PublishDeletion[] = [];
    const unsupported: UnsupportedChange[] = [];

    for (const rec of records(raw)) {
      if (rec.status === "D") {
        deletions.push({ path: rec.path });
        continue;
      }
      if (rec.dstMode !== PLAIN_FILE_MODE) {
        unsupported.push({ path: rec.path, reason: reasonFor(rec.srcMode, rec.dstMode) });
        continue;
      }
      additions.push({
        path: rec.path,
        contents: git(cwd, ["cat-file", "blob", rec.dstSha]).toString("base64"),
      });
    }
    return { additions, deletions, unsupported };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/agentic-pi
npx tsx --test test/extensions/github/worktree-diff.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the tests catch failures**

Change `PLAIN_FILE_MODE` to `"100755"` and re-run — the executable and symlink
tests must fail. Change `["add", "-A", "--", "."]` to `["add", "."]` and re-run —
the deletion test must fail. Revert both.

- [ ] **Step 6: Lint, build, commit**

```bash
cd packages/agentic-pi && npm run fix && npm run lint && npm run build && npm run test:unit
cd /Users/robin/code/github.com/yo61/lastlight
git add packages/agentic-pi/src/extensions/github/worktree-diff.ts \
        packages/agentic-pi/test/extensions/github/worktree-diff.test.ts
git commit -m "feat(github): compute the publish change set from the working tree"
```

---

### Task 3: Create signed commits through the GraphQL mutation

**Files:**
- Modify: `packages/agentic-pi/src/extensions/github/client.ts` (add two methods
  after `pushFiles`, which ends at `:321`)
- Test: `packages/agentic-pi/test/extensions/github/publish-client.test.ts`

**Interfaces:**
- Consumes: `PublishAddition`, `PublishDeletion` from Task 2.
- Produces:
  ```ts
  export interface SignedCommit {
    oid: string;
    url: string;
    committer: { name: string; email: string } | null;
    signature: { isValid: boolean; state: string; wasSignedByGitHub: boolean } | null;
  }
  // on GitHubClient:
  async getBranchTip(owner: string, repo: string, branch: string): Promise<string | null>
  async publishSignedCommit(opts: {
    owner: string; repo: string; branch: string; expectedHeadOid: string;
    headline: string; body?: string;
    additions: PublishAddition[]; deletions: PublishDeletion[];
  }): Promise<SignedCommit>
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/agentic-pi/test/extensions/github/publish-client.test.ts`:

```ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { GitHubClient } from "../../../src/extensions/github/client.js";
import type { GitHubAuth } from "../../../src/extensions/github/auth.js";

const staticAuth: GitHubAuth = { getToken: async () => "test-token", expiresAt: null, canRefresh: false };

/** A fake GitHub that records the GraphQL bodies it was sent. */
function graphqlServer(reply: unknown, status = 200): Promise<{
  url: string;
  bodies: any[];
  close: () => Promise<void>;
}> {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      bodies.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        bodies,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const OK_COMMIT = {
  data: {
    createCommitOnBranch: {
      commit: {
        oid: "abc123",
        url: "https://github.com/o/r/commit/abc123",
        committer: { name: "bot", email: "bot@users.noreply.github.com" },
        signature: { isValid: true, state: "VALID", wasSignedByGitHub: true },
      },
    },
  },
};

describe("publishSignedCommit", () => {
  test("sends one createCommitOnBranch mutation with the change set and expected tip", async () => {
    const fake = await graphqlServer(OK_COMMIT);
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const commit = await client.publishSignedCommit({
        owner: "o",
        repo: "r",
        branch: "feat/x",
        expectedHeadOid: "deadbeef",
        headline: "fix: thing",
        body: "why",
        additions: [{ path: "a.txt", contents: "eA==" }],
        deletions: [{ path: "b.txt" }],
      });

      assert.equal(commit.oid, "abc123");
      assert.equal(commit.signature?.wasSignedByGitHub, true);

      assert.equal(fake.bodies.length, 1);
      const input = fake.bodies[0].body.variables.input;
      assert.deepEqual(input.branch, { repositoryNameWithOwner: "o/r", branchName: "feat/x" });
      assert.equal(input.expectedHeadOid, "deadbeef");
      assert.deepEqual(input.message, { headline: "fix: thing", body: "why" });
      assert.deepEqual(input.fileChanges.additions, [{ path: "a.txt", contents: "eA==" }]);
      assert.deepEqual(input.fileChanges.deletions, [{ path: "b.txt" }]);
      // The signature must be selected, or the tool cannot verify its own work.
      assert.match(fake.bodies[0].body.query, /wasSignedByGitHub/);
    } finally {
      await fake.close();
    }
  });

  test("surfaces a GraphQL error instead of returning a commit", async () => {
    const fake = await graphqlServer({
      data: { createCommitOnBranch: null },
      errors: [{ message: "Expected branch to point to \"old\" but it did not." }],
    });
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      await assert.rejects(
        () =>
          client.publishSignedCommit({
            owner: "o",
            repo: "r",
            branch: "main",
            expectedHeadOid: "stale",
            headline: "x",
            additions: [],
            deletions: [],
          }),
        /Expected branch to point to/,
      );
    } finally {
      await fake.close();
    }
  });
});

describe("getBranchTip", () => {
  test("returns the sha when the branch exists", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: { sha: "tip123" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: `http://127.0.0.1:${port}` });
      assert.equal(await client.getBranchTip("o", "r", "main"), "tip123");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("returns null on 404 rather than throwing — a new branch is not an error", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "Not Found" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: `http://127.0.0.1:${port}` });
      assert.equal(await client.getBranchTip("o", "r", "nope"), null);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/agentic-pi
npx tsx --test test/extensions/github/publish-client.test.ts
```

Expected: FAIL — `client.publishSignedCommit is not a function`.

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `client.ts`:

```ts
import type { PublishAddition, PublishDeletion } from "./worktree-diff.js";
```

Add above `export interface GitHubClientOptions` (around `:136`):

```ts
/**
 * The commit `createCommitOnBranch` built for us. `signature` is what makes the
 * whole exercise worth doing — a locally-built commit object can never be
 * `verified` under the App's `[bot]` identity (issue #268).
 */
export interface SignedCommit {
  oid: string;
  url: string;
  committer: { name: string; email: string } | null;
  signature: { isValid: boolean; state: string; wasSignedByGitHub: boolean } | null;
}

const CREATE_COMMIT_ON_BRANCH = `
mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      url
      committer { name email }
      signature { isValid state wasSignedByGitHub }
    }
  }
}`;
```

Add these two methods immediately after `pushFiles` (which ends at `:321`):

```ts
  /**
   * The branch's current remote tip, or null if the branch does not exist.
   * A missing branch is an ordinary state on the first publish of a new
   * feature branch, so it is not an error.
   */
  async getBranchTip(owner: string, repo: string, branch: string): Promise<string | null> {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      try {
        const { data } = await ok.git.getRef({ owner, repo, ref: `heads/${branch}` });
        return data.object.sha;
      } catch (err) {
        if (((err as MaybeHttpError).status ?? (err as MaybeHttpError).response?.status) === 404) {
          return null;
        }
        throw err;
      }
    });
  }

  /**
   * Create a commit GitHub signs for us.
   *
   * The REST Git Data API does NOT sign what it creates — its `signature` field
   * is an input you supply, so `pushFiles()` above produces unsigned commits.
   * This GraphQL mutation is the only path that yields `verified: true` under a
   * GitHub App installation token, with no key held anywhere (issue #268).
   *
   * `expectedHeadOid` is non-null by schema: if the branch moved since we read
   * its tip, GitHub rejects the mutation rather than clobbering the other push.
   * That is the concurrency story — there is no retry to write.
   */
  async publishSignedCommit(opts: {
    owner: string;
    repo: string;
    branch: string;
    expectedHeadOid: string;
    headline: string;
    body?: string;
    additions: PublishAddition[];
    deletions: PublishDeletion[];
  }): Promise<SignedCommit> {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const data = await ok.graphql<{ createCommitOnBranch: { commit: SignedCommit } }>(
        CREATE_COMMIT_ON_BRANCH,
        {
          input: {
            branch: {
              repositoryNameWithOwner: `${opts.owner}/${opts.repo}`,
              branchName: opts.branch,
            },
            message: opts.body
              ? { headline: opts.headline, body: opts.body }
              : { headline: opts.headline },
            expectedHeadOid: opts.expectedHeadOid,
            fileChanges: { additions: opts.additions, deletions: opts.deletions },
          },
        },
      );
      return data.createCommitOnBranch.commit;
    });
  }
```

`withRetry` keys on `RETRYABLE_STATUSES` (`:32`), which a `GraphqlResponseError`
does not carry — so transport 5xx retry and a rejected `expectedHeadOid` fails
immediately. That is the behaviour we want; do not widen it.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/agentic-pi
npx tsx --test test/extensions/github/publish-client.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd packages/agentic-pi && npm run fix && npm run lint && npm run build && npm run test:unit
cd /Users/robin/code/github.com/yo61/lastlight
git add packages/agentic-pi/src/extensions/github/client.ts \
        packages/agentic-pi/test/extensions/github/publish-client.test.ts
git commit -m "feat(github): create signed commits via createCommitOnBranch"
```

---

### Task 4: Register the `github_publish` tool

**Files:**
- Modify: `packages/agentic-pi/src/extensions/github/tools.ts` (add after
  `github_push_files`, `:214-226`)
- Modify: `packages/agentic-pi/src/extensions/github/profiles.ts` (`:76-84`)
- Test: `packages/agentic-pi/test/extensions/github/publish-tool.test.ts`

**Interfaces:**
- Consumes: `diffWorktreeAgainst`, `currentBranch`, `hasLocalCommit` (Task 2);
  `getBranchTip`, `publishSignedCommit`, `SignedCommit` (Task 3).
- Produces: the tool's JSON result shape —
  ```ts
  { published: true, commit, url, branch, verified, committer,
    added: string[], modified: string[], deleted: string[], local_sync: string }
  | { published: false, reason: string }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/agentic-pi/test/extensions/github/publish-tool.test.ts`:

```ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGitHubTools } from "../../../src/extensions/github/tools.js";
import { PROFILE_TOOLS } from "../../../src/extensions/github/profiles.js";
import type { GitHubAuth } from "../../../src/extensions/github/auth.js";

const staticAuth: GitHubAuth = { getToken: async () => "test-token", expiresAt: null, canRefresh: false };

/** Serves getRef for `main` and accepts the publish mutation. */
function fakeGitHub(tip: string): Promise<{ url: string; mutations: any[]; close: () => Promise<void> }> {
  const mutations: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/graphql")) {
        mutations.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end(
          JSON.stringify({
            data: {
              createCommitOnBranch: {
                commit: {
                  oid: "newoid",
                  url: "https://github.com/o/r/commit/newoid",
                  committer: { name: "bot", email: "b@e" },
                  signature: { isValid: true, state: "VALID", wasSignedByGitHub: true },
                },
              },
            },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ object: { sha: tip } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        mutations,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function repo(): { dir: string; base: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "publish-tool-"));
  const g = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
    });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  return { dir, base: g("rev-parse", "HEAD").trim(), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function callPublish(baseUrl: string, params: unknown): Promise<any> {
  const tool = buildGitHubTools(staticAuth, { baseUrl }).find((t) => t.name === "github_publish");
  assert.ok(tool, "github_publish is not registered");
  const r = (await (tool as any).execute("call-1", params)) as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0]!.text);
}

describe("github_publish", () => {
  test("is registered only in the repo-write profile", () => {
    assert.ok(PROFILE_TOOLS["repo-write"].includes("github_publish"));
    for (const p of ["read", "issues-write", "review-write"] as const) {
      assert.ok(!PROFILE_TOOLS[p].includes("github_publish"), `${p} must not allow publishing`);
    }
  });

  test("publishes the working tree and reports the verified commit", async () => {
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      writeFileSync(join(r.dir, "b.txt"), "new\n");
      const out = await callPublish(fake.url, {
        owner: "o",
        repo: "r",
        message: "fix: thing\n\nbody line",
        path: r.dir,
      });
      assert.equal(out.published, true);
      assert.equal(out.commit, "newoid");
      assert.equal(out.verified, true);
      assert.deepEqual(out.added.concat(out.modified).sort(), ["a.txt", "b.txt"]);

      const input = fake.mutations[0].variables.input;
      assert.equal(input.expectedHeadOid, r.base);
      assert.deepEqual(input.message, { headline: "fix: thing", body: "body line" });
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("reports a no-op instead of failing when nothing changed", async () => {
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      const out = await callPublish(fake.url, { owner: "o", repo: "r", message: "m", path: r.dir });
      assert.equal(out.published, false);
      assert.match(out.reason, /nothing to publish/i);
      assert.equal(fake.mutations.length, 0);
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("refuses BEFORE publishing when a change needs an inexpressible mode", async () => {
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(r.dir, "run.sh"), 0o755);
      const out = await callPublish(fake.url, { owner: "o", repo: "r", message: "m", path: r.dir });
      assert.ok(out.error, "expected a structured error");
      assert.match(out.error, /run\.sh/);
      assert.match(out.error, /100755/);
      // Nothing may reach GitHub — the refusal is atomic.
      assert.equal(fake.mutations.length, 0);
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("never falls back to git push", async () => {
    // The whole point: a failure must surface, not quietly publish unsigned.
    const r = repo();
    const fake = await fakeGitHub("some-other-tip");
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      const out = await callPublish(fake.url, { owner: "o", repo: "r", message: "m", path: r.dir });
      // The tip we were told is not in the local object store, so the tool must
      // stop rather than guess a base.
      assert.ok(out.error);
      assert.match(out.error, /some-other-tip/);
    } finally {
      await fake.close();
      r.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/agentic-pi
npx tsx --test test/extensions/github/publish-tool.test.ts
```

Expected: FAIL — `github_publish is not registered`.

- [ ] **Step 3: Add the tool to `profiles.ts`**

In `REPO_WRITE_TOOLS` (`:76-84`), add `"github_publish"` after
`"github_push_files"`:

```ts
const REPO_WRITE_TOOLS = [
  ...REVIEW_WRITE_TOOLS,
  "github_clone_repo",
  "github_create_or_update_file",
  "github_push_files",
  "github_publish",
  "github_create_branch",
  "github_merge_pull_request",
  "github_enable_auto_merge",
] as const;
```

- [ ] **Step 4: Register the tool in `tools.ts`**

Add to the imports:

```ts
import { currentBranch, diffWorktreeAgainst, hasLocalCommit } from "./worktree-diff.js";
```

Insert immediately after the `github_push_files` registration (`:226`):

```ts
    tool(
      "github_publish",
      "Publish your work: commit the whole working tree and push it, in one step, as a SIGNED commit. Use this INSTEAD of `git add`/`git commit`/`git push` — a commit built by git in this sandbox is unsigned, and a repository that requires signed commits blocks it permanently. GitHub builds and signs the commit for you, attributed to the bot. Local commits you already made are folded in; the published commit is the working tree as it stands now. Fails rather than publishing if a change needs a file mode it cannot express (a new executable file, a symlink, a submodule pointer) — do not work around that with `git push`.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        message: Type.String({
          description: "Commit message. First line is the headline; anything after a blank line is the body.",
        }),
        branch: Type.Optional(
          Type.String({ description: "Branch to publish to (default: the checked-out branch)" }),
        ),
        base_branch: Type.Optional(
          Type.String({
            description: "If the branch does not exist on GitHub yet, create it from this one (default: the repo's default branch)",
          }),
        ),
        path: Type.Optional(
          Type.String({ description: "Path to the git working tree (default: the current directory)" }),
        ),
        exclude: Type.Optional(
          Type.Array(Type.String(), {
            description: 'Pathspecs to leave out of the commit, e.g. ".lastlight"',
          }),
        ),
      }),
      async ({ owner, repo, message, branch, base_branch, path: repoPath, exclude }) => {
        const cwd = repoPath || process.cwd();
        const target = branch || currentBranch(cwd);

        let tip = await gh.getBranchTip(owner, repo, target);
        if (tip === null) {
          const from = base_branch || (await gh.getRepository(owner, repo)).default_branch;
          await gh.createBranch(owner, repo, target, from);
          tip = await gh.getBranchTip(owner, repo, target);
          if (tip === null) throw new Error(`created ${target} but could not read its tip back`);
        }

        // The diff needs the remote tip in the local object store. A shallow
        // clone may not have it; fetching by sha is cheap and precise.
        if (!hasLocalCommit(cwd, tip)) {
          const token = await auth.getToken();
          try {
            execFileSync("git", ["fetch", "--depth=1", "origin", tip], {
              cwd,
              stdio: "pipe",
              timeout: 120_000,
              env: { ...process.env, ...gitAuthEnv(token), GIT_TERMINAL_PROMPT: "0" },
            });
          } catch {
            // fall through to the check below with a message naming the sha
          }
        }
        if (!hasLocalCommit(cwd, tip)) {
          throw new Error(
            `the remote tip of ${target} (${tip}) is not in this clone and could not be fetched — someone else has pushed. Re-run the phase against the current branch; do NOT git push.`,
          );
        }

        const changes = diffWorktreeAgainst(cwd, tip, exclude ?? []);
        if (changes.unsupported.length > 0) {
          const listed = changes.unsupported.map((u) => `${u.path}: ${u.reason}`).join("; ");
          throw new Error(
            `refusing to publish — ${changes.unsupported.length} change(s) need a file mode the signed-commit API cannot set: ${listed}. Nothing was published. Do NOT fall back to git push (it would produce an unsigned commit); flag this for a human.`,
          );
        }
        if (changes.additions.length === 0 && changes.deletions.length === 0) {
          return { published: false, reason: "nothing to publish — the working tree matches the branch" };
        }

        const [headline, ...rest] = message.split("\n");
        const body = rest.join("\n").trim();
        const commit = await gh.publishSignedCommit({
          owner,
          repo,
          branch: target,
          expectedHeadOid: tip,
          headline: (headline ?? "").trim() || message.trim(),
          ...(body ? { body } : {}),
          additions: changes.additions,
          deletions: changes.deletions,
        });

        return {
          published: true,
          commit: commit.oid,
          url: commit.url,
          branch: target,
          verified: commit.signature?.wasSignedByGitHub ?? null,
          committer: commit.committer,
          added: changes.additions.map((a) => a.path),
          deleted: changes.deletions.map((d) => d.path),
        };
      },
    ),
```

The `added` / `modified` split the test asserts comes in Step 5; land the tool
first and let that test fail on the split alone.

- [ ] **Step 5: Split added vs modified so the result reads honestly**

`diffWorktreeAgainst` knows which paths existed in the base tree. Extend
`PublishAddition` in `worktree-diff.ts` with the status git already gave us:

```ts
export interface PublishAddition {
  path: string;
  contents: string;
  /** `A` for a file that did not exist at the base, `M` for a change. */
  status: "A" | "M";
}
```

In the `records` loop, replace the `additions.push` call with:

```ts
      additions.push({
        path: rec.path,
        contents: git(cwd, ["cat-file", "blob", rec.dstSha]).toString("base64"),
        status: rec.status === "A" ? "A" : "M",
      });
```

In `client.ts`'s `publishSignedCommit`, strip the field before it reaches
GraphQL — `FileAddition` rejects unknown inputs:

```ts
            fileChanges: {
              additions: opts.additions.map((a) => ({ path: a.path, contents: a.contents })),
              deletions: opts.deletions,
            },
```

In the tool's return value, replace the single `added` key with:

```ts
          added: changes.additions.filter((a) => a.status === "A").map((a) => a.path),
          modified: changes.additions.filter((a) => a.status === "M").map((a) => a.path),
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd packages/agentic-pi
npx tsx --test test/extensions/github/publish-tool.test.ts
npx tsx --test test/extensions/github/worktree-diff.test.ts
npx tsx --test test/extensions/github/publish-client.test.ts
```

Expected: all PASS. The existing `tools.test.ts` "every name in every profile
resolves to a registered tool" test also covers the new profile entry — run the
full unit suite.

- [ ] **Step 7: Commit**

```bash
cd packages/agentic-pi && npm run fix && npm run lint && npm run build && npm run test:unit
cd /Users/robin/code/github.com/yo61/lastlight
git add packages/agentic-pi/src/extensions/github/ packages/agentic-pi/test/extensions/github/
git commit -m "feat(github): add the github_publish tool for signed commits"
```

---

### Task 5: Sync the local repo to the published commit, and assert the signature

Two loose ends from Task 4: after publishing, local `HEAD` is behind the branch
it just wrote (confusing for any later `git status` / `git log` the agent runs),
and the tool reports `verified` without acting on it.

**Files:**
- Modify: `packages/agentic-pi/src/extensions/github/tools.ts` (the
  `github_publish` handler)
- Modify: `packages/agentic-pi/test/extensions/github/publish-tool.test.ts`

**Interfaces:**
- Consumes: the Task 4 result shape.
- Produces: adds `local_sync: "ok" | "skipped: <reason>"` to the success result.

**Precondition:** read `MODE_PRESERVED_ON_MODIFY` and
`SIGNATURE_IN_MUTATION_RESPONSE` from `00-findings.md` (Task 1).

- [ ] **Step 1: Write the failing tests**

Append to `publish-tool.test.ts`:

```ts
describe("github_publish local sync", () => {
  test("moves the local branch onto the published commit without touching files", async () => {
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      const out = await callPublish(fake.url, { owner: "o", repo: "r", message: "m", path: r.dir });
      assert.equal(out.published, true);
      // No `origin` remote in this temp repo, so the fetch cannot succeed —
      // the tool must report that, not throw, and must leave the file alone.
      assert.match(out.local_sync, /^skipped: /);
      assert.equal(
        execFileSync("cat", [join(r.dir, "a.txt")], { encoding: "utf8" }),
        "two\n",
      );
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("fails loudly when GitHub did not sign the commit it created", async () => {
    const r = repo();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/graphql")) {
          res.end(
            JSON.stringify({
              data: {
                createCommitOnBranch: {
                  commit: {
                    oid: "unsignedoid",
                    url: "u",
                    committer: null,
                    signature: { isValid: false, state: "UNSIGNED", wasSignedByGitHub: false },
                  },
                },
              },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ object: { sha: r.base } }));
      });
    });
    await new Promise<void>((res2) => server.listen(0, "127.0.0.1", () => res2()));
    const { port } = server.address() as AddressInfo;
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      const out = await callPublish(`http://127.0.0.1:${port}`, {
        owner: "o",
        repo: "r",
        message: "m",
        path: r.dir,
      });
      assert.ok(out.error);
      assert.match(out.error, /unsignedoid/);
      assert.match(out.error, /did not sign/i);
    } finally {
      await new Promise<void>((res2) => server.close(() => res2()));
      r.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/agentic-pi
npx tsx --test test/extensions/github/publish-tool.test.ts
```

Expected: FAIL — `out.local_sync` is `undefined`; the unsigned case returns
`published: true` instead of an error.

- [ ] **Step 3: Assert the signature**

In the `github_publish` handler, immediately after the `publishSignedCommit`
call:

```ts
        // The mutation is the only thing standing between us and an unsigned
        // commit on a `required_signatures` repo. If GitHub says it did not
        // sign, say so loudly — the commit is already on the branch, so a
        // silent `verified: false` would be discovered by a blocked PR hours
        // later. `null` means GitHub returned no signature yet, not a failure.
        if (commit.signature && !commit.signature.wasSignedByGitHub) {
          throw new Error(
            `published ${commit.oid} but GitHub did not sign it (state=${commit.signature.state}). A repository requiring signed commits will block it. Do not retry — report this.`,
          );
        }
```

If Task 1 recorded `SIGNATURE_IN_MUTATION_RESPONSE: null`, change the selection
in `CREATE_COMMIT_ON_BRANCH` to drop `signature` and instead read it back with
`gh.getCommit`-style REST verification — and update this comment to say why.

- [ ] **Step 4: Sync the local branch**

Add just before the `return`:

```ts
        // Local HEAD is now behind the branch we just wrote. `reset --mixed`
        // moves the branch ref and the index onto the published commit and
        // leaves every file untouched — sound precisely because the published
        // tree IS the working tree. Best effort: a failed sync does not
        // un-publish anything, so it is reported, never thrown.
        let localSync = "ok";
        try {
          const token = await auth.getToken();
          execFileSync("git", ["fetch", "origin", target], {
            cwd,
            stdio: "pipe",
            timeout: 120_000,
            env: { ...process.env, ...gitAuthEnv(token), GIT_TERMINAL_PROMPT: "0" },
          });
          execFileSync("git", ["reset", "--mixed", commit.oid], { cwd, stdio: "pipe" });
        } catch (err) {
          localSync = `skipped: ${(err as Error).message.split("\n")[0]}`;
        }
```

and add `local_sync: localSync` to the returned object.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd packages/agentic-pi
npx tsx --test test/extensions/github/publish-tool.test.ts
```

Expected: PASS.

- [ ] **Step 6: Relax the mode rule if Task 1 confirmed preservation**

**Only if `00-findings.md` records `MODE_PRESERVED_ON_MODIFY: yes`.** A file that
is already `100755` on the branch and whose *contents* change keeps its mode
through the mutation, so refusing it is needless. In `worktree-diff.ts`, replace
the mode gate:

```ts
      // A mode we cannot set is only a problem when it would have to CHANGE.
      // GitHub preserves the base tree's mode for a path we merely re-add
      // (measured — see docs/plans/signed-commit-publish/00-findings.md).
      if (rec.dstMode !== PLAIN_FILE_MODE && rec.dstMode !== rec.srcMode) {
        unsupported.push({ path: rec.path, reason: reasonFor(rec.srcMode, rec.dstMode) });
        continue;
      }
```

and add a test to `worktree-diff.test.ts`:

```ts
  test("allows a content change to an already-executable file", () => {
    const r = repo();
    try {
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\necho v1\n");
      chmodSync(join(r.dir, "run.sh"), 0o755);
      r.git("add", "-A");
      r.git("commit", "-qm", "exec");
      const base = r.git("rev-parse", "HEAD").trim();
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\necho v2\n");
      const cs = diffWorktreeAgainst(r.dir, base);
      assert.deepEqual(cs.unsupported, []);
      assert.deepEqual(cs.additions.map((a) => a.path), ["run.sh"]);
    } finally {
      r.cleanup();
    }
  });
```

If Task 1 recorded `no`, **skip this step** and add a line to `00-findings.md`
recording that the strict rule stands because modes are not preserved.

- [ ] **Step 7: Commit**

```bash
cd packages/agentic-pi && npm run fix && npm run lint && npm run build && npm run test:unit
cd /Users/robin/code/github.com/yo61/lastlight
git add packages/agentic-pi/
git commit -m "feat(github): sync the local branch and assert the signature after publish"
```

---

### Task 6: Document the tool in the agentic-pi README

`README.md` is the contract with the orchestrator, and this changes user-visible
behaviour (a new tool in the `repo-write` profile). Per
`packages/agentic-pi/CLAUDE.md`, that is exactly when the README must move.

**Files:**
- Modify: `packages/agentic-pi/README.md`

**Interfaces:**
- Consumes: the tool surface from Tasks 4–5.
- Produces: nothing code-facing.

- [ ] **Step 1: Find the GitHub-tools section**

```bash
rg -n "github_push_files|repo-write" packages/agentic-pi/README.md
```

- [ ] **Step 2: Add `github_publish` to the tool table**

Insert a row next to `github_push_files`, keeping the table's existing columns:

```markdown
| `github_publish` | repo-write | Commit the working tree and push it as one **signed** commit (GraphQL `createCommitOnBranch`). Replaces `git add && git commit && git push`. |
```

- [ ] **Step 3: Add a short section explaining why it exists**

```markdown
### Publishing signed commits

A commit built by `git` inside a sandbox is unsigned. On a repository with
GitHub's `required_signatures` rule, an unsigned commit anywhere in a branch
blocks the pull request permanently — and no token fixes that, because the token
authenticates the *push* while a signature is a property of the *commit object*.

`github_publish` sidesteps it: it diffs the working tree against the branch's
current remote tip and hands the change set to GitHub's `createCommitOnBranch`
mutation, which builds and signs the commit server-side under the App's bot
identity. No key is held anywhere.

Two consequences worth knowing:

- **It refuses changes it cannot express.** `FileAddition` carries a path and
  base64 contents, and no file mode, so a new executable file, a symlink, or a
  submodule pointer update is rejected *before* anything is published. Falling
  back to `git push` would defeat the point, so the tool never does.
- **It is race-safe by construction.** `expectedHeadOid` is required, so if the
  branch moved since the tool read its tip, GitHub rejects the write instead of
  clobbering the other push.
```

- [ ] **Step 4: Commit**

```bash
git add packages/agentic-pi/README.md
git commit -m "docs(agentic-pi): document github_publish"
```

---

### Task 7: Switch `dependabot-ci-fix` to the publish helper

The spec's designated first caller. One prompt, one test, so the mechanism gets
exercised end-to-end on the narrowest workflow before it spreads.

**Files:**
- Modify: `apps/server/workflows/prompts/dependabot-ci-fix.md:128-133`
- Test: `apps/server/tests/workflows/dependabot-ci-fix.test.ts`

**Interfaces:**
- Consumes: the `github_publish` tool surface.
- Produces: nothing code-facing.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/tests/workflows/dependabot-ci-fix.test.ts` (it already
imports `loadPromptTemplate` from `#src/workflows/loader.js`):

```ts
describe("dependabot-ci-fix — the publish step", () => {
  it("publishes through github_publish, not git push", async () => {
    const prompt = await loadPromptTemplate("prompts/dependabot-ci-fix.md");
    expect(prompt).toContain("github_publish");
    // A sandbox-built commit is unsigned, and one unsigned commit anywhere in
    // the branch blocks a required_signatures PR permanently (issue #268).
    expect(prompt).not.toContain("git push origin HEAD");
  });

  it("tells the agent not to work around a refused publish", async () => {
    const prompt = await loadPromptTemplate("prompts/dependabot-ci-fix.md");
    expect(prompt).toMatch(/do NOT (fall back to |work around)/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter lastlight-core exec vitest run tests/workflows/dependabot-ci-fix.test.ts
```

Expected: FAIL — the prompt still contains `git push origin HEAD`.

- [ ] **Step 3: Rewrite the AFTER FIXING block**

Replace lines 128–133 of `apps/server/workflows/prompts/dependabot-ci-fix.md`:

```markdown
AFTER FIXING:
1. Publish with `github_publish` — `{ owner: "{{owner}}", repo: "{{repo}}",
   message: "fix(deps): make #{{prNumber}} mergeable" }`. It commits the whole
   working tree (the merge from step 1 and/or your CI fix) and pushes it in one
   step. Do NOT use `git commit` / `git push`: a commit built by git here is
   unsigned, and on a repo that requires signed commits one unsigned commit
   anywhere in the branch blocks the PR permanently and cannot be cleared by a
   later run. Local commits you made while working are folded in automatically.
   - If it reports `published: false`, there was nothing to publish. That is the
     "nothing to commit or push" case in the STOP section below — flag it for a
     human rather than looping.
   - If it refuses because a change needs a file mode it cannot set (a new
     executable file, a symlink, a submodule pointer), do NOT fall back to
     `git push` — nothing was published, and pushing would land the unsigned
     commit the refusal exists to prevent. Flag it for a human.
2. Once the publish re-runs CI and it goes green, the `dependabot-pr-merge`
   workflow takes over the merge — you do NOT merge or label a healthy PR.
```

- [ ] **Step 4: Update the push-discipline wording**

The gate language still says "push". Replace lines 135–143's three bullets'
verbs so the gate reads against the new step — change "Push **only** on a green
local gate" to "Publish **only** on a green local gate", "it never authorises a
push" to "it never authorises a publish", and "do **not** push a speculative
fix" to "do **not** publish a speculative fix". Leave `outcome=pushed` alone:
it is a marker value the harness parses (`fix-harvest.ts`), not prose.

- [ ] **Step 5: Confirm the marker vocabulary is untouched**

```bash
rg -n "outcome=pushed|CI_FIX_COMPLETE" apps/server/src apps/server/skills | head
```

`outcome=pushed` must still be produced and consumed unchanged — this task
changes how the push happens, not what the phase reports.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter lastlight-core exec vitest run tests/workflows/dependabot-ci-fix.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/workflows/prompts/dependabot-ci-fix.md \
        apps/server/tests/workflows/dependabot-ci-fix.test.ts
git commit -m "feat(dependabot): publish the CI fix as a signed commit"
```

---

### Task 8: Roll the helper across the remaining code-writing prompts

Seven prompts still end in `git commit && git push`. Each is one edit; the value
of doing them together is the guard test at the end, which makes it impossible
to add an eighth by accident.

**Files:**
- Modify: `apps/server/workflows/prompts/executor.md:36-40`
- Modify: `apps/server/workflows/prompts/fix.md:16`
- Modify: `apps/server/workflows/prompts/pr-fix.md:70-73`
- Modify: `apps/server/workflows/prompts/pr.md:37`
- Modify: `apps/server/workflows/prompts/reviewer.md:42`
- Modify: `apps/server/workflows/prompts/re-reviewer.md:22`
- Modify: `apps/server/workflows/prompts/architect.md:41`,
  `apps/server/workflows/prompts/guardrails.md:55`
- Test: `apps/server/tests/workflows/signed-publish.test.ts` (create)

**Interfaces:**
- Consumes: the `github_publish` tool surface.
- Produces: nothing code-facing.

- [ ] **Step 1: Write the guard test**

Create `apps/server/tests/workflows/signed-publish.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One unsigned commit anywhere in a branch blocks a `required_signatures` PR
 * permanently, and no later run can clear it (issue #268). So no packaged
 * prompt may tell the agent to build the published commit locally — the whole
 * point of `github_publish` is that GitHub builds and signs it.
 */
const PROMPTS_DIR = join(import.meta.dirname, "../../workflows/prompts");

const FORBIDDEN = [/git push\b/, /git commit\b/];

describe("packaged prompts publish through github_publish", () => {
  const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"));

  it("finds the prompt set", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file} does not hand-roll a published commit`, () => {
      const text = readFileSync(join(PROMPTS_DIR, file), "utf8");
      for (const pattern of FORBIDDEN) {
        expect(text, `${file} still uses ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter lastlight-core exec vitest run tests/workflows/signed-publish.test.ts
```

Expected: FAIL for `executor.md`, `fix.md`, `pr-fix.md`, `pr.md`, `reviewer.md`,
`re-reviewer.md`, `architect.md`, `guardrails.md`. `dependabot-ci-fix.md` already
passes from Task 7 — if it does not, Task 7 is incomplete.

- [ ] **Step 3: Convert `executor.md`**

Replace lines 36–40. The `git reset -q -- .lastlight` dance becomes the tool's
`exclude` parameter:

```markdown
3. Publish with `github_publish` — `{ owner: "{{owner}}", repo: "{{repo}}",
   message: "feat: implement #{{issueNumber}}"{{#if externalizeArtifacts}},
   exclude: [".lastlight"]{{/if}} }`. It commits the working tree and pushes it
   as ONE signed commit. Do NOT use `git commit` / `git push`: a commit built by
   git here is unsigned, and a repo that requires signed commits blocks it
   permanently.
```

- [ ] **Step 4: Convert `fix.md` line 16**

```markdown
3. Publish with `github_publish` — `{ owner: "{{owner}}", repo: "{{repo}}",
   message: "fix: address review feedback for #{{issueNumber}} (cycle {{fixCycle}})" }`.
   Do NOT use `git commit` / `git push` — a commit built by git here is unsigned
   and a repo requiring signed commits blocks it permanently.
```

- [ ] **Step 5: Convert `pr-fix.md` lines 70–73**

```markdown
1. Publish with `github_publish` — `{ owner: "{{owner}}", repo: "{{repo}}",
   message: "fix: address feedback on PR #{{prNumber}}" }`. It commits the
   working tree and pushes it as one signed commit; do NOT use `git commit` /
   `git push`.
```

- [ ] **Step 6: Convert the four artifact-committing prompts**

`pr.md:37`, `reviewer.md:42`, `re-reviewer.md:22`, `architect.md:41`,
`guardrails.md:55` all follow the same shape — a `{{#if !externalizeArtifacts}}`
branch that commits `.lastlight/`. Replace each `git add .lastlight/ && git
commit -m "<msg>" && git push origin HEAD` with:

```markdown
`github_publish` with `{ owner: "{{owner}}", repo: "{{repo}}", message: "<msg>" }`
```

keeping each prompt's existing `<msg>` verbatim and leaving the
`{{#if externalizeArtifacts}}Do NOT git add or commit …{{/if}}` branch as it is.

- [ ] **Step 7: Run the guard test to verify it passes**

```bash
pnpm --filter lastlight-core exec vitest run tests/workflows/signed-publish.test.ts
```

Expected: PASS for every prompt.

- [ ] **Step 8: Run the whole server workflow suite for regressions**

```bash
pnpm --filter lastlight-core exec vitest run tests/workflows/
```

Prompt text is asserted by several existing tests (`golden-build.test.ts`,
`templates.test.ts`); fix any that pinned the old wording, and check each fix is
updating an assertion about *behaviour*, not just re-pinning a string.

- [ ] **Step 9: Commit**

```bash
git add apps/server/workflows/prompts/ apps/server/tests/workflows/signed-publish.test.ts
git commit -m "feat(workflows): publish every code-writing phase as a signed commit"
```

---

### Task 9: Update the spec surfaces and run the full gate

`apps/server/spec/` is rebuild-grade documentation and the `docs-sync` skill's
pre-commit hook fires on prompt changes.

**Files:**
- Modify: `apps/server/spec/09-sandbox.md` (the credentials/push section)
- Modify: `apps/server/CLAUDE.md` (permission-profiles bullet)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Invoke the docs-sync skill**

It maps changed files to the doc surfaces they affect:

```
Skill: docs-sync
```

- [ ] **Step 2: Find the surfaces that describe how agents push**

```bash
rg -n "git push|push origin|extraheader" apps/server/spec/ apps/server/CLAUDE.md
```

- [ ] **Step 3: Record the invariant**

Add to `apps/server/spec/09-sandbox.md`, next to the existing credentials
invariant:

```markdown
### Invariant: the published commit is built by GitHub, not by git

A commit object built inside the sandbox is unsigned, and the installation token
cannot change that — the token authenticates the *push*, a signature is a
property of the *commit object*. On a repo with `required_signatures`, one
unsigned commit anywhere in the branch blocks the PR permanently, and no later
run can clear it (issue #268).

So every code-writing prompt publishes through `github_publish`, which hands the
working-tree change set to GraphQL `createCommitOnBranch`; GitHub builds and
signs the commit under the App's bot identity. Local `git commit`s are scratch
state that never leaves the sandbox. There is deliberately **no** fallback to
`git push` — a fallback would publish exactly the unsigned commit the mechanism
exists to prevent.

The `http.extraheader` token path stays: `clone` / `fetch` / `merge` still need
it, and the local scratch commits still need `GIT_AUTHOR_*`.
```

- [ ] **Step 4: Run the full workspace gate**

```bash
cd /Users/robin/code/github.com/yo61/lastlight
pnpm turbo run typecheck test build
```

Expected: clean. Zero warnings — fix everything, per the zero-warnings policy.

- [ ] **Step 5: Verify the JSONL fixtures are byte-identical**

agentic-pi hard rule #2. This work adds no events, so nothing may have moved:

```bash
git status --porcelain packages/agentic-pi/test/fixtures/
```

Expected: empty output.

- [ ] **Step 6: Commit and open the PR**

```bash
git add apps/server/spec/ apps/server/CLAUDE.md
git commit -m "docs(sandbox): record the signed-publish invariant"
git push -u origin feat/signed-commit-publish
```

---

## Self-review

**Spec coverage.** Every goal in the spec comment maps to a task: verified
commits (3, 5), `[bot]` attribution (3 — `committer` is returned and asserted in
tests), no durable secret (nothing added; hard rule #8 is a global constraint),
one shared primitive (4, called from 7 and 8), the `dirty`/lockfile case handled
by the default mechanism (2 — the diff reads the working tree regardless of how
it got there), Dependabot first (7), fail loudly with no `git push` fallback (4,
5, and the guard test in 8). Two spec items are deliberately **not** implemented
and are recorded in `README.md` instead: the REST blob→tree→commit design (wrong
mechanism) and the "executable files publish correctly" acceptance criterion
(inexpressible — refused instead). The spec's `git-http-auth` open question is
answered "keep", with the reason.

**Type consistency.** `PublishAddition` gains `status` in Task 4 Step 5, and the
same step strips it before GraphQL — `FileAddition` takes only `path` and
`contents`. `SignedCommit.signature` is nullable everywhere it is read, and both
Task 4 (`?? null`) and Task 5 (`if (commit.signature && …)`) handle null without
throwing.

**Known gap.** Task 1 is a manual verification against real GitHub and cannot be
automated in CI. Its two verdicts feed Task 5 Step 3 and Step 6, both of which
specify what to do under either answer, so no task is blocked by it.
