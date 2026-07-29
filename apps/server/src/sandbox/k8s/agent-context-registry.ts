import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 30 * 60_000;

/**
 * In-memory token→text store shared by the adapter (writer) and the
 * `/internal/agent-context` route (reader). A per-run token gates each Pod to
 * its own resolved agent-context (persona/hard-rules → `AGENTS.md`). Mirrors
 * {@link SkillBundleRegistry} deliberately: agent-context is delivered over the
 * same HTTP init-fetch channel shape as skills, only it holds text and lives on
 * its own route (agent-context is per-run-constant and a no-skills phase must
 * still receive `AGENTS.md`, so it can't fold into the per-phase skills bundle).
 *
 * Primary reclaim is explicit: the adapter's `dispose` evicts on both success
 * and error. The TTL is a lazy backstop, not a timer — an expired entry is only
 * dropped the next time its token is looked up via `get()`, so a token nobody
 * queries again just sits in the Map until the process exits (bounded by process
 * lifetime; a crash frees the whole thing).
 */
export class AgentContextRegistry {
  private readonly entries = new Map<string, { text: string; expires: number }>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  register(text: string): string {
    const token = randomUUID();
    this.entries.set(token, { text, expires: Date.now() + this.ttlMs });
    return token;
  }

  get(token: string): string | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.entries.delete(token);
      return undefined;
    }
    return entry.text;
  }

  evict(token: string): void {
    this.entries.delete(token);
  }
}

/** Process-wide singleton: the adapter registers, the HTTP route serves. */
export const agentContextRegistry = new AgentContextRegistry();
