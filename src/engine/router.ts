import type { EventEnvelope } from "../connectors/types.js";
import { classifyComment } from "./classifier.js";
import { screenForInjection, flagPrefix } from "./screen.js";
import { isManagedRepo, MANAGED_REPOS } from "../managed-repos.js";
import type { StateDb } from "../state/db.js";

/** Skill name that should handle this event */
export type RoutingResult =
  | { action: "skill"; skill: string; context: Record<string, unknown> }
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
    `Managed repos: ${MANAGED_REPOS.map((r) => `\`${r}\``).join(", ")}.\n` +
    `Ask cliftonc to add it.`
  );
}

/** Author associations that can trigger builds via @mention */
const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Bot mention pattern — case-insensitive */
const BOT_MENTION = /@last-light\b/i;

/**
 * Event routing — deterministic for most events, LLM-classified for comments.
 * Maps normalized events to the skill that should handle them.
 */
export async function routeEvent(
  envelope: EventEnvelope,
  deps: RouterDeps = {},
): Promise<RoutingResult> {
  switch (envelope.type) {
    case "issue.opened":
      return {
        action: "skill",
        skill: "issue-triage",
        context: {
          repo: envelope.repo,
          issueNumber: envelope.issueNumber,
          title: envelope.title,
          body: envelope.body,
          sender: envelope.sender,
          labels: envelope.labels,
        },
      };

    case "issue.reopened":
      return {
        action: "skill",
        skill: "issue-triage",
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
        action: "skill",
        skill: "pr-review",
        context: {
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
        const pendingReply = deps.db.getPendingReplyGateByTrigger(triggerId);
        if (pendingReply) {
          return {
            action: "skill",
            skill: "explore-reply",
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
          action: "skill",
          skill: "approval-response",
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
          action: "skill",
          skill: "security-review",
          context: { repo: envelope.repo, sender: envelope.sender, source: envelope.source },
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
        //   build → pr-fix (full Architect→Executor→Reviewer fix loop)
        //   else  → pr-comment (diff-aware Q&A; the issue-comment skill
        //           caps at 2 file reads which isn't enough to answer
        //           "does this PR consider X?" with code-cited evidence)
        // Explore isn't meaningful on PRs since the code already exists.
        return {
          action: "skill",
          skill: intent === "build" ? "pr-fix" : "pr-comment",
          context: {
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
          action: "skill",
          skill: "security-feedback",
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
      const issueSkill = intent === "build"
        ? "github-orchestrator"
        : intent === "explore"
        ? "explore"
        : "issue-comment";
      return {
        action: "skill",
        skill: issueSkill,
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
        const pendingReply = deps.db.getPendingReplyGateByTrigger(slackTriggerId);
        if (pendingReply) {
          return {
            action: "skill",
            skill: "explore-reply",
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
            action: "skill",
            skill: "chat-reset",
            context: { sessionId: raw?.sessionId, sender: envelope.sender, source: envelope.source },
          };

        case "status":
          return {
            action: "skill",
            skill: "status-report",
            context: { sender: envelope.sender, source: envelope.source },
          };

        case "approve":
          return {
            action: "skill",
            skill: "approval-response",
            context: { sender: envelope.sender, decision: "approved", source: envelope.source },
          };

        case "reject":
          return {
            action: "skill",
            skill: "approval-response",
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
              action: "skill",
              skill: "chat",
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
            action: "skill",
            skill: "github-orchestrator",
            context: {
              repo: classifiedRepo,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              commentBody: slackText,
              source: envelope.source,
            },
          };
        }

        case "triage": {
          if (!classifiedRepo) {
            return { action: "reply", message: "Which repo should I triage? e.g. `triage cliftonc/repo`" };
          }
          if (!isManagedRepo(classifiedRepo)) {
            return { action: "reply", message: unmanagedRepoReply(classifiedRepo) };
          }
          return {
            action: "skill",
            skill: "issue-triage",
            context: { repo: classifiedRepo, sender: envelope.sender, source: envelope.source },
          };
        }

        case "review": {
          if (!classifiedRepo) {
            return { action: "reply", message: "Which repo should I review PRs for? e.g. `review cliftonc/repo`" };
          }
          if (!isManagedRepo(classifiedRepo)) {
            return { action: "reply", message: unmanagedRepoReply(classifiedRepo) };
          }
          return {
            action: "skill",
            skill: "pr-review",
            context: {
              repo: classifiedRepo,
              prNumber: classifiedIssue,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              source: envelope.source,
            },
          };
        }

        case "security": {
          if (!classifiedRepo) {
            return { action: "reply", message: "Which repo should I scan? e.g. `security review cliftonc/repo`" };
          }
          if (!isManagedRepo(classifiedRepo)) {
            return { action: "reply", message: unmanagedRepoReply(classifiedRepo) };
          }
          return {
            action: "skill",
            skill: "security-review",
            context: { repo: classifiedRepo, sender: envelope.sender, source: envelope.source },
          };
        }

        case "explore": {
          if (!classifiedRepo || !isManagedRepo(classifiedRepo)) {
            return {
              action: "reply",
              message: classifiedRepo
                ? unmanagedRepoReply(classifiedRepo)
                : "I'd love to help explore that idea, but I need to know which repo to work against. " +
                  "Could you restate your request and include the repo? For example: " +
                  "\"let's explore adding webhooks to cliftonc/lastlight\"",
            };
          }
          return {
            action: "skill",
            skill: "explore",
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

        default:
          // chat — conversational reply
          return {
            action: "skill",
            skill: "chat",
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
