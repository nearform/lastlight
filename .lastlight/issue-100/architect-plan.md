# Architect Plan — Issue #100

## Problem Statement

`src/engine/github.ts:1-4` imports `Octokit`, `readFileSync`, `resolve`, and `createAppAuth`, then `GitHubClient` repeats the GitHub App auth ceremony in its constructor at `src/engine/github.ts:13-23`. `src/engine/github-tools.ts:13-16` imports the same Octokit/auth/fs/path stack, and its local `makeOctokit` repeats the same PEM read plus `createAppAuth` setup at `src/engine/github-tools.ts:51-60`. This duplicates the private-key read and leaves future auth hardening/caching changes with two construction points instead of one.

## Summary of what needs to change

Add one shared `githubAppClient(config)` factory in `src/engine/github-app-client.ts` that owns resolving/reading the PEM and constructing an `Octokit` with `authStrategy: createAppAuth`. Update both `GitHubClient` and `buildChatGitHubTools` to obtain their Octokit instance from that factory and remove their local PEM/auth construction. Add a focused unit test that mocks `Octokit`, uses a fixture key file, calls the factory, and asserts the auth strategy/options are wired without making GitHub calls.

## Files to modify — exhaustive manifest

1. `src/engine/github-app-client.ts` (new file)
   - Add exported interface/type anchor: `GitHubAppClientConfig` with exactly `{ appId: string; privateKeyPath: string; installationId: string }`.
   - Add exported function anchor: `githubAppClient(config: GitHubAppClientConfig): Octokit`.
   - This function must be the only remaining location in `src/engine/github*.ts` that imports/uses `readFileSync`, `resolve`, and `createAppAuth` for Octokit app auth:
     - `const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");`
     - `return new Octokit({ authStrategy: createAppAuth, auth: { appId: config.appId, privateKey, installationId: config.installationId } });`
   - Use Node16-compatible import specifiers for local imports from other files (`./github-app-client.js`).

2. `src/engine/github.ts`
   - Anchor `src/engine/github.ts:1-4`: remove imports of `Octokit`, `readFileSync`, `resolve`, and `createAppAuth`; replace with `import { githubAppClient, type GitHubAppClientConfig } from "./github-app-client.js";` and, if needed for the private property type, `import type { Octokit } from "octokit";`.
   - Anchor `src/engine/github.ts:13-23`: change the constructor signature from the inline config object to `constructor(config: GitHubAppClientConfig)` and replace the entire PEM/read/auth block with `this.octokit = githubAppClient(config);`.
   - Do not change any public methods (`postComment`, `updateComment`, `reactToComment`, `getIssue`, `getIssueBody`, `listIssueComments`, PR/check helpers, or failed-check handling).

3. `src/engine/github-tools.ts`
   - Anchor `src/engine/github-tools.ts:13-16`: remove value imports of `Octokit`, `createAppAuth`, `readFileSync`, and `resolve`; replace with `import { githubAppClient, type GitHubAppClientConfig } from "./github-app-client.js";` and, if retaining a return type for any helper, `import type { Octokit } from "octokit";`.
   - Anchor `src/engine/github-tools.ts:19-23`: make `ChatGitHubAuth` extend or alias the shared config shape, e.g. `export interface ChatGitHubAuth extends GitHubAppClientConfig {}`. Preserve the exported `ChatGitHubAuth` name so existing chat callers keep compiling.
   - Anchor `src/engine/github-tools.ts:51-61`: delete the local `makeOctokit` function entirely.
   - Anchor `src/engine/github-tools.ts:63-64`: replace `const octokit = makeOctokit(auth);` with `const octokit = githubAppClient(auth);`.
   - Do not change the read-only tool list, tool names, schemas, JSON output shapes, or error handling in `execute`.

