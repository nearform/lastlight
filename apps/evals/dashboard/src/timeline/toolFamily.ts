import {
  Terminal,
  FileText,
  FilePlus,
  PenLine,
  FolderOpen,
  Search,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquare,
  Globe,
  Download,
  ListChecks,
  Bot,
  BookOpen,
  Plug,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type ToolFamily =
  | "shell"
  | "fs"
  | "git"
  | "web"
  | "plan"
  | "mcp"
  | "other";

const FAMILY_BY_NAME: Record<string, ToolFamily> = {
  terminal: "shell",
  bash: "shell",
  shell: "shell",

  read_file: "fs",
  write_file: "fs",
  edit_file: "fs",
  list_files: "fs",
  search_files: "fs",
  read: "fs",
  write: "fs",
  edit: "fs",
  grep: "fs",
  glob: "fs",

  web_fetch: "web",
  web_search: "web",
  webfetch: "web",
  websearch: "web",

  todo: "plan",
  todowrite: "plan",
  task: "plan",
  skill_view: "plan",
};

const GIT_NAME_HINTS = [
  "commit",
  "branch",
  "repo",
  "repository",
  "pull_request",
  "pr_",
  "issue",
  "comment",
  "push",
  "clone",
  "merge",
  "tag",
  "release",
];

export function classifyTool(toolName: string): ToolFamily {
  const lower = toolName.toLowerCase();
  const direct = FAMILY_BY_NAME[lower];
  if (direct) return direct;
  if (lower.startsWith("mcp_github_") || lower.startsWith("github_")) return "git";
  if (lower.startsWith("mcp_")) {
    if (GIT_NAME_HINTS.some((h) => lower.includes(h))) return "git";
    return "mcp";
  }
  return "other";
}

export interface FamilyVisual {
  Icon: LucideIcon;
  color: string;
  bg: string;
}

export const FAMILY_VISUAL: Record<ToolFamily, FamilyVisual> = {
  shell: { Icon: Terminal, color: "text-primary", bg: "bg-primary/15" },
  fs: { Icon: FileText, color: "text-info", bg: "bg-info/15" },
  git: { Icon: GitBranch, color: "text-warning", bg: "bg-warning/15" },
  web: { Icon: Globe, color: "text-secondary", bg: "bg-secondary/15" },
  plan: { Icon: ListChecks, color: "text-accent", bg: "bg-accent/15" },
  mcp: { Icon: Plug, color: "text-success", bg: "bg-success/15" },
  other: {
    Icon: Wrench,
    color: "text-base-content/60",
    bg: "bg-base-content/10",
  },
};

const ICON_BY_TOOL: Record<string, LucideIcon> = {
  read_file: FileText,
  read: FileText,
  write_file: FilePlus,
  write: FilePlus,
  edit_file: PenLine,
  edit: PenLine,
  patch: PenLine,
  str_replace: PenLine,
  list_files: FolderOpen,
  search_files: Search,
  grep: Search,
  glob: Search,
  web_fetch: Download,
  webfetch: Download,
  web_search: Search,
  websearch: Search,
  task: Bot,
  skill_view: BookOpen,
  commit: GitCommitHorizontal,
  add_issue_comment: MessageSquare,
};

const GIT_ICON_HINTS: Array<[RegExp, LucideIcon]> = [
  [/pull_request|pr_/, GitPullRequest],
  [/commit/, GitCommitHorizontal],
  [/branch/, GitBranch],
  [/repo|repository/, GitBranch],
  [/issue|comment/, MessageSquare],
];

export function iconForTool(toolName: string, family: ToolFamily): LucideIcon {
  const lower = toolName.toLowerCase();
  const direct = ICON_BY_TOOL[lower];
  if (direct) return direct;

  if (family === "git") {
    const stripped = lower
      .replace(/^mcp_/, "")
      .replace(/^github_/, "")
      .replace(/^git_/, "");
    for (const [re, Icon] of GIT_ICON_HINTS) {
      if (re.test(stripped)) return Icon;
    }
    return GitBranch;
  }

  return FAMILY_VISUAL[family].Icon;
}
