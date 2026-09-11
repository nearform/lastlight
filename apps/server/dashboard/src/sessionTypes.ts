import {
  Shield,
  Compass,
  Zap,
  Search,
  Wrench,
  GitPullRequest,
  FastForward,
  Tag,
  FileText,
  Activity,
  MessageSquare,
  Bot,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface SessionTypeConfig {
  label: string;
  Icon: LucideIcon;
  color: string;
}

export const SESSION_TYPES: Record<string, SessionTypeConfig> = {
  // Build cycle phases
  guardrails:  { label: "Guardrails",  Icon: Shield,         color: "text-warning" },
  architect:   { label: "Architect",   Icon: Compass,        color: "text-info" },
  executor:    { label: "Executor",    Icon: Zap,            color: "text-success" },
  reviewer:    { label: "Reviewer",    Icon: Search,         color: "text-secondary" },
  fix:         { label: "Fix",         Icon: Wrench,         color: "text-warning" },
  pr:          { label: "PR",          Icon: GitPullRequest,  color: "text-accent" },
  "pr-fix":    { label: "PR Fix",     Icon: Wrench,         color: "text-accent" },
  resume:      { label: "Resume",      Icon: FastForward,    color: "text-muted" },
  // Skills
  triage:      { label: "Triage",      Icon: Tag,            color: "text-warning" },
  review:      { label: "Review",      Icon: FileText,       color: "text-info" },
  health:      { label: "Health",      Icon: Activity,       color: "text-success" },
  // Chat
  chat:        { label: "Chat",        Icon: MessageSquare,  color: "text-primary" },
  // Default
  agent:       { label: "Agent",       Icon: Bot,            color: "text-muted" },
};

export function getSessionType(sessionType?: string): SessionTypeConfig {
  return SESSION_TYPES[sessionType || "agent"] || SESSION_TYPES.agent;
}
