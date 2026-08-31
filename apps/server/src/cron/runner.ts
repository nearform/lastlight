/**
 * The cron fire path for `workflow:` crons, as a testable factory.
 *
 * Both fire routes funnel through here — the scheduler's tick
 * (`CronScheduler.register` → `runner`) and the admin "Run now"
 * (`admin/routes.ts` → `triggerCron`) — so this is the one write site for a
 * workflow cron's ledger row. (`handler:` crons fire through
 * `config.runCronHandler` instead and are wrapped by `withLedger` in
 * `./handlers.js`, which writes the same table.)
 *
 * The row is written, never returned: `WorkflowRunner` stays `Promise<void>`
 * and the manual trigger is fire-and-forget, so an outcome that has to travel
 * back up the call stack cannot survive either route.
 */
import type { StateDb } from "../state/db.js";
import type { GitHubClient } from "../engine/github/github.js";
import type { WorkflowRunner } from "./scheduler.js";
import { fanOutContexts, dispatchCronWorkflow, type CronDispatcher } from "./fanout.js";
import type { DependencyPr } from "./dependabot-discovery.js";
import { CRON_GLOBALLY_ENABLED_KEY, CRON_NAME_KEY, resolveCronRepos } from "./repo-crons.js";
import { logger } from "../logging/logger.js";
import { recordCronFire, withSpan } from "../telemetry/index.js";
import type { CronRunStatus } from "../state/cron-run-store.js";
import { recordActivity } from "../activity.js";
import { isTriggerActorType } from "../state/db.js";

const log = logger("cron");

/** Context keys the fire path consumes and strips before dispatching. */
const CRON_SOURCE_KEY = "_cronSource";
const CRON_ACTOR_KEY = "_cronActor";
/** How the "Run now" presser authenticated, so the fire's row agrees with the trigger's. */
const CRON_ACTOR_TYPE_KEY = "_cronActorType";

export type CronDiscoverer = (
  repos: string[],
  gh: GitHubClient,
  opts: { log?: (msg: string) => void },
) => Promise<DependencyPr[]>;

export interface CronRunnerDeps {
  db: StateDb;
  github: GitHubClient | null;
  discoverers: Record<string, CronDiscoverer>;
  dispatch: CronDispatcher;
  /**
   * Seam for issue #180's per-repo participation. Defaults to the real
   * resolver; tests substitute it to make narrowing observable without a
   * `.lastlight/` fixture per repo.
   */
  resolveRepos?: typeof resolveCronRepos;
}

interface FireCounts {
  reposEligible: number | null;
  reposScanned: number | null;
  discovered: number | null;
  dispatched: number | null;
  failures: number | null;
}

/**
 * The counts, rendered into the completion line's MESSAGE rather than left only
 * in its fields.
 *
 * A collapsed log view shows the message and nothing else — `kubectl logs`, and
 * any Grafana Logs panel whose `line_format` renders `msg`. Without this, the
 * one line the fire emits reads "Cron fire complete" and carries no outcome,
 * which is most of what issue #341 was complaining about. The fields are still
 * emitted, so the line stays queryable; this only makes it readable.
 *
 * Cost: the message is no longer a fixed string, so an exact `msg="Cron fire
 * complete"` match becomes a `|~ "Cron fire complete"` prefix match. Loki
 * indexes only stream labels, so there is no ingest-cardinality penalty.
 */
export function completionMessage(cronName: string, counts: FireCounts): string {
  const parts: string[] = [];
  if (counts.reposScanned !== null) {
    const narrowed = counts.reposEligible !== null && counts.reposEligible !== counts.reposScanned;
    parts.push(narrowed ? `scanned ${counts.reposScanned} of ${counts.reposEligible}` : `scanned ${counts.reposScanned}`);
  }
  if (counts.discovered !== null) parts.push(`found ${counts.discovered}`);
  if (counts.dispatched !== null) parts.push(`dispatched ${counts.dispatched}`);
  if (counts.failures) parts.push(`${counts.failures} failed`);

  // The CRON NAME leads, because a collapsed view shows the message and nothing
  // else — and with seven crons registered, "Cron fire complete: scanned 16"
  // identifies nothing. The stable `Cron fire complete:` prefix stays first so
  // `|~ "Cron fire complete"` still finds every fire of every cron.
  return parts.length
    ? `Cron fire complete: ${cronName} — ${parts.join(", ")}`
    : `Cron fire complete: ${cronName}`;
}

