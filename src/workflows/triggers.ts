import { getCronWorkflows } from "./loader.js";
import { getRoutes } from "../config.js";

export type TriggerInfo =
  | { kind: "cron"; name: string; schedule: string }
  | { kind: "github"; event: string; description: string }
  | { kind: "slack"; command: string; description: string }
  | { kind: "mention"; description: string }
  | { kind: "internal"; description: string };

function add(map: Map<string, TriggerInfo[]>, name: string | undefined, info: TriggerInfo): void {
  if (!name) return;
  const effectiveName = name === "github-orchestrator" ? "build" : name;
  map.set(effectiveName, [...(map.get(effectiveName) || []), info]);
}

function routeTriggers(): Map<string, TriggerInfo[]> {
  const routes = getRoutes();
  const map = new Map<string, TriggerInfo[]>();
  add(map, routes.github.issue_opened, { kind: "github", event: "issue.opened", description: "An issue is opened" });
  add(map, routes.github.issue_reopened, { kind: "github", event: "issue.reopened", description: "An issue is reopened" });
  add(map, routes.github.pr_opened, { kind: "github", event: "pr.opened", description: "A PR is opened" });
  add(map, routes.github.pr_synchronize, { kind: "github", event: "pr.synchronize", description: "A PR is updated" });
  add(map, routes.github.pr_reopened, { kind: "github", event: "pr.reopened", description: "A PR is reopened" });
  add(map, routes.github.pr_fix, { kind: "mention", description: "`@last-light build …` on a PR comment (maintainers only)" });
  add(map, routes.github.pr_comment, { kind: "mention", description: "`@last-light <message>` on a PR comment / review" });
  add(map, routes.github.issue_build, { kind: "mention", description: "`@last-light build …` on an issue comment (maintainers only)" });
  add(map, routes.github.issue_explore, { kind: "mention", description: "`@last-light explore …` on an issue comment" });
  add(map, routes.github.issue_comment, { kind: "mention", description: "`@last-light <message>` on an issue comment" });
  add(map, routes.github.security_feedback, { kind: "internal", description: "Chained from `security-review` when issues are found" });
  add(map, routes.slack.build, { kind: "slack", command: "build", description: "Slack: `build <repo>#<n>`" });
  add(map, routes.slack.triage, { kind: "slack", command: "triage", description: "Slack: `triage <repo>`" });
  add(map, routes.slack.review, { kind: "slack", command: "review", description: "Slack: `review <repo>`" });
  add(map, routes.slack.security, { kind: "slack", command: "security", description: "Slack: `security <repo>`" });
  add(map, routes.slack.explore, { kind: "slack", command: "explore", description: "Slack: `explore <repo>#<n>`" });
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
