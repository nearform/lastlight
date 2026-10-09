import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { botKindForBranch, isBotOwnedBranch } from "../src/bot-branches.js";

describe("bot-owned branches", () => {
  for (const [branch, kind] of [
    ["dependabot/npm_and_yarn/lodash-4.17.21", "dependabot"],
    ["dependabot/pip/requests-2.32.0", "dependabot"],
    ["renovate/lodash-4.x", "renovate"],
    ["renovate-bot/lodash-4.x", "renovate"],
  ] as const) {
    it(`${branch} is owned by ${kind}`, () => {
      assert.equal(botKindForBranch(branch), kind);
      assert.equal(isBotOwnedBranch(branch), true);
    });
  }

  for (const branch of ["main", "lastlight/442-fix", "feature/dependabot/x", "renovate", "dependabot"]) {
    it(`${branch} is not bot-owned`, () => {
      assert.equal(botKindForBranch(branch), null);
      assert.equal(isBotOwnedBranch(branch), false);
    });
  }
});
