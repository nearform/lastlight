/**
 * Risk tiers — how much attention a changed region deserves, derived in code.
 *
 * Issue #429: the review had no notion of risk. A site's rank was its vote
 * count, then the derived severity, then a demotion for test paths, so a
 * change to a README and a change to a migration competed on equal terms for
 * the same five investigator slots, and a re-review held both to the same bar.
 *
 * A tier comes from two layers, both pure:
 *
 * 1. **Path rules**, first match wins: the repository's own `.lastlight/`
 *    rules, then the operator's `review.risk.rules`, then
 *    {@link DEFAULT_RISK_RULES}. Core concatenates the first two in that order
 *    and writes them to the file `--risk-rules` names; the defaults are always
 *    appended here, so a rule list can override a default but never has to
 *    restate them. A path no rule matches is `medium`.
 * 2. **Signals**, at most ONE tier up and never past `critical`: a unit
 *    carrying a `security` or `state` obligation, or declaring a symbol with
 *    {@link FAN_IN_BUMP}+ non-test references outside the diff. The one-tier
 *    cap is deliberate: a signal says "look harder than the path suggests",
 *    not "this test helper is now critical".
 *
 * The tier is read by: the site rank (a weight on the vote,
 * {@link RISK_WEIGHT}), the re-review convergence gate (a `low` unit never
 * re-opens on unchanged code), and the coverage report (risk-weighted
 * percentages). It never decides whether a changed unit is surveyed.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { isTestPath } from "./project.js";

export const RISK_TIERS = ["low", "medium", "high", "critical"] as const;
export const RiskTierSchema = z.enum(RISK_TIERS);
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const RiskRuleSchema = z.object({
  /** Same semantics as core's `isGeneratedPath`: no `/` ⇒ matched against the basename anywhere. */
  glob: z.string().min(1),
  tier: RiskTierSchema,
});
export type RiskRule = z.infer<typeof RiskRuleSchema>;

/** The `--risk-rules` file: the repo's rules, then the operator's, in order. */
export const RiskRulesFileSchema = z.object({ rules: z.array(RiskRuleSchema) });

/** Weight on a site's vote. `medium` is 1, so a PR with no rule hits ranks exactly as before. */
export const RISK_WEIGHT: Record<RiskTier, number> = { low: 0.5, medium: 1, high: 1.5, critical: 2 };

/** Non-test references outside the diff that make a changed symbol load-bearing. */
export const FAN_IN_BUMP = 5;

/** Obligation families whose presence on a unit bumps its tier. */
const BUMP_FAMILIES = new Set(["security", "state"]);

/**
 * The built-in rules, appended after every configured rule. Narrow on
 * purpose: a wrong `low` hides real code from the re-review gate, so only
 * paths that are almost never executable logic are `low`, and `high` names
 * the places a defect costs data or access.
 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  // Generated and vendored: nobody reads these line by line.
  { glob: "*.lock", tier: "low" },
  { glob: "*.min.js", tier: "low" },
  { glob: "*.min.css", tier: "low" },
  { glob: "*.snap", tier: "low" },
  { glob: "**/__generated__/**", tier: "low" },
  { glob: "*.generated.*", tier: "low" },
  // Prose.
  { glob: "*.md", tier: "low" },
  { glob: "*.mdx", tier: "low" },
  { glob: "*.txt", tier: "low" },
  { glob: "*.rst", tier: "low" },
  { glob: "docs/**", tier: "low" },
  { glob: "**/docs/**", tier: "low" },
  { glob: "**/__fixtures__/**", tier: "low" },
  { glob: "**/fixtures/**", tier: "low" },
  { glob: "**/__mocks__/**", tier: "low" },
  // Where a defect costs data, access or the supply chain.
  { glob: "**/migrations/**", tier: "high" },
  { glob: "**/migration/**", tier: "high" },
  { glob: "*.sql", tier: "high" },
  { glob: "**/schema/**", tier: "high" },
  { glob: "**/auth/**", tier: "high" },
  { glob: "**/security/**", tier: "high" },
  { glob: "**/crypto/**", tier: "high" },
  { glob: "**/permissions/**", tier: "high" },
  { glob: "**/billing/**", tier: "high" },
  { glob: "**/payments/**", tier: "high" },
  { glob: ".github/workflows/**", tier: "high" },
  { glob: "Dockerfile", tier: "high" },
  { glob: "*.Dockerfile", tier: "high" },
];

const globCache = new Map<string, RegExp>();

/**
 * A glob as a RegExp, with core's `isGeneratedPath` semantics (code-facts has
 * no workspace dependency, so the ~20 lines are restated rather than shared):
 * `*` stays in one segment, `**​/` is zero or more leading segments, `?` is
 * one non-`/` character, everything else is literal.
 */
