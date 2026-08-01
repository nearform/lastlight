# Phase 6 — Config, docs, verification

> **Amended by [09-state-machine.md](09-state-machine.md).** Add
> `fix.maxFlakyDeferrals: 2`; `fix.maxCostUsd` defaults to `5.0` (not `null`);
> `dependencies.minSettledChecks` defaults to `1` and is **operator-only**
> (§6.2's `max(repo, operator)` clamp would otherwise weld the escape hatch
> shut for CI-less repos); `review.afterChecks` is **deleted**.

**Risk: low, but touches many files.** Can land first as inert config, or last.

Both issues ask for the behaviour to be *tunable* — per instance and per repo.
This phase adds two config blocks through all four layers
(`default → overlay → env → repo`), the docs that describe them, and the
end-to-end verification for the whole plan.

## 6.1 — The blocks

`apps/server/config/default.yaml`, as siblings of the existing per-workflow
blocks (`bootstrap:`, `explore:`, `review:`):

```yaml
# Applies to every PR_FIX_SHAPED workflow (pr-fix, dependabot-ci-fix).
fix:
  maxAttempts: 3               # cross-run attempts per (repo, PR) before requires-human
  localIterations: 2           # within-run gate loop iterations inside one attempt
  gateTimeoutSeconds: 900      # until_bash budget for the repo's build/test gate
  escalateModelAfterAttempt: 1 # attempts above this use models["pr-fix-retry"] when set
  maxCostUsd: null             # cumulative ceiling across attempts for one PR; null = off
  retryableClasses: [reproducible, env-mismatch]   # every other class escalates immediately

dependencies:
  autoMergeMaxImpact: low      # none | low | medium | high — ceiling for auto-merging a MAJOR
  requireSettledChecks: true   # enforce settled-"passing" on ALL routes (webhook, cron, comment)
  minSettledChecks: 1          # an auto-merge decision needs >=N settled checks; 0 = today's behaviour
  auditComment: true           # post the evidence comment when auto-merging a major
```

### On `autoMergeMaxImpact: low` as the packaged default

