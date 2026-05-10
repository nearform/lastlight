# Reviewer Verdict — Issue #27

VERDICT: APPROVED

## Summary

The GitHub OAuth implementation faithfully mirrors the existing Slack OAuth flow across all seven changed files. All critical security controls are correctly in place: CSRF state cookie with httpOnly, SameSite=Lax, and 10-minute TTL; `redirect: "manual"` on the org membership fetch to prevent silent 302-following; `encodeURIComponent` on both org slug and login in the membership URL; User-Agent header on all GitHub API calls; and the `GITHUB_ALLOWED_ORG` requirement that prevents accidental "allow anyone" misconfiguration. Tests pass: 247/247 (13 new cases), 0 failures.

## Issues

### Critical

None.

### Important

None.

### Suggestions

- `src/admin/routes.ts:398` — `userRes.json()` is called without first checking `userRes.ok`. A non-200 from GitHub's `/user` endpoint (e.g. 401 revoked token, 429 rate limit with HTML body) will throw a JSON parse error, which is caught by the outer `try/catch` and surfaced as a generic "OAuth exchange failed" 502. The `!userInfo.login` guard at line 399 handles the case where the body parses but has no `login`. Consider an explicit `userRes.ok` check before calling `.json()` to surface a more actionable log message and avoid throwing on non-JSON bodies:
  ```typescript
  if (!userRes.ok) {
    console.error(`GitHub /user returned ${userRes.status}`);
    return c.json({ error: "GitHub userInfo failed" }, 502);
  }
  ```

- `src/admin/routes.ts:362` — The implementation requests `["read:org"]` for the org-restriction case and `[]` for the wildcard case. The architect plan specified `["read:user", "read:org"]`. The deviation is correct per GitHub's API docs (`login` is always present on authenticated user responses without a `read:user` scope), but worth noting in a comment for future readers who might assume `read:user` is needed.

### Nits

- `src/admin/routes.test.ts` (mockGithubFetch helper) — The default `orgStatus: 204` is never actually exercised by tests that omit `orgStatus`; those tests use `githubAllowedOrg: "*"` and assert no `/orgs/` call is made. A short comment would clarify the default is defensive, not load-bearing.

- `src/admin/routes.ts:338-340` — Minor: the Slack callback's outer `catch` logs `"OAuth exchange failed"` while the new GitHub catch logs `"GitHub OAuth exchange failed"`. Consistent, but the Slack version could benefit from the same specificity in a future cleanup (pre-existing, not introduced here).

## Test Results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  12 passed (12)
      Tests  247 passed | 1 todo (248)
   Start at  03:29:39
   Duration  1.57s (transform 242ms, setup 0ms, import 444ms, tests 202ms, environment 0ms)
```

TypeScript (server): `npx tsc --noEmit` — no errors.
TypeScript (dashboard): `cd dashboard && npx tsc -b` — no errors.
