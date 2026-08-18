-- DATA migration, not DDL. Lifted verbatim from the pre-Drizzle
-- `src/state/migrate.ts`, which re-executed these on EVERY boot and was
-- idempotent only by hand-maintained convention. Journaling them is the payoff
-- of issue #345: they now run exactly once, recorded in `__drizzle_migrations`.
--
-- ⚠ THE ORDER OF THESE STATEMENTS IS LOAD-BEARING. `workflow_runs` must be
-- normalized before `executions`, because the executions backfill reads
-- `workflow_runs.owner` back out (step 4). Within `executions`, the owner must
-- be rescued off the qualified string BEFORE the string is de-qualified.
--
-- On a fresh database every statement matches zero rows. On production they
-- are the first migration that really WRITES to existing data — which is why
-- the cutover runbook smokes this against a copy of the real DB first.
--
-- sqlite-only (`instr`), which is correct: this folder is the sqlite dialect's
-- migration history and Postgres has no legacy population to repair.

-- ── One repo-identifier rule: (owner, BARE repo) — issue #279 ────────────────
--
-- Two populations predate the rule, so the same column meant different things
-- depending on who wrote it: rows older than the `owner` column hold the
-- qualified `owner/repo` in `repo` itself, and `executions` never had an
-- `owner` column at all — the dispatcher wrote the qualified string there while
-- the phase executor wrote the bare name. Six read sites each re-derived "may
-- be bare or qualified" and disagreed; #278 shipped a filter built on one
-- reading, and a non-null non-match HIDES rows rather than showing them. So
-- converge the data rather than teach a seventh consumer the rule.
UPDATE workflow_runs
   SET owner = CASE WHEN owner IS NULL OR owner = ''
                    THEN substr(repo, 1, instr(repo, '/') - 1)
                    ELSE owner END,
       repo  = substr(repo, instr(repo, '/') + 1)
 WHERE repo IS NOT NULL AND instr(repo, '/') > 0;
--> statement-breakpoint
-- A row from before the owner column whose `context.owner` was absent has one
-- more witness: `trigger_id`, built as `owner/repo#N` from the same pair at
-- dispatch. `resume.ts` and the approval-resume path already PREFER it over the
-- columns, so reading it here is the existing precedence, not a new guess.
-- Slack-originated ids (`slack:…`) carry no repo and are excluded.
UPDATE workflow_runs
   SET owner = substr(trigger_id, 1, instr(trigger_id, '/') - 1)
 WHERE (owner IS NULL OR owner = '')
   AND repo IS NOT NULL
   AND trigger_id NOT LIKE 'slack:%'
   AND instr(trigger_id, '/') > 0;
--> statement-breakpoint
-- 1. The account is already in the row, on the dispatcher-written rows that
--    stored the qualified string.
UPDATE executions
   SET owner = substr(repo, 1, instr(repo, '/') - 1)
 WHERE (owner IS NULL OR owner = '')
   AND repo IS NOT NULL AND instr(repo, '/') > 0;
--> statement-breakpoint
-- 2. Otherwise it comes from the run that owns the execution. This is the bulk:
--    every phase row, written bare from `GitSandboxAccess`. `build-cycle` rows
--    are covered by (1) and chat rows carry no repo at all, so nothing is left
--    needing a `trigger_id` parse.
UPDATE executions
   SET owner = (SELECT r.owner FROM workflow_runs r WHERE r.id = executions.workflow_run_id)
 WHERE (owner IS NULL OR owner = '') AND workflow_run_id IS NOT NULL;
--> statement-breakpoint
-- 3. Now de-qualify, once the account has been rescued off it.
UPDATE executions
   SET repo = substr(repo, instr(repo, '/') + 1)
 WHERE repo IS NOT NULL AND instr(repo, '/') > 0;
--> statement-breakpoint
-- ── feedback_anchors.channel sentinel — issue #255 ───────────────────────────
--
-- `channel` moved from nullable to a '' sentinel so its UNIQUE actually binds
-- for GitHub: SQLite treats NULLs as DISTINCT, so a NULL there leaves the
-- three-column UNIQUE (and the ON CONFLICT targeting it) silently inoperative
-- and re-discovering the same comment forks a second row. Backfill rows written
-- by a build predating the fix.
UPDATE feedback_anchors SET channel = '' WHERE channel IS NULL;
