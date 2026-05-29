/**
 * Skill catalogue + read tool for the in-process chat path.
 *
 * Chat doesn't run inside pi-coding-agent's `AgentSession` (that class
 * is a full TUI/extension lifecycle we don't need for a one-shot Slack
 * turn). To still give chat the standard progressive-disclosure skill
 * model, we:
 *
 *  1. Load the curated chat skill list from `<repo>/skills/<name>/`
 *     at boot, parsing the SKILL.md frontmatter inline (we deliberately
 *     do NOT import from `@earendil-works/pi-coding-agent` here — its
 *     transitive deps install a non-default undici as Node's global
 *     fetch dispatcher, which breaks GitHub OAuth response parsing).
 *  2. Format a system-prompt XML block listing each skill's name +
 *     description (mirrors pi-coding-agent's `formatSkillsForPrompt`
 *     shape, keyed by name so the chat agent can ask by name).
 *  3. Expose a `read_skill` tool that resolves a name to that skill's
 *     SKILL.md and returns its text — same role as pi-coding-agent's
 *     built-in `read` tool when applied to a discovered SKILL.md.
 *
 * The curated list is intentionally hard-coded for v1. If chat ever
 * needs configurable skill exposure, lift this into env or settings.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { resolveSkillPaths } from "../workflows/loader.js";

/**
 * Minimal subset of pi-coding-agent's `Skill` shape — only the fields
 * the chat catalogue + read tool actually use.
 */
export interface ChatSkill {
  name: string;
  description: string;
  filePath: string;
}

/**
 * Skills exposed to chat threads. `chat` is the always-on persona;
 * the others let chat assist with one-off lookups that map to these
 * domains without delegating to a full workflow run.
 */
export const CHAT_SKILL_NAMES = [
  "chat",
  "issue-triage",
  "pr-review",
  "repo-health",
] as const;

const SKILLS_ROOT = resolve("skills");

export interface ChatSkillCatalogue {
  /** Skills the chat agent can read on demand, keyed by name. */
  skills: ChatSkill[];
  /**
   * XML block describing each skill (name + description) suitable for
   * prepending to the chat system prompt. Empty string if no skills
   * resolved cleanly.
   */
  catalogueXml: string;
}

/**
 * Parse `name:` and `description:` from the YAML frontmatter of a
 * SKILL.md. We only need those two fields; pi-coding-agent's full
 * loader supports more (tags, version, disable-model-invocation) but
 * importing it here pulls in transitive deps that interfere with
 * Node's global fetch dispatcher (see file-header comment).
 *
 * Frontmatter must be the first thing in the file, opened and closed
 * by lines containing just `---`. Both `name:` and `description:` are
 * required to count as a valid skill; either may be quoted or
 * unquoted single-line strings. Multi-line description values are
 * supported via YAML's `|` and `>` block scalars.
 */
function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return {};
  const body = lines.slice(1, end);

  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < body.length; i++) {
    const m = body[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2];
    if (key !== "name" && key !== "description") continue;

    let value: string;
    if (raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      // Block scalar — collect subsequent indented lines until a
      // less-indented line or end of block.
      const collected: string[] = [];
      let j = i + 1;
      while (j < body.length && /^\s+/.test(body[j])) {
        collected.push(body[j].replace(/^\s+/, ""));
        j++;
      }
      value = raw.startsWith(">") ? collected.join(" ") : collected.join("\n");
      i = j - 1;
    } else {
      value = raw.replace(/^['"]|['"]$/g, "").trim();
    }
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Load the curated chat skill catalogue from `<repo>/skills/`.
 * Skills missing `name` or `description` frontmatter are silently
 * dropped, matching pi-coding-agent's behaviour on the sandbox path.
 */
export function loadChatSkillCatalogue(): ChatSkillCatalogue {
  const skills: ChatSkill[] = [];
  for (const name of CHAT_SKILL_NAMES) {
    const filePath = join(SKILLS_ROOT, name, "SKILL.md");
    if (!existsSync(filePath)) continue;
    const md = readFileSync(filePath, "utf-8");
    const fm = parseSkillFrontmatter(md);
    if (!fm.name || !fm.description) continue;
    skills.push({ name: fm.name, description: fm.description, filePath });
  }

  if (skills.length === 0) {
    return { skills, catalogueXml: "" };
  }

  const lines: string[] = [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the `read_skill` tool with the skill `name` to load a skill's full SKILL.md when the user's task matches its description.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");

  return { skills, catalogueXml: lines.join("\n") };
}

/**
 * Build the `read_skill` tool that chat uses to pull a SKILL.md on
 * demand. Returns the pi-ai `Tool` definition plus a name-keyed
 * dispatcher the chat-runner's toolset can merge into its `execute`.
 */
export interface ReadSkillToolset {
  tool: Tool;
  execute(call: ToolCall): { content: string; isError: boolean };
}

export function buildReadSkillTool(skills: ChatSkill[]): ReadSkillToolset {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const enumNames = skills.map((s) => s.name);

  // TypeBox enum keyed by the resolved name set — gives the LLM a tight
  // schema and lets us trust the input shape after parameter validation.
  // Falls back to a plain string when no skills resolved (the tool will
  // then be a no-op, but the schema still needs to compile).
  const parameters = Type.Object({
    name: enumNames.length > 0
      ? Type.Union(
          enumNames.map((n) => Type.Literal(n)),
          { description: "The skill name from <available_skills>." },
        )
      : Type.String({ description: "The skill name from <available_skills>." }),
  });

  const tool: Tool = {
    name: "read_skill",
    description:
      "Read the full SKILL.md text for a skill listed in <available_skills>. " +
      "Use this when the user's request matches a skill's description and you need its detailed instructions.",
    parameters,
  };

  return {
    tool,
    execute(call: ToolCall) {
      const args = (call.arguments ?? {}) as { name?: unknown };
      const name = typeof args.name === "string" ? args.name : "";
      const skill = byName.get(name);
      if (!skill) {
        return {
          content: JSON.stringify({
            error: `unknown skill "${name}". Available: ${enumNames.join(", ") || "(none)"}.`,
          }),
          isError: true,
        };
      }
      try {
        // Re-resolve through the loader's allowlist + safety check rather
        // than trusting `skill.filePath` directly — same path the runner
        // uses for sandbox phases, so chat can't read arbitrary files
        // even if a future Skill loader started accepting them.
        const [dir] = resolveSkillPaths([skill.name]);
        const md = readFileSync(`${dir}/SKILL.md`, "utf-8");
        return { content: md, isError: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: JSON.stringify({ error: msg }), isError: true };
      }
    },
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