function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

export function matchesGlob(path: string, glob: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return globToRegExp(glob).test(glob.includes("/") ? path : basename);
}

export interface PathRisk {
  tier: RiskTier;
  /** The rule that decided it (`glob → tier`), `test path`, or `default`. */
  why: string;
}

/**
 * A path's tier: the configured rules in order, then test paths (`low`), then
 * the defaults, then `medium`. Test paths sit between the configured rules and
 * the defaults so an operator can still raise a test directory, but no default
 * `high` rule (say `**​/auth/**`) lifts `auth/login.test.ts` above `low`.
 */
export function pathRisk(path: string, rules: readonly RiskRule[] = []): PathRisk {
  for (const r of rules) if (matchesGlob(path, r.glob)) return { tier: r.tier, why: `${r.glob} → ${r.tier}` };
  if (isTestPath(path)) return { tier: "low", why: "test path" };
  for (const r of DEFAULT_RISK_RULES) if (matchesGlob(path, r.glob)) return { tier: r.tier, why: `${r.glob} → ${r.tier} (default)` };
  return { tier: "medium", why: "default" };
}

export function bumpTier(tier: RiskTier): RiskTier {
  return RISK_TIERS[Math.min(RISK_TIERS.indexOf(tier) + 1, RISK_TIERS.length - 1)]!;
}

export function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return RISK_TIERS.indexOf(a) >= RISK_TIERS.indexOf(b) ? a : b;
}

export interface UnitRiskSignals {
  /** Families of the obligations the unit carries. */
  families: readonly string[];
  /** The largest count of non-test, out-of-diff references among the symbols the unit declares. */
  fanIn: number;
}

/** A unit's tier: its path's, bumped at most once by its signals. */
export function unitRisk(path: string | null, signals: UnitRiskSignals, rules: readonly RiskRule[] = []): PathRisk {
  const base: PathRisk = path === null ? { tier: "medium", why: "pr-level obligations" } : pathRisk(path, rules);
  const reasons: string[] = [];
  const hit = signals.families.filter((f) => BUMP_FAMILIES.has(f));
  if (hit.length) reasons.push(`${hit.join("+")} obligation`);
  if (signals.fanIn >= FAN_IN_BUMP) reasons.push(`fan-in ${signals.fanIn}`);
  if (reasons.length === 0) return base;
  const tier = bumpTier(base.tier);
  return tier === base.tier ? base : { tier, why: `${base.why}, raised: ${reasons.join(", ")}` };
}

/**
 * Read a `--risk-rules` file. Unreadable or malformed ⇒ `null` with the
 * reason, and the caller runs on the defaults alone — a bad rule file must
 * cost a ranking nuance, never the review.
 */
export function readRiskRules(file: string): { rules: RiskRule[] | null; reason: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { rules: null, reason: `risk rules at ${file} are unreadable (${err instanceof Error ? err.message : String(err)}) — the built-in rules apply alone` };
  }
  const parsed = RiskRulesFileSchema.safeParse(raw);
  if (!parsed.success) return { rules: null, reason: `risk rules at ${file} are malformed (${parsed.error.issues[0]?.message ?? "invalid"}) — the built-in rules apply alone` };
  return { rules: parsed.data.rules, reason: null };
}
