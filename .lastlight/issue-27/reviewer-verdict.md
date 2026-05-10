# Reviewer Verdict — Issue #27

VERDICT: APPROVED

## Summary

The GitHub OAuth implementation correctly mirrors the existing Slack flow across all seven changed files. All critical security properties are in place: CSRF state cookie (httpOnly, SameSite=Lax, 10-minute TTL), `redirect: "manual"` on the org membership fetch to block silently-followed 302s, `encodeURIComponent` on org and login in the membership URL, and User-Agent header on all GitHub API calls. 247 tests pass (13 new cases covering the full happy/unhappy path matrix including 302 membership rejection).

## Issues

### Critical

None.

### Important

None.

### Suggestions

- `src/admin/routes.ts:398-401` — `userRes.json()` is called without first checking `userRes.ok`. If GitHub's `/user` endpoint returns a non-200 (e.g. a 401 due to a revoked token), the body is a GitHub error object with no `login` field, so the `!userInfo.login` guard at line 399 correctly blocks auth and returns 502. However, the log message "missing login field" obscures the root cause. Consider an explicit status check first:
  ```typescript
  if (!userRes.ok) {
    console.error(`GitHub /user returned ${userRes.status}`);
    return c.json({ error: "GitHub userInfo failed" }, 502);
  }
  ```

- `src/admin/routes.ts:362` — The architect plan specified `["read:user", "read:org"]` as scopes for the org-restriction case. The implementation instead requests only `["read:org"]` (and `[]` for the wildcard case), with a comment noting that `GET /user` does not require a scope to return `login`. This is correct per GitHub's API docs (the `login` field is always present on the authenticated user response without any additional scope), but it is a deviation from the plan worth acknowledging. No functional issue.

### Nits

- `src/admin/routes.test.ts` — The `mockGithubFetch` helper defaults `orgStatus` to `204` when `undefined`. This default is never exercised in the tests that actually omit `orgStatus` (those tests use `githubAllowedOrg: "*"` and assert that the `/orgs/` URL is never called). A brief comment on the helper would clarify this to future readers.

## Test Results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  12 passed (12)
      Tests  247 passed | 1 todo (248)
   Start at  02:49:33
   Duration  1.54s (transform 257ms, setup 0ms, import 452ms, tests 218ms, environment 1ms)
```