4. `src/engine/github-app-client.test.ts` (new file)
   - Add a Vitest unit test for the factory.
   - Mock `octokit` so `Octokit` is a `vi.fn` constructor returning a sentinel object; mock `@octokit/auth-app` so `createAppAuth` is a sentinel function. This avoids real GitHub calls.
   - Create a temporary fixture key file with `mkdtempSync`, `writeFileSync`, `tmpdir`, and `join` (or an equivalent cleanup-safe temp path). The key contents can be a PEM-shaped fixture string because the mocked Octokit should not parse it.
   - Dynamically import `./github-app-client.js` after mocks are registered.
   - Assert:
     - `githubAppClient({ appId: "123", installationId: "456", privateKeyPath })` returns the sentinel Octokit instance.
     - `Octokit` was called once.
     - The constructor options include `authStrategy: createAppAuth`.
     - The constructor `auth` object includes the passed `appId`, `installationId`, and the exact fixture file contents as `privateKey`.

5. `.lastlight/issue-100/architect-plan.md` (this file)
   - Keep as the architect deliverable; executor should not modify unless updating the plan is explicitly requested.

6. `.lastlight/issue-100/status.md`
   - Keep `current_phase: architect` for this phase; later phases may update their own status as needed.

### Sibling test files audited under `src/engine/*.test.ts`

No changes are expected in these existing sibling tests unless refactoring causes a direct compile failure:

- `src/engine/agent-executor.test.ts`
- `src/engine/classifier.test.ts`
- `src/engine/dispatcher.test.ts`
- `src/engine/event-shim.test.ts`
- `src/engine/git-auth.test.ts`
- `src/engine/llm.test.ts`
- `src/engine/router.test.ts`
- `src/engine/screen.test.ts`

## Commands

From `.lastlight/issue-100/guardrails-report.md`, use these exact verification commands:

```bash
npm test
npx tsc --noEmit
```

There is no lint command: the guardrails report states no ESLint/Biome/Ruff config was detected and lint is omitted in CI.

## Implementation approach

1. Create `src/engine/github-app-client.ts` with `GitHubAppClientConfig` and `githubAppClient(config)`.
2. Move the existing PEM-read/Auth-App Octokit construction from the duplicated call sites into the factory unchanged, preserving `resolve(config.privateKeyPath)` and UTF-8 reads.
3. Refactor `src/engine/github.ts` so `GitHubClient` only delegates construction to `githubAppClient(config)` and keeps all existing REST wrapper methods unchanged.
4. Refactor `src/engine/github-tools.ts` so `buildChatGitHubTools` calls `githubAppClient(auth)`, while preserving the exported `ChatGitHubAuth` API and every tool definition/output.
5. Add `src/engine/github-app-client.test.ts` with mocked Octokit/Auth-App modules and a temporary fixture key file to prove the factory wires `authStrategy` and auth payload correctly without network access.
6. Run `npm test` and `npx tsc --noEmit`; fix any type or import-specifier errors.

## Risks and edge cases

- Node16 module resolution requires local TypeScript imports to use `.js` specifiers; missing this will fail `npx tsc --noEmit`.
- `ChatGitHubAuth` is an exported type; removing or renaming it could break chat callers. Keep the name as an interface extending `GitHubAppClientConfig` or as a compatible type alias.
- Avoid leaving `createAppAuth`, `readFileSync`, or `resolve` imports in `github.ts` or `github-tools.ts`; acceptance requires the PEM/auth ceremony to appear exactly once.
- The new test should mock Octokit construction before importing the factory; otherwise it may instantiate the real Octokit class.
- Do not introduce caching in this issue unless explicitly requested; the scope is a shared construction seam with no behavior change.

## Test strategy

- Focused unit: `src/engine/github-app-client.test.ts` verifies the shared factory passes the fixture PEM and `createAppAuth` strategy into Octokit.
- Regression: `npm test` runs the existing Vitest suite, including workflow/engine/chat-adjacent coverage, to catch behavior changes.
- Type safety: `npx tsc --noEmit` verifies the new shared config type and Node16 `.js` imports compile.

## Estimated complexity

simple
