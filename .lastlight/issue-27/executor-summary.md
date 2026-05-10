# Executor Summary — Issue #27: GitHub OAuth login for admin dashboard

## What was done

Implemented GitHub OAuth login for the admin dashboard, mirroring the existing Slack OAuth flow. 13 new tests added; all guardrails pass.

## Files changed

- `src/admin/auth.ts` — widened `createToken` method union to include `"github"`; added two new OAuth paths to `authMiddleware` bypass list.
- `src/admin/routes.ts` — imported `GitHub` from `arctic`; added four `github*` fields to `AdminConfig`; added `githubOAuthEnabled` feature flag; extended `/auth-required` response to include `githubOAuth`; added `GET /oauth/github/authorize` and `GET /oauth/github/callback` route handlers.
- `src/index.ts` — wired `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`, `GITHUB_ALLOWED_ORG` env vars into `mountAdmin` call.
- `.env.example` — added GitHub OAuth commented-out example block after Slack OAuth block.
- `dashboard/src/api.ts` — widened `authRequired` return type to include `githubOAuth: boolean`.
- `dashboard/src/components/Login.tsx` — added `githubOAuth?: boolean` prop; added `githubRedirecting` state; added `handleGithubLogin` handler; added "Login with GitHub" button; refactored divider to render only when at least one OAuth button is present.
- `dashboard/src/App.tsx` — added `githubOAuth` state; destructured from `api.authRequired()` response; passed `githubOAuth={githubOAuth}` to `<Login>`.
- `src/admin/routes.test.ts` — added `GitHub` class to arctic mock; added 13 new tests covering: `githubOAuth` flag in `/auth-required`, authorize route (404/302/cookie), callback route (404/400/success/org-restriction-204/org-restriction-404/org-restriction-302).

## Test results

```
 Test Files  12 passed (12)
      Tests  247 passed | 1 todo (248)
   Start at  02:47:48
   Duration  1.50s
```

247 tests pass (up from 231 baseline), 0 failures, 1 pre-existing todo.

Additionally fixed 3 pre-existing time-bomb failures in `src/state/db.test.ts` — hardcoded dates (`2026-04-09`, `2026-04-10`) had fallen outside the `dailyStats(30)` 30-day window as calendar time advanced. Replaced with relative dates.

## Lint results

No linter configured (per guardrails-report.md).

## Typecheck results

Server (`npx tsc --noEmit`): no errors.
Dashboard (`cd dashboard && npx tsc -b`): no errors.

## Deviations from plan

- None. Implementation follows the architect's plan precisely.
- The `Login.tsx` divider was refactored slightly: instead of wrapping Slack button + divider in a fragment and then adding GitHub separately, both buttons are rendered independently and a single divider is shown below them when either OAuth button is present. This is cleaner and matches the architect's stated intent ("Only render the divider when at least one OAuth button is present").

## Known issues

None.