Shipping `medium` packaged would silently change behaviour for **every**
existing deployment on upgrade. `low` keeps the packaged default conservative
and near-inert, matching the `repoConfig:` ethos ("nothing changes until a repo
actually commits `.lastlight/`").

#252's actual ask — low **and** medium auto-merging — is then delivered by
setting `dependencies.autoMergeMaxImpact: medium` in the
`nearform/lastlight-nearform` overlay. This is flagged as an open question in
the [README](README.md); if you would rather ship `medium` packaged, that is a
one-line change here plus a release note.

## 6.2 — Repo-settable subset and clamp direction

A repo may only ever be **more conservative** than the operator.

| Key | Repo-settable | Clamp |
|---|---|---|
| `fix.maxAttempts` | yes | `min(repo, operator)` |
| `fix.localIterations` | yes | `min(repo, operator)` |
| `fix.maxCostUsd` | yes | `min`, treating `null` as unbounded |
| `fix.retryableClasses` | yes | subset of the operator's list only |
| `fix.escalateModelAfterAttempt` | **no** | operator-only (spend control) |
| `fix.gateTimeoutSeconds` | **no** | operator-only (resource control) |
| `dependencies.autoMergeMaxImpact` | yes | lower of the two on `none < low < medium < high` |
| `dependencies.requireSettledChecks` | yes | add-only `true`; a `false` is dropped with a warning |
| `dependencies.minSettledChecks` | yes | `max(repo, operator)` |
| `dependencies.auditComment` | yes | free — cosmetic |

The model for all of these is `sanitizeApproval`
(`packages/shared/src/repo-config-schema.ts:676`), the existing add-only
precedent: *"a repo can raise an approval gate, never clear one."* Same shape,
same warning-on-drop behaviour, new warning code.

## 6.3 — The eight-step checklist

Verified against the existing implementation. Steps 3 and 4 are the ones that
silently no-op if skipped.

1. **`apps/server/config/default.yaml`** — the blocks above, with comments
   explaining the clamp direction (the file is the primary documentation for
   operators).
2. **`apps/server/src/config/config.ts`** — `fix` and `dependencies` fields on
   `LastLightConfig`; **lenient** branches in `normalizeFileConfig` (degrade a
   malformed value to the default, never throw — these bound untrusted input,
   the same rule as `crons` and `repoConfig.allowKeys`); optional
   `buildEnvConfigLayer` entries if env overrides are wanted.
3. **`packages/shared/src/repo-config-schema.ts`** —
   - add `"fix"` and `"dependencies"` to `DEFAULT_REPO_CONFIG_ALLOW_KEYS`;
   - add `case "fix"` / `case "dependencies"` + `sanitizeFix` /
     `sanitizeDependencies` to `sanitizeRepoConfigLayer`. **An allow-listed key
     with no validator is silently dropped as `key-not-allowed`** — the
     validator is mandatory, not optional;
   - add the fields to `RepoMergedConfig` and `RepoConfigSources`, and handle
     them in `shapeMerged` / `shapeSources`;
   - add a `RepoConfigWarningCode` of `"policy-downgrade"` for a repo trying to
     loosen a clamped key.
4. **`apps/server/src/config/repo-config.ts`** — add both keys to
   `repoConfigBaseFromRuntime()`, which currently hardcodes exactly
   `{models, variants, disabled, approval}`, in **both** `value` and `sources`.
   Miss this and the base value is absent at merge time.
5. **`apps/server/src/workflows/simple.ts`** — fields on `RunRepoConfig`,
   mapped in `resolveRepoRunConfig`, included in `repoConfigRunRecord().applied`,
   an `effectiveFix` / `effectiveDependencies` substitution alongside the
   existing `effectiveModels` / `effectiveVariants` / `effectiveApproval`, and
   seeded onto `ctx` so prompts can read `{{fix.maxAttempts}}` /
   `{{dependencies.autoMergeMaxImpact}}`. Mirror in `restoreRepoRunConfig`
   (`resume.ts`) so a resumed run uses its own config, not today's.
6. **`packages/cli/src/repo-cli.ts`** — a `WARNING_LABEL` entry for
   `policy-downgrade`, so `lastlight repo config validate` prints something
   human.
7. **Tests** — `apps/server/tests/config/repo-config-shared.test.ts` pins
   `DEFAULT_REPO_CONFIG_ALLOW_KEYS` against `repoConfig.allowKeys` **including
   order**; both must change together. Add clamp cases to
   `tests/config/repo-config.test.ts` and a reaches-a-run case to
   `tests/workflows/repo-config-wiring.test.ts`.
8. **Docs** — below.

**`runWorkflow.length` is frozen at 9** by `evals-contract.test.ts` (the
`lastlight/evals` public contract). Carry everything on `ctx` or the defaulted
10th `repoConfig` parameter; never add a positional argument.

## 6.4 — Docs

Per the `docs-sync` skill's mapping. A pre-commit hook fires on
`config/default.yaml` and `src/config/` changes, so this is not optional.

**In-repo spec** (`apps/server/spec/`):
- `02-configuration.md` — the `LastLightConfig` schema block, "What a repo may
  set", the **YAML-only config keys** table (it has a Repo-settable column),
  and Invariants.
- `03-integrations.md` — the App permission list (Phase 1) and the
  `pr.checks_failed` gate (Phase 3).
- `05-router.md` — the broadened check-failure route.
- `06-workflow-engine.md` — `generic_loop` + `until_bash` gaining a production
  consumer, and the `timeout_seconds` trap.
- `07-phases-and-prompts.md`, `08-skills.md` — the `diagnose` phase and the two
  new skills.

**Site** (`apps/www/src/pages/`):
- `docs/github-app.astro` — the Actions: Read row.
- `docs/configuration.astro`, `docs/repo-config.astro` — the two new blocks.
- `docs/workflows/{pr-fix,dependabot-ci-fix,dependabot-pr-merge}.astro`.

**Plugin + CLAUDE.md:**
- `plugins/lastlight/skills/lastlight-server/SKILL.md` — the App permission
  walkthrough.
- `apps/server/CLAUDE.md` (per-repo config bounds),
  `apps/server/src/workflows/CLAUDE.md` (the loop's first production use),
  `packages/shared/CLAUDE.md`, `packages/cli/CLAUDE.md`,
  `packages/agentic-pi/README.md`.

> **Do not edit `apps/www/src/content/spec/*.md`** — generated and gitignored,
> copied from `apps/server/spec/` by `apps/www/scripts/sync-spec.mjs`.

## 6.5 — Verification (whole plan)

1. `pnpm turbo run typecheck test build` from the repo root — the CI gate.
2. Focused suites in `apps/server`:
   `npx vitest run tests/workflows/ tests/config/ tests/cron/ tests/engine/ tests/connectors/`;
   and `npm run test:unit` in `packages/agentic-pi`.
3. `pnpm --filter lastlight repo config validate` against a fixture
   `.lastlight/lastlight.yml` that tries to **loosen** `autoMergeMaxImpact` and
   `fix.maxAttempts` — must report `policy-downgrade` warnings and clamp, not
   fail the run.
4. `until_bash` is the one genuinely new production runtime path:
   ```bash
   docker compose --profile build-only build sandbox-base
   docker compose --profile build-only build sandbox
   RUN_SANDBOX_IT=1 npx vitest run tests/sandbox/
   ```
5. **`Actions: read` is best verified for real** — grant it on the dev App,
   confirm `getCiFailureReport` returns `logsAvailable: true` with genuine log
   excerpts against a known-red PR, then revoke and confirm it degrades to
   annotations **with the explicit notice**. *Half done:* the grant and the
   log-excerpt half are verified against real GitHub (see HANDOFF). The revoke
   half needs a **private** repo with a red PR — a downscoped token omitting
   `actions` still reads a public repo's Actions logs, so it cannot stand in.
6. **End-to-end without touching production** — the evals harness
   (`apps/evals`, mocked GitHub, no real token, model key only). *Not started,
   and it needs authoring, not just running:* no shipped tier drives the fix
   family (`code-fix` drives `build`). Two new tiers, driving:
   - each of the five diagnosis classes through attempts 1 → 3, asserting the
     escalation policy per class;
   - a major-bump case per impact tier, asserting the label + action.
   See `plugins/lastlight/skills/lastlight-evals` for scaffolding a workspace
   and `add-case --pr <url>` for building fixtures from real PRs.
7. **Rollout** — ship behind the conservative defaults with
   `fix.maxAttempts: 2` in the overlay; measure cost per attempt from the
   `executions.cost_usd` rollups; then raise `maxAttempts` and set
   `dependencies.autoMergeMaxImpact: medium`, and watch a real major bump land.

Note the release rule from `docs/RELEASING.md`: any prod-facing change here
needs a GitHub Release, because `lastlight server update` **pulls** the GHCR
images that only a Release builds.

## Done when

- Both blocks resolve through all four layers with per-leaf provenance visible
  in `GET /admin/api/repos/:owner/:repo/config`.
- A repo can tighten but never loosen, and is told why when it tries.
- Every doc surface in 6.4 describes the new keys.
