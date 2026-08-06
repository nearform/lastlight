/**
 * The emoji → score vocabulary (issue #255).
 *
 * A 👍 or 👎 on something Last Light wrote is a human grading one workflow run,
 * and this module is the single place that decides what a given reaction is
 * worth. It is pure — no IO, no config — so both surfaces normalize through the
 * same table and a Slack `+1` and a GitHub `THUMBS_UP` aggregate as one thing.
 *
 * Three normalizations happen before the lookup, because the same reaction
 * arrives spelled three different ways:
 *
 * - **Slack skin tones.** Slack sends `+1::skin-tone-3`; the tone is a rendering
 *   choice, not a different opinion.
 * - **GitHub GraphQL vs REST.** The `reactionGroups` batch query answers
 *   `THUMBS_UP` / `CONFUSED`, while the REST endpoints say `+1` / `confused`.
 * - **Slack aliases.** `thumbsup`, `tada` and friends are Slack's names for
 *   reactions GitHub calls `+1` and `hooray`. Folding them to the GitHub
 *   spelling is what lets one query average across both surfaces.
 *
 * Anything outside the table is **not** a signal — `scoreReaction` returns null
 * and the caller drops it. A 🍕 is not feedback, and recording it would only
 * dilute the dataset it would sit in.
 */

/** Where a reaction came from. Slack has a wider vocabulary than GitHub's 8. */
export type FeedbackSource = "slack" | "github";

/** The five buckets a reaction can land in. */
export type FeedbackSentiment = "very_good" | "good" | "neutral" | "bad" | "very_bad";

export interface ScoredReaction {
  /** Canonical reaction name, stored on the signal row. */
  emoji: string;
  score: -2 | -1 | 0 | 1 | 2;
  sentiment: FeedbackSentiment;
}

/**
 * GitHub GraphQL `ReactionContent` enum → the REST name we canonicalize on.
 * The REST spelling wins because it is what the reactions API, the webhook
 * payloads and the issue that asked for this all use.
 */
const GRAPHQL_CONTENT: Record<string, string> = {
  THUMBS_UP: "+1",
  THUMBS_DOWN: "-1",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

/**
 * Slack emoji names that are the SAME reaction under a different name. Only
 * exact equivalents are folded — a Slack `disappointed` stays `disappointed`,
 * because GitHub has no sad face and pretending it is `confused` would put a
 * word in the reactor's mouth. It still scores the same; only the label differs.
 */
const SLACK_ALIASES: Record<string, string> = {
  thumbsup: "+1",
  "+1": "+1",
  thumbsdown: "-1",
  "-1": "-1",
  tada: "hooray",
  party_popper: "hooray",
};

/**
 * The score table. Keyed on the canonical name, so one entry serves both
 * surfaces wherever the vocabularies overlap.
 *
 * 👀 is deliberately **0**. It is Last Light's own "I've seen it" ack emoji
 * (`ackGithubEvent` in `src/engine/dispatcher.ts`), so a human copying that
 * convention onto a bot comment means "noted", not "this was bad" — and scoring
 * it negative would quietly poison the dataset with the bot's own idiom.
 */
const SCORES: Record<string, -2 | -1 | 0 | 1 | 2> = {
  // very good
  hooray: 2,
  rocket: 2,
  heart: 2,
  heart_eyes: 2,
  // good
  "+1": 1,
  laugh: 1,
  smile: 1,
  smiley: 1,
  grinning: 1,
  // neutral — recorded, not scored
  eyes: 0,
  // bad
  "-1": -1,
  // very bad
  confused: -2,
  disappointed: -2,
  cry: -2,
  sob: -2,
};

/** The reactions a GitHub subject can actually carry — the API accepts no others. */
const GITHUB_VOCABULARY = new Set([
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);

function sentimentFor(score: number): FeedbackSentiment {
  if (score >= 2) return "very_good";
  if (score >= 1) return "good";
  if (score <= -2) return "very_bad";
  if (score <= -1) return "bad";
  return "neutral";
}

/**
 * Normalize a raw reaction name to its canonical form. Exported for the poller,
 * which stores the canonical name on the anchor's snapshot and has to compare
 * like with like across a REST discovery and a GraphQL refresh.
 */
export function canonicalReaction(raw: string, source: FeedbackSource): string {
  // Slack sends `+1::skin-tone-3`; GitHub never does. Splitting unconditionally
  // is harmless and keeps the two paths identical.
  const base = raw.trim().split("::")[0]!.toLowerCase();
  if (source === "github") return GRAPHQL_CONTENT[raw.trim().toUpperCase()] ?? base;
  return SLACK_ALIASES[base] ?? base;
}

/**
 * Score one reaction, or null when it carries no meaning we understand.
 *
 * A GitHub reaction outside the API's own 8 values is impossible, so it is
 * treated as a decoding bug rather than a signal; a Slack reaction outside the
 * table is just somebody being expressive.
 */
export function scoreReaction(raw: string, source: FeedbackSource): ScoredReaction | null {
  if (!raw) return null;
  const emoji = canonicalReaction(raw, source);
  if (source === "github" && !GITHUB_VOCABULARY.has(emoji)) return null;
  const score = SCORES[emoji];
  if (score === undefined) return null;
  return { emoji, score, sentiment: sentimentFor(score) };
}

/**
 * Is this reactor the bot itself? Last Light reacts 👀 on the comments it acts
 * on, and a `<bot>[bot]` login reacting to a `<bot>[bot]` comment is the harness
 * talking to itself — never feedback.
 *
 * Compared loosely on purpose: GitHub's REST API answers `last-light[bot]` while
 * the GraphQL `author.login` on the same account answers `last-light`, so an
 * exact match against either spelling alone would let half the self-reactions
 * through.
 */
export function isSelfReactor(reactor: string | undefined, botLogin: string | undefined): boolean {
  if (!reactor || !botLogin) return false;
  const strip = (s: string) => s.toLowerCase().replace(/\[bot\]$/, "");
  return strip(reactor) === strip(botLogin);
}
