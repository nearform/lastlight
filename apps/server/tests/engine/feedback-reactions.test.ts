import { describe, it, expect } from "vitest";
import {
  canonicalReaction,
  isSelfReactor,
  scoreReaction,
} from "#src/engine/feedback/reactions.js";

describe("scoreReaction — the emoji vocabulary (issue #255)", () => {
  it("scores the GitHub REST names", () => {
    const cases: Array<[string, number]> = [
      ["hooray", 2],
      ["rocket", 2],
      ["heart", 2],
      ["+1", 1],
      ["laugh", 1],
      ["eyes", 0],
      ["-1", -1],
      ["confused", -2],
    ];
    for (const [emoji, score] of cases) {
      expect(scoreReaction(emoji, "github"), emoji).toMatchObject({ emoji, score });
    }
  });

  it("folds the GraphQL SCREAMING_CASE enum onto the same entries", () => {
    // The batched `reactionGroups` query answers THUMBS_UP where the REST
    // endpoints answer `+1`. Both must land on one row in the store.
    expect(scoreReaction("THUMBS_UP", "github")).toEqual(scoreReaction("+1", "github"));
    expect(scoreReaction("THUMBS_DOWN", "github")).toEqual(scoreReaction("-1", "github"));
    expect(scoreReaction("CONFUSED", "github")).toMatchObject({ emoji: "confused", score: -2 });
  });

  it("keeps 👀 at zero — it is the bot's own ack emoji, not a complaint", () => {
    const eyes = scoreReaction("eyes", "github");
    expect(eyes).toMatchObject({ score: 0, sentiment: "neutral" });
  });

  it("strips Slack skin-tone suffixes", () => {
    expect(scoreReaction("+1::skin-tone-3", "slack")).toMatchObject({ emoji: "+1", score: 1 });
    expect(scoreReaction("thumbsdown::skin-tone-5", "slack")).toMatchObject({ emoji: "-1" });
  });

  it("folds Slack aliases onto the GitHub spelling so both surfaces aggregate", () => {
    expect(canonicalReaction("thumbsup", "slack")).toBe("+1");
    expect(canonicalReaction("tada", "slack")).toBe("hooray");
    expect(scoreReaction("tada", "slack")).toEqual(scoreReaction("hooray", "github"));
  });

  it("scores the Slack-only sad faces GitHub cannot express, keeping their own label", () => {
    for (const name of ["disappointed", "cry", "sob"]) {
      expect(scoreReaction(name, "slack"), name).toMatchObject({
        emoji: name,
        score: -2,
        sentiment: "very_bad",
      });
    }
  });

  it("drops anything outside the vocabulary", () => {
    expect(scoreReaction("pizza", "slack")).toBeNull();
    expect(scoreReaction("", "slack")).toBeNull();
    // Impossible over the GitHub API — treated as a decoding bug, not a signal.
    expect(scoreReaction("disappointed", "github")).toBeNull();
    expect(scoreReaction("pizza", "github")).toBeNull();
  });

  it("maps every score to its sentiment bucket", () => {
    expect(scoreReaction("rocket", "github")?.sentiment).toBe("very_good");
    expect(scoreReaction("+1", "github")?.sentiment).toBe("good");
    expect(scoreReaction("-1", "github")?.sentiment).toBe("bad");
    expect(scoreReaction("confused", "github")?.sentiment).toBe("very_bad");
  });
});

describe("isSelfReactor", () => {
  it("matches across the [bot]-suffix spellings REST and GraphQL disagree on", () => {
    // REST says `last-light[bot]`, GraphQL says `last-light`, for one account.
    expect(isSelfReactor("last-light[bot]", "last-light[bot]")).toBe(true);
    expect(isSelfReactor("last-light", "last-light[bot]")).toBe(true);
    expect(isSelfReactor("last-light[bot]", "last-light")).toBe(true);
    expect(isSelfReactor("Last-Light", "last-light[bot]")).toBe(true);
  });

  it("leaves humans and other bots alone", () => {
    expect(isSelfReactor("cliftonc", "last-light[bot]")).toBe(false);
    expect(isSelfReactor("dependabot[bot]", "last-light[bot]")).toBe(false);
    expect(isSelfReactor(undefined, "last-light[bot]")).toBe(false);
    expect(isSelfReactor("cliftonc", undefined)).toBe(false);
  });
});