export function makeCronRunner(deps: CronRunnerDeps): WorkflowRunner {
  const { db, github, discoverers, dispatch } = deps;
  const resolveRepos = deps.resolveRepos ?? resolveCronRepos;

  return async (workflowName, rawContext) => {
    const cronName =
      typeof rawContext[CRON_NAME_KEY] === "string" ? (rawContext[CRON_NAME_KEY] as string) : "";

    // Read the two markers here, then drop them: `dispatchCronWorkflow` strips
    // `repos` + the two #180 control keys but knows nothing about these, so
    // without this they ride into every dispatched run's context. A dispatched
    // context must stay byte-for-byte what it was before this ledger existed
    // (`fanout.ts` makes the same promise about its own keys).
    const {
      [CRON_SOURCE_KEY]: rawSource,
      [CRON_ACTOR_KEY]: rawActor,
      [CRON_ACTOR_TYPE_KEY]: rawActorType,
      ...context
    } = rawContext;

    // No cron name means a caller that built its own context (an eval driver,
    // a direct API call). `resolveCronRepos` already treats that as "use the
    // list verbatim"; there is likewise no cron to key a ledger row on, so the
    // fire dispatches normally and records nothing.
    if (!cronName) {
      log.debug("Cron fire without a cron name — dispatching unrecorded", { workflowName });
      await fire(workflowName, context, { db, github, discoverers, dispatch, resolveRepos });
      return;
    }

    const source = rawSource === "manual" ? "manual" : "schedule";
    const actor = typeof rawActor === "string" ? rawActor : null;

    const id = await db.cronRuns.start({ cronName, workflow: workflowName, source, actor });

    // The activity log's ONE row for this fire (issue #206). The fan-out below
    // may dispatch a run per repo, and those dispatches deliberately write no
    // `workflow.trigger` row — a fan-out is one operational event, not N user
    // actions, the same reason this ledger is keyed on the cron rather than the
    // workflow. A scheduled fire has no human actor; a manual one carries the
    // login of whoever pressed "Run now".
    await recordActivity(db, {
      actorLogin: actor,
      // A scheduled fire has no human actor. A MANUAL one carries how the
      // presser authenticated, threaded from the trigger route — falling back
      // to `admin` only when that is genuinely unknown (an older context, or a
      // password session, which is what `admin` actually means).
      actorType: source === "manual" ? (isTriggerActorType(rawActorType) ? rawActorType : "admin") : "cron",
      action: "cron.fire",
      targetType: "cron",
      targetId: cronName,
      detail: { source, workflow: workflowName },
    });

    let counts: FireCounts = {
      reposEligible: null,
      reposScanned: null,
      discovered: null,
      dispatched: null,
      failures: null,
    };
    // Diagnostic only — which discoverer ran. Carried on the LOG line, never
    // into `cron_runs`: it is not a column, and the ledger write below spreads
    // `counts` straight into the store.
    let discoverKey: string | undefined;
    // On an object rather than two `let`s: TypeScript's control-flow analysis
    // does not carry the catch block's assignment into `finally`, so a narrowed
    // local reads as `"ok" | "partial"` there and the `"failed"` branch below
    // is flagged unreachable.
    const outcome: { status: Exclude<CronRunStatus, "running">; error?: string } = { status: "ok" };

    try {
      await withSpan(
        "lastlight.cron.fire",
        { "cron.name": cronName, "cron.workflow": workflowName, "cron.source": source },
        async (span) => {
          const result = await fire(workflowName, context, {
            db,
            github,
            discoverers,
            dispatch,
            resolveRepos,
          });
          ({ discoverKey, ...counts } = result);
          outcome.status = counts.failures && counts.failures > 0 ? "partial" : "ok";
          span?.setAttributes({
            "cron.repos_eligible": counts.reposEligible ?? 0,
            "cron.repos_scanned": counts.reposScanned ?? 0,
            "cron.discovered": counts.discovered ?? -1,
            "cron.dispatched": counts.dispatched ?? 0,
            "cron.failures": counts.failures ?? 0,
            "cron.status": outcome.status,
          });
        },
      );
    } catch (err: unknown) {
      outcome.status = "failed";
      outcome.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // In a `finally` so a crash mid-fire leaves a terminal row rather than a
      // stranded `running` one — silence is the thing this ledger exists to
      // remove.
      await db.cronRuns.finish(id, { status: outcome.status, ...counts, error: outcome.error });
      recordCronFire({ "cron.name": cronName, "cron.status": outcome.status });

      const fields = {
        cron: cronName,
        workflow: workflowName,
        source,
        status: outcome.status,
        ...counts,
        ...(discoverKey ? { discoverKey } : {}),
      };
      const msg = completionMessage(cronName, counts);
      if (outcome.status === "failed") log.error(msg, { ...fields, err: outcome.error });
      else if (outcome.status === "partial") log.warn(msg, fields);
      // Logged on SUCCESS too, not only on failure: a fully successful weekly
      // fan-out over 19 repos used to emit one "Running" line and nothing else
      // (issue #341). This is the COMMON path — nearly every fire is `ok` — so
      // it is the one that most needs the cron name and counts in the message.
      else log.info(msg, fields);
    }
  };
}

