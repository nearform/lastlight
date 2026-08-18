import { getCronWorkflows, getWorkflowByIntent, listAgentWorkflows } from "./loader.js";
import { getRoutes, getBotName } from "../config/config.js";

/**
 * Resolve a classifier intent to the handler the router would pick, using the
 * same `routes` map the router consults (slack keys use `_`, intents use `-`),
 * falling back to the workflow that claims the intent, then the intent itself.
 *
 * Lives here rather than in `admin/routes.ts` (its original home) because the
 * trigger table below needs the same mapping — a second copy of this three-way
 * fallback is exactly the kind of drift this module is being cleaned of.
 */
export function resolveIntentHandler(intent: string): string {
  const routes = getRoutes();
  const key = intent.replace(/-/g, "_");
  return routes.slack[intent] ?? routes.slack[key] ?? getWorkflowByIntent(intent)?.name ?? intent;
}

export type TriggerInfo =
  | { kind: "cron"; name: string; schedule: string }
  | { kind: "github"; event: string; description: string }
  | { kind: "slack"; command: string; description: string }
  | { kind: "mention"; description: string }
  | { kind: "internal"; description: string };

function add(map: Map<string, TriggerInfo[]>, name: string | undefined, info: TriggerInfo): void {
  if (!name) return;
  map.set(name, [...(map.get(name) || []), info]);
}

function routeTriggers(): Map<string, TriggerInfo[]> {
  const routes = getRoutes();
  const bot = `@${getBotName()}`;
  const map = new Map<string, TriggerInfo[]>();
  add(map, routes.github.issue_opened, { kind: "github", event: "issue.opened", description: "An issue is opened" });
  add(map, routes.github.issue_reopened, { kind: "github", event: "issue.reopened", description: "An issue is reopened" });
  add(map, routes.github.pr_opened, { kind: "github", event: "pr.opened", description: "A PR is opened" });
  add(map, routes.github.pr_synchronize, { kind: "github", event: "pr.synchronize", description: "A PR is updated" });
  add(map, routes.github.pr_reopened, { kind: "github", event: "pr.reopened", description: "A PR is reopened" });
  add(map, routes.github.pr_fix, { kind: "mention", description: `\`${bot} build …\` on a PR comment (maintainers only)` });
  add(map, routes.github.pr_comment, { kind: "mention", description: `\`${bot} <message>\` on a PR comment / review` });
  add(map, routes.github.issue_build, { kind: "mention", description: `\`${bot} build …\` on an issue comment (maintainers only)` });
  add(map, routes.github.issue_explore, { kind: "mention", description: `\`${bot} explore …\` on an issue comment` });
  add(map, routes.github.issue_comment, { kind: "mention", description: `\`${bot} <message>\` on an issue comment` });
  add(map, routes.github.security_feedback, { kind: "internal", description: "Chained from `security-review` when issues are found" });
  // The three structured `@bot <verb>` commands the router matches before it
  // ever reaches the classifier (maintainer-gated, like security-review).
  add(map, routes.github.security_review, { kind: "mention", description: `\`${bot} security-review\` on an issue / PR comment (maintainers only)` });
  add(map, routes.github.verify, { kind: "mention", description: `\`${bot} verify <claim>\` on an issue / PR comment (maintainers only)` });
  add(map, routes.github.qa_test, { kind: "mention", description: `\`${bot} qa-test <target>\` on an issue / PR comment (maintainers only)` });
  add(map, routes.github.demo, { kind: "mention", description: `\`${bot} demo <notes>\` on an issue / PR comment (maintainers only)` });

  // Slack triggers are DERIVED from each workflow's own `chat:` block — the same
  // source the chat agent advertises from (see engine/chat/chat-prompt.ts) —
  // rather than a hand-kept list. The list here used to name five workflows
  // while the router routed nine, so the dashboard showed no Slack trigger for
  // verify / qa-test / demo / answer.
  //
  // Gate on the CLASSIFICATION intent, not the chat trigger: the intent is what
  // the Slack switch dispatches on, so a `chat:` entry without one (repo-health,
  // which is cron-only) correctly contributes nothing here. The trigger phrase is
  // only the description, and falls back to the summary for a workflow with no
  // fixed phrase to type — `answer` is reached by asking a research question, not
  // by typing a command.
  for (const def of listAgentWorkflows()) {
    const intent = def.classification?.intent;
    if (!intent || !def.chat) continue;
    const { trigger, summary } = def.chat;
    add(map, resolveIntentHandler(intent), {
      kind: "slack",
      command: intent,
      description: trigger ? `Slack: \`${trigger}\`` : `Slack: ${summary}`,
    });
  }
  return map;
}

export function getWorkflowTriggers(workflowName: string): TriggerInfo[] {
  const cronTriggers: TriggerInfo[] = getCronWorkflows()
    .filter((c) => c.workflow === workflowName)
    .map((c) => ({ kind: "cron" as const, name: c.name, schedule: c.schedule }));
  return [...cronTriggers, ...(routeTriggers().get(workflowName) ?? [])];
}

export function getWorkflowTriggerKinds(workflowName: string): TriggerInfo["kind"][] {
  const triggers = getWorkflowTriggers(workflowName);
  const seen = new Set<TriggerInfo["kind"]>();
  for (const t of triggers) seen.add(t.kind);
  const order: TriggerInfo["kind"][] = ["cron", "github", "mention", "slack", "internal"];
  return order.filter((k) => seen.has(k));
}
