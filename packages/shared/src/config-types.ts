/**
 * Config types the workflow loader needs, lifted out of `@lastlight/core`'s
 * `config/config.ts` so `shared` never depends back on core (locked decision
 * 11). Core re-exports these from `@lastlight/shared` so its own
 * `config/config.js` import surface is unchanged.
 */

export interface DisabledConfig {
  workflows: string[];
  crons: string[];
  prompts: string[];
  skills: string[];
  agentContext: string[];
}

export interface RouteConfig {
  github: Record<string, string>;
  slack: Record<string, string>;
}