/**
 * The fire itself — discovery + fan-out, or a plain per-repo fan-out.
 *
 * Lifted verbatim from the closure that lived in `src/index.ts`, including the
 * per-repo narrowing a discovery cron has to do for itself (it bypasses
 * `dispatchCronWorkflow`, which does its own).
 */
async function fire(
  workflowName: string,
  context: Record<string, unknown>,
  deps: Required<Omit<CronRunnerDeps, "resolveRepos">> & { resolveRepos: typeof resolveCronRepos },
): Promise<FireCounts & { discoverKey?: string }> {
  const { github, discoverers, dispatch, resolveRepos } = deps;

  const discoverKey = typeof context.discover === "string" ? context.discover : undefined;
  const discoverer = discoverKey ? discoverers[discoverKey] : undefined;

  if (!discoverer) {
    // `dispatchCronWorkflow` narrows the repo list itself and dispatches one
    // run per surviving repo, so its `dispatched` IS the participating-repo
    // count (`fanout.ts` returns `results.length`). `repos` absent → a single
    // dispatch with no repo list at all, hence the null counts.
    const eligible = Array.isArray(context.repos)
      ? (context.repos as unknown[]).filter((r) => typeof r === "string" && r.length > 0).length
      : null;
    const { dispatched, failures } = await dispatchCronWorkflow(workflowName, context, dispatch);
    return {
      reposEligible: eligible,
      reposScanned: eligible === null ? null : dispatched,
      discovered: null,
      dispatched,
      failures,
    };
  }

  const candidates = Array.isArray(context.repos)
    ? (context.repos as unknown[]).filter((r): r is string => typeof r === "string")
    : [];

  // Narrow to the repos that actually participate in THIS cron before
  // discovering anything (issue #180). A discovery cron fans out per discovered
  // PR rather than per repo, so it bypasses `dispatchCronWorkflow` and must
  // resolve participation itself — otherwise a repo that opted out of e.g.
  // `dependabot-merge` would still get runs.
  // A missing name means a caller that built its own context, and the list is
  // then used VERBATIM — resolving with no cron would apply participation rules
  // that this fire never asked for.
  const cronName = typeof context[CRON_NAME_KEY] === "string" ? (context[CRON_NAME_KEY] as string) : "";
  const repos = cronName
    ? (
        await resolveRepos({
          cron: cronName,
          repos: candidates,
          // Absent means "on" — only jobs.ts marks a cron globally off.
          globallyEnabled: context[CRON_GLOBALLY_ENABLED_KEY] !== false,
        })
      ).repos
    : candidates;
  if (repos.length !== candidates.length) {
    log.info("Repo(s) participate in this cron", {
      cronName,
      participating: repos.length,
      candidates: candidates.length,
    });
  }

  // Every repo opted out (or a globally-off cron nobody opted into) — no
  // discovery calls, no dispatches, no failure. A cheap no-op tick. The
  // discoverer's `log` callback carries per-repo diagnostics that can fire once
  // per managed repo per tick, so it stays `.debug`.
  const prs = github && repos.length ? await discoverer(repos, github, { log: (m) => log.debug(m) }) : [];

  const contexts = prs.map((pr) => ({
    _triggerType: "cron",
    repo: pr.repo,
    prNumber: pr.prNumber,
    title: pr.title,
    // Present only for the red sweep — `dispatchWorkflow` pre-clones this head
    // ref for dependabot-ci-fix's checkout (a PR_FIX_SHAPED_WORKFLOWS).
    ...(pr.branch ? { branch: pr.branch } : {}),
    // Also red-sweep only — why it was summoned (checks-failing | behind |
    // dirty | blocked), threaded into the ci-fix prompt as `{{reason}}`.
    ...(pr.reason ? { reason: pr.reason } : {}),
    // The review sweep announces itself, because `resolveReviewTrigger` treats
    // it differently from a PR-attention event: `after-checks` will not fire on
    // attention, and the sweep is the RELEASE MECHANISM for every PR whose fix
    // chain ended without pushing — no new commit exists, so no further
    // `check_suite` will ever fire for it (09 → S2).
    ...(discoverKey === "prs-awaiting-review" ? { _reviewRoute: "sweep" } : {}),
  }));

  const { dispatched, failures } = await fanOutContexts(workflowName, contexts, dispatch);
  return {
    reposEligible: candidates.length,
    reposScanned: repos.length,
    discovered: prs.length,
    dispatched,
    failures,
    discoverKey,
  };
}
