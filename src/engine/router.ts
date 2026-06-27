import type { EventEnvelope } from "../connectors/types.js";
import { classifyComment, classifyIssueIsQuestion } from "./classifier.js";
import { screenForInjection, flagPrefix } from "./screen.js";
import { getManagedRepos, isManagedRepo } from "../managed-repos.js";
import { getRoutes } from "../config.js";
import type { StateDb } from "../state/db.js";

/**
 * A routing decision — the single term for "what should process this event"
 * is `handler`. It names either an in-process handler (chat, status-report,
 * approval-response, …) or a workflow (issue-triage, pr-review, build, …);
 * the dispatcher decides which. The router itself performs no side effects.
 */
export type Route =
  | { action: "handler"; handler: string; context: Record<string, unknown> }
  | { action: "reply"; message: string }
  | { action: "ignore"; reason: string };

/** Optional dependencies the router needs to short-circuit paused runs. */
export interface RouterDeps {
  db?: StateDb;
}

/** Friendly reply when a Slack/CLI command targets an unmanaged repo. */
function unmanagedRepoReply(repo: string): string {
  return (
    `❌ I'm not configured to work on \`${repo}\`.\n` +
    `Managed repos: ${getManagedRepos().map((r) => `\`${r}\``).join(", ")}.\n` +
    `Ask cliftonc to add it.`
  );
}

/**
 * Managed-repo gate shared by every Slack command that targets a repo.
 * Returns `{ ok: true, repo }` when the repo is present and managed, or
 * `{ ok: false, route }` carrying the reply Route to short-circuit with —
 * a missing-repo prompt or the unmanaged-repo reply. Collapses the guard
 * that was copy-pasted across triage/review/security/explore.
 */
function requireManagedRepo(
  repo: string | undefined,
  missingReply: string,
): { ok: true; repo: string } | { ok: false; route: Route } {
  if (!repo) return { ok: false, route: { action: "reply", message: missingReply } };
  if (!isManagedRepo(repo)) {
    return { ok: false, route: { action: "reply", message: unmanagedRepoReply(repo) } };
  }
  return { ok: true, repo };
}

/** Author associations that can trigger builds via @mention */
const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Bot mention pattern — case-insensitive */
const BOT_MENTION = /@last-light\b/i;

/**
 * Event routing — deterministic for most events, LLM-classified for comments.
 * Maps normalized events to the handler that should process them. Returns a
 * decision only; the dispatcher performs the side effects.
 */
export async function routeEvent(
  envelope: EventEnvelope,
  deps: RouterDeps = {},
): Promise<Route> {
  const routes = getRoutes();
  const gh = routes.github;
  const slack = routes.slack;
  switch (envelope.type) {
    case "issue.opened": {
      // Pure question issues ("how does X work?", "X vs Y?") want an ANSWER,
      // not a code change — route them to the dedicated answer workflow (web
      // search + its own model) instead of triage, which would otherwise file
      // a question as an enhancement and write an agent brief. Classified with
      // the same cheap model as comments; WORK is the safe default.
      const isQuestion = await classifyIssueIsQuestion(
        envelope.title || "",
        envelope.body || "",
      );
      console.log(
        `[router] New issue ${envelope.repo}#${envelope.issueNumber} classified as: ${isQuestion ? "question" : "work"}`,
      );
      return {
        action: "handler",
        handler: isQuestion
          ? gh.issue_answer || "answer"
          : gh.issue_opened || "issue-triage",
        context: {
          repo: envelope.repo,
          issueNumber: envelope.issueNumber,
          title: envelope.title,
          body: envelope.body,
          sender: envelope.sender,
          labels: envelope.labels,
        },
      };
    }

    case "issue.reopened":
      return {
        action: "handler",
        handler: gh.issue_reopened || "issue-triage",
        context: {
          repo: envelope.repo,
          issueNumber: envelope.issueNumber,
          title: envelope.title,
          body: envelope.body,
          sender: envelope.sender,
          reopened: true,
        },
      };

    case "pr.opened":
    case "pr.synchronize":
    case "pr.reopened":
      // All three deserve a fresh review on the current head SHA. The
      // pr-review skill's "skip if already reviewed this SHA" guard covers
      // the no-op case (e.g. synchronize triggered by a non-code change
      // when we already reviewed the resulting SHA), so a stable handler
      // for every PR-attention event is correct.
      return {
        action: "handler",
        handler: gh[`pr_${envelope.type.split(".")[1]}`] || "pr-review",
        context: {
          _routeKey: `github.pr_${envelope.type.split(".")[1]}`,
          repo: envelope.repo,
          prNumber: envelope.prNumber,
          title: envelope.title,
          body: envelope.body,
          sender: envelope.sender,
          labels: envelope.labels,
        },
      };

    case "comment.created": {
      // Reply-gate short-circuit: if a paused socratic explore run is
      // waiting for any free-form message on this issue, feed the comment
      // body through without requiring an @mention or maintainer check.
      // Must sit ABOVE both the mention and role checks so plain replies
      // resume the conversation naturally.
      if (deps.db && envelope.issueNumber) {
        const triggerId = `${envelope.repo}#${envelope.issueNumber}`;
        const pendingReply = deps.db.approvals.getPendingReplyGateByTrigger(triggerId);
        if (pendingReply) {
          return {
            action: "handler",
            handler: gh.explore_reply || "explore-reply",
            context: {
              repo: envelope.repo,
              issueNumber: envelope.issueNumber,
              sender: envelope.sender,
              reply: envelope.body,
              workflowRunId: pendingReply.workflowRunId,
            },
          };
        }
      }

      // Only act on @last-light mentions
      if (!BOT_MENTION.test(envelope.body)) {
        return { action: "ignore", reason: "no bot mention in comment" };
      }

      // Only maintainers (OWNER, MEMBER, COLLABORATOR) can trigger builds.
      // For non-maintainers we reply directly via the connector — no agent
      // invocation needed.
      if (!MAINTAINER_ROLES.has(envelope.authorAssociation || "")) {
        return {
          action: "reply",
          message:
            `Thanks for the report, @${envelope.sender}! ` +
            `I only act on requests from repository maintainers — a maintainer ` +
            `(owner / member / collaborator) needs to mention me to trigger a build.`,
        };
      }

      // Check for approval commands before LLM classification
      const approveMatch = envelope.body.match(/@last-light\s+approve\b/i);
      const rejectMatch = envelope.body.match(/@last-light\s+reject\b(.*)/i);
      if (approveMatch || rejectMatch) {
        return {
          action: "handler",
          handler: gh.approval_response || "approval-response",
          context: {
            repo: envelope.repo,
            issueNumber: envelope.issueNumber,
            sender: envelope.sender,
            decision: approveMatch ? "approved" : "rejected",
            reason: rejectMatch ? rejectMatch[1].trim() || undefined : undefined,
          },
        };
      }

      // Structured match for security-review before LLM classification
      const securityMatch = envelope.body.match(/@last-light\s+security-review\b/i);
      if (securityMatch) {
        return {
          action: "handler",
          handler: gh.security_review || "security-review",
          context: { repo: envelope.repo, sender: envelope.sender, source: envelope.source },
        };
      }

      // Structured matches for verify / qa-test before LLM classification.
      // Everything after the command word is the claim (verify) or the
      // target/steps (qa-test); it flows through as `commentBody`. Both work on
      // issues and PRs. Maintainer-gated above, like security-review.
      const verifyMatch = envelope.body.match(/@last-light\s+verify\b([\s\S]*)/i);
      if (verifyMatch) {
        return {
          action: "handler",
          handler: gh.verify || "verify",
          context: {
            repo: envelope.repo,
            issueNumber: envelope.issueNumber,
            ...(envelope.prNumber ? { prNumber: envelope.prNumber } : {}),
            title: envelope.title,
            sender: envelope.sender,
            commentBody: verifyMatch[1].trim() || envelope.body,
          },
        };
      }
      const qaTestMatch = envelope.body.match(/@last-light\s+qa-test\b([\s\S]*)/i);
      if (qaTestMatch) {
        return {
          action: "handler",
          handler: gh.qa_test || "qa-test",
          context: {
            repo: envelope.repo,
            issueNumber: envelope.issueNumber,
            ...(envelope.prNumber ? { prNumber: envelope.prNumber } : {}),
            title: envelope.title,
            sender: envelope.sender,
            commentBody: qaTestMatch[1].trim() || envelope.body,
          },
        };
      }
      // `@last-light demo [notes]` — record a demo video of the PR/feature.
      // Anything after the command word flows through as `commentBody` (demo
      // scope/notes). Gated to the docker QA image at the workflow level; on a
      // host without it the demo phase silently skips.
      const demoMatch = envelope.body.match(/@last-light\s+demo\b([\s\S]*)/i);
      if (demoMatch) {
        return {
          action: "handler",
          handler: gh.demo || "demo",
          context: {
            repo: envelope.repo,
            issueNumber: envelope.issueNumber,
            ...(envelope.prNumber ? { prNumber: envelope.prNumber } : {}),
            title: envelope.title,
            sender: envelope.sender,
            commentBody: demoMatch[1].trim() || envelope.body,
          },
        };
      }

      // Classify intent + screen for injection in parallel. Both run on the
      // same comment text and have similar latency (single haiku call); doing
      // them in parallel keeps overall router latency at max(classifier, screener)
      // rather than their sum.
      const [{ intent }, screen] = await Promise.all([
        classifyComment(envelope.body, {
          issueTitle: envelope.title,
          isPullRequest: !!envelope.prNumber,
        }),
        screenForInjection(envelope.body),
      ]);
      console.log(
        `[router] Comment classified as: ${intent}` +
        (screen.flagged ? ` [screener flagged: ${screen.reason || "no reason"}]` : ""),
      );

      // When the screener flags, prefix the commentBody with a one-line
      // warning. Downstream agents anchored by agent-context/security.md
      // treat flagged content skeptically. Never refuse — false positives
      // shouldn't break legitimate comments.
      const commentBody = screen.flagged
        ? `${flagPrefix(screen.reason)}${envelope.body}`
        : envelope.body;

      if (envelope.prNumber) {
        // PR comments:
        //   build    → pr-fix (full Architect→Executor→Reviewer fix loop)
        //   verify   → verify (test a behavioural claim against the PR)
        //   qa-test  → qa-test (drive a flow against the PR, step pass/fail)
        //   else     → pr-comment (diff-aware Q&A; the issue-comment skill
        //              caps at 2 file reads which isn't enough to answer
        //              "does this PR consider X?" with code-cited evidence)
        // Explore isn't meaningful on PRs since the code already exists.
        const { handler: prHandler, routeKey: prRouteKey } =
          intent === "build" ? { handler: gh.pr_fix || "pr-fix", routeKey: "github.pr_fix" }
          : intent === "verify" ? { handler: gh.verify || "verify", routeKey: "github.verify" }
          : intent === "qa-test" ? { handler: gh.qa_test || "qa-test", routeKey: "github.qa_test" }
          : intent === "demo" ? { handler: gh.demo || "demo", routeKey: "github.demo" }
          : { handler: gh.pr_comment || "pr-comment", routeKey: "github.pr_comment" };
        return {
          action: "handler",
          handler: prHandler,
          context: {
            _routeKey: prRouteKey,
            repo: envelope.repo,
            prNumber: envelope.prNumber,
            issueNumber: envelope.issueNumber,
            title: envelope.title,
            body: envelope.body,
            sender: envelope.sender,
            commentBody,
          },
        };
      }

      // Issue comments: build → full build cycle, explore → socratic
      // explore workflow, security scan summary issues → security-feedback,
      // otherwise → issue-comment.
      //
      // Key on `security-scan` (not just `security`) so we only divert to
      // security-feedback on the per-run SUMMARY issue. Broken-out sub-issues
      // carry `["security", severity]` (no `security-scan`) and must stay on
      // the normal build/issue-comment path — "@last-light build this fix"
      // on a sub-issue needs the real build cycle, not security-feedback.
      //
      // ALL comment intents on a summary issue funnel to security-feedback
      // — including BUILD ("create issues for the highs" looks like build to
      // the classifier but is really a break-out request). Approve/reject
      // regex matches already returned above, so they don't reach here.
      const hasScanSummaryLabel = (envelope.labels || []).includes("security-scan");
      if (hasScanSummaryLabel) {
        return {
          action: "handler",
          handler: gh.security_feedback || "security-feedback",
          context: {
            repo: envelope.repo,
            issueNumber: envelope.issueNumber,
            title: envelope.title,
            body: envelope.body,
            sender: envelope.sender,
            commentBody,
          },
        };
      }
      const { handler: issueSkill, routeKey: issueRouteKey } =
        intent === "build" ? { handler: gh.issue_build || "github-orchestrator", routeKey: "github.issue_build" }
        : intent === "explore" ? { handler: gh.issue_explore || "explore", routeKey: "github.issue_explore" }
        : intent === "verify" ? { handler: gh.verify || "verify", routeKey: "github.verify" }
        : intent === "qa-test" ? { handler: gh.qa_test || "qa-test", routeKey: "github.qa_test" }
        : intent === "demo" ? { handler: gh.demo || "demo", routeKey: "github.demo" }
        : { handler: gh.issue_comment || "issue-comment", routeKey: "github.issue_comment" };
      return {
        action: "handler",
        handler: issueSkill,
        context: {
          _routeKey: issueRouteKey,
          repo: envelope.repo,
          issueNumber: envelope.issueNumber,
          title: envelope.title,
          body: envelope.body,
          sender: envelope.sender,
          commentBody,
        },
      };
    }

    case "pr_review.submitted":
    case "pr_review_comment.created":
      return { action: "ignore", reason: "PR review events not yet handled" };

    case "message": {
      const text = envelope.body.trim();
      const raw = envelope.raw as Record<string, unknown> | undefined;
      const channelId = raw?.channelId as string | undefined;
      const threadId = raw?.threadId as string | undefined;
      const teamId = (raw?.team as string | undefined) || (raw?.team_id as string | undefined) || "slack";
      const slackTriggerId = channelId && threadId
        ? `slack:${teamId}:${channelId}:${threadId}`
        : undefined;

      // Reply-gate short-circuit: if a paused socratic explore run is
      // waiting on this Slack thread, feed the message body through as
      // the next reply — this must sit above all slash-command handling
      // so replies don't get mis-parsed as commands.
      if (deps.db && slackTriggerId) {
        const pendingReply = deps.db.approvals.getPendingReplyGateByTrigger(slackTriggerId);
        if (pendingReply) {
          return {
            action: "handler",
            handler: slack.explore_reply || "explore-reply",
            context: {
              sender: envelope.sender,
              reply: text,
              workflowRunId: pendingReply.workflowRunId,
              source: envelope.source,
              triggerId: slackTriggerId,
              channelId,
              threadId,
            },
          };
        }
      }

      // Classify all Slack messages via the LLM classifier — no regex
      // commands. The classifier extracts intent, repo, issue number, and
      // reject reason from natural language. Screen for injection in parallel
      // (Slack messages are user-supplied text and reach the chat skill or a
      // workflow, both of which need the flag annotation).
      const [classification, screen] = await Promise.all([
        classifyComment(text),
        screenForInjection(text),
      ]);
      const {
        intent,
        repo: classifiedRepo,
        issueNumber: classifiedIssue,
        reason: classifiedReason,
      } = classification;
      console.log(
        `[router] Slack message classified as: ${intent}` +
        `${classifiedRepo ? ` (repo: ${classifiedRepo})` : ""}` +
        `${classifiedIssue ? ` (#${classifiedIssue})` : ""}` +
        (screen.flagged ? ` [screener flagged: ${screen.reason || "no reason"}]` : ""),
      );

      const slackText = screen.flagged ? `${flagPrefix(screen.reason)}${text}` : text;

      switch (intent) {
        case "reset":
          return {
            action: "handler",
            handler: slack.reset || "chat-reset",
            context: { sessionId: raw?.sessionId, sender: envelope.sender, source: envelope.source },
          };

        case "status":
          return {
            action: "handler",
            handler: slack.status || "status-report",
            context: { sender: envelope.sender, source: envelope.source },
          };

        case "approve":
          return {
            action: "handler",
            handler: slack.approve || "approval-response",
            context: { sender: envelope.sender, decision: "approved", source: envelope.source },
          };

        case "reject":
          return {
            action: "handler",
            handler: slack.reject || "approval-response",
            context: {
              sender: envelope.sender,
              decision: "rejected",
              reason: classifiedReason,
              source: envelope.source,
            },
          };

        case "build": {
          // No repo + no issue context → classifier likely over-fired on
          // an imperative verb ("delete files in X", "clean up my docs").
          // Fall through to chat rather than nag the user for a repo.
          if (!classifiedRepo) {
            return {
              action: "handler",
              handler: slack.chat || "chat",
              context: {
                sessionId: raw?.sessionId,
                message: slackText,
                sender: envelope.sender,
                source: envelope.source,
              },
            };
          }
          if (!isManagedRepo(classifiedRepo)) {
            return { action: "reply", message: unmanagedRepoReply(classifiedRepo) };
          }
          return {
            action: "handler",
            handler: slack.build || "github-orchestrator",
            context: {
              _routeKey: "slack.build",
              repo: classifiedRepo,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              commentBody: slackText,
              source: envelope.source,
            },
          };
        }

        case "triage": {
          const gate = requireManagedRepo(
            classifiedRepo,
            "Which repo should I triage? e.g. `triage cliftonc/repo`",
          );
          if (!gate.ok) return gate.route;
          return {
            action: "handler",
            handler: slack.triage || "issue-triage",
            context: { repo: gate.repo, sender: envelope.sender, source: envelope.source },
          };
        }

        case "review": {
          const gate = requireManagedRepo(
            classifiedRepo,
            "Which repo should I review PRs for? e.g. `review cliftonc/repo`",
          );
          if (!gate.ok) return gate.route;
          return {
            action: "handler",
            handler: slack.review || "pr-review",
            context: {
              repo: gate.repo,
              prNumber: classifiedIssue,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              source: envelope.source,
            },
          };
        }

        case "security": {
          const gate = requireManagedRepo(
            classifiedRepo,
            "Which repo should I scan? e.g. `security review cliftonc/repo`",
          );
          if (!gate.ok) return gate.route;
          return {
            action: "handler",
            handler: slack.security || "security-review",
            context: { repo: gate.repo, sender: envelope.sender, source: envelope.source },
          };
        }

        case "verify": {
          const gate = requireManagedRepo(
            classifiedRepo,
            "Which repo should I verify? e.g. `verify cliftonc/repo#42 — the fork flag creates a new session`",
          );
          if (!gate.ok) return gate.route;
          return {
            action: "handler",
            handler: slack.verify || "verify",
            context: {
              repo: gate.repo,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              commentBody: slackText,
              source: envelope.source,
              triggerId: slackTriggerId,
              channelId,
              threadId,
            },
          };
        }

        case "qa-test": {
          const gate = requireManagedRepo(
            classifiedRepo,
            "Which repo should I QA-test? e.g. `qa-test cliftonc/repo#42 -- login, create a project`",
          );
          if (!gate.ok) return gate.route;
          return {
            action: "handler",
            handler: slack.qa_test || "qa-test",
            context: {
              repo: gate.repo,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              commentBody: slackText,
              source: envelope.source,
              triggerId: slackTriggerId,
              channelId,
              threadId,
            },
          };
        }

        case "question": {
          // A substantive question targeting a managed repo → run the sandboxed
          // answer workflow (web search + repo docs), delivered back to this
          // thread. A repo-less question can't seed a sandbox workspace, so it
          // falls through to in-process chat for a quick answer (mirrors build).
          if (!classifiedRepo) {
            return {
              action: "handler",
              handler: slack.chat || "chat",
              context: {
                sessionId: raw?.sessionId,
                message: slackText,
                sender: envelope.sender,
                source: envelope.source,
              },
            };
          }
          if (!isManagedRepo(classifiedRepo)) {
            return { action: "reply", message: unmanagedRepoReply(classifiedRepo) };
          }
          return {
            action: "handler",
            handler: slack.answer || "answer",
            context: {
              repo: classifiedRepo,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              commentBody: slackText,
              source: envelope.source,
              triggerId: slackTriggerId,
              channelId,
              threadId,
            },
          };
        }

        case "explore": {
          const gate = requireManagedRepo(
            classifiedRepo,
            "I'd love to help explore that idea, but I need to know which repo to work against. " +
              "Could you restate your request and include the repo? For example: " +
              '"let\'s explore adding webhooks to cliftonc/lastlight"',
          );
          if (!gate.ok) return gate.route;
          return {
            action: "handler",
            handler: slack.explore || "explore",
            context: {
              repo: gate.repo,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              commentBody: slackText,
              source: envelope.source,
              triggerId: slackTriggerId,
              channelId,
              threadId,
            },
          };
        }

        default:
          // chat — conversational reply
          return {
            action: "handler",
            handler: slack.chat || "chat",
            context: {
              sessionId: raw?.sessionId,
              message: slackText,
              sender: envelope.sender,
              source: envelope.source,
            },
          };
      }
    }

    default:
      return { action: "ignore", reason: `unhandled event type: ${envelope.type}` };
  }
}
