# Phase 1 — Real CI evidence (`Actions: read`)

**Risk: medium** — needs App re-consent on existing installs and an independent
`agentic-pi` npm release.

Without this phase the rest is guesswork: the diagnosis loop in Phase 2 has
nothing better than check-run annotations to reason from. See
[00-current-behaviour.md](00-current-behaviour.md) → "Finding 1".

## Goal

Make the harness (and, optionally, the agent) able to read **actual GitHub
Actions job logs** and the **base branch's check state**, and make the absence
of that ability *visible* rather than silent.

## 1.1 — Request the `Actions: Read` permission

Add **Actions: Read** to the App's requested permissions and to every surface
that documents them:

- `apps/www/src/pages/docs/github-app.astro` — the permission table (~L43-75).
  Describe it as *"Read GitHub Actions job logs so the fix workflow can see why
  CI actually failed, rather than only check annotations."*
- `apps/server/spec/03-integrations.md` — the App-permission notes on the
  Check-suite rows (L60-62).
- `plugins/lastlight/skills/lastlight-server/SKILL.md:40` — the setup
  walkthrough's permission list.

Treat it as **optional-but-recommended**: existing installations must
re-consent, so nothing may hard-fail without it.

## 1.2 — Structured CI failure report

`apps/server/src/engine/github/github.ts`

Replace the single blob-returning `getFailedChecks` with a structured
`getCiFailureReport(owner, repo, ref)`:

```ts
interface CiJobFailure {
  name: string;              // check run name
  conclusion: string;        // failure | timed_out
  workflowPath?: string;     // .github/workflows/ci.yml — the CI definition to read
  failingStep?: string;      // the step name that failed, from the job's steps[]
  logExcerpt: string;        // extractErrorExcerpt(), or the annotation fallback
  jobUrl?: string;           // details_url, so the agent can dig via github_get_job_logs
  logsAvailable: boolean;    // false when the Actions download 403'd
}

interface CiFailureReport {
  jobs: CiJobFailure[];
  logsAvailable: boolean;    // false when NO job could supply real logs
}
```

Keep `getFailedChecks` as a thin renderer over `getCiFailureReport` so existing
`{{ciSection}}` callers are unchanged.

`workflowPath` matters: it is what lets the `fixing` skill in Phase 2 open the
*right* workflow file in the checkout and compare CI's toolchain against the
sandbox's. Derive it from the check run's `check_suite` /
`actions.getWorkflowRun` when Actions is readable, else leave undefined.

Also add:

```ts
getBaseChecksState(owner, repo, baseRef): Promise<"passing" | "failing" | "pending" | "none">
```

— a thin wrapper over the existing `getChecksConclusion` against the base
branch head. This is the sole signal for the `upstream-broken` diagnosis class
in Phase 2: if the base branch is red too, the PR is not at fault.

### Degrade loudly, not silently

When `logsAvailable` is false, `{{ciSection}}` must carry an explicit line:

```
NOTE: GitHub Actions job logs are unavailable (the App lacks `Actions: read`).
The excerpts below are check-run annotations only, which are usually truncated.
Grant Actions: read for full CI output.
```

This is the fix for Finding 1's real damage — not the missing permission, but
that its absence looked like normal operation.

## 1.3 — Actions read tools in agentic-pi

`packages/agentic-pi/src/extensions/github/`

The agent currently has **no way to fetch a job log itself** — it only sees
what the harness pre-fetched into `{{ciSection}}`. For a diagnosis loop that
needs to compare *this* run against a previous green run, that is too static.

Add three tools to `READ_TOOLS` (`profiles.ts:26`, which flows into all four
profiles):

| Tool | Purpose |
|---|---|
| `github_list_workflow_runs` | Find prior runs of the same workflow — how `flaky` is distinguished from `reproducible` (did this job pass on an earlier SHA?) |
| `github_list_workflow_run_jobs` | Enumerate jobs + steps of one run, to locate the failing step precisely |
| `github_get_job_logs` | Fetch one job's log, **truncated**, when the harness excerpt is inconclusive |

Register them in `tools.ts` alongside the existing ~32 `defineTool()` calls.
Requirements:

- **Truncate hard.** Actions job logs routinely run to megabytes; a raw dump
  will blow the context window. Reuse `extractErrorExcerpt`'s approach — tail
  + error-line matching — and cap the returned bytes with an explicit
  "truncated" notice.
- **Fail with an explanation.** On 403 return a clear
  `"not permitted — the App lacks Actions: read"` message so the agent stops
  rather than retrying the call in a loop.

Per `packages/agentic-pi/CLAUDE.md`, this package is a self-contained leaf,
published independently: the change needs a **fixture re-capture** (the smoke
commands at the bottom of that file) and its **own npm release** via
`agentic-pi-npm.yml`. Because the sandbox images *vendor* agentic-pi from the
workspace rather than npm, the monorepo picks the change up on the next image
build regardless of npm timing.

> **Descope option.** If an agentic-pi release is unwelcome timing, ship 1.1 +
> 1.2 only. Diagnosis in Phase 2 still works off the richer harness-side
> report; it just cannot dig into a *specific* job or compare against prior
> runs, which weakens the `flaky` classification most.

## Tests

- `apps/server/tests/engine/github/` — a new test for `getCiFailureReport`:
  the happy path with logs, the 403 path degrading to annotations with
  `logsAvailable: false`, and `workflowPath` extraction. Existing
  `extractErrorExcerpt` / `actionsJobIdFromDetailsUrl` unit tests stay.
- `getBaseChecksState` — assert it delegates to `getChecksConclusion`.
- `packages/agentic-pi` — unit tests for the three new tools: profile gating
  (present in all four profiles), truncation, and the 403 message.

## Verification

Grant `Actions: read` on the dev App and confirm against a known-red PR that
`getCiFailureReport` returns `logsAvailable: true` with genuine log excerpts;
then revoke it and confirm the report degrades to annotations **with the
explicit notice**, not silently.

## Done when

- The App permission is documented in all three surfaces.
- `getCiFailureReport` + `getBaseChecksState` exist and are unit-tested.
- `{{ciSection}}` states plainly when logs were unavailable.
- (Unless descoped) the three Actions tools are registered, truncating, and
  profile-gated, with fixtures re-captured.
