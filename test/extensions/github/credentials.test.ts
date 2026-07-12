import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeToken,
  credentialsFilePath,
} from "../../../src/extensions/github/credentials.js";

describe("assertSafeToken", () => {
  test("accepts realistic GitHub installation tokens", () => {
    assert.doesNotThrow(() => assertSafeToken("ghs_1234567890abcdef"));
    assert.doesNotThrow(() => assertSafeToken("v1_alphanum-with_underscores"));
    assert.doesNotThrow(() => assertSafeToken("A".repeat(80)));
  });

  test("rejects shell-injection / URL-breaking characters", () => {
    for (const bad of [
      "token with space",
      "tok@en",
      "tok/en",
      "tok:en",
      "tok\nen",
      "tok'en",
      'tok"en',
      "tok;en",
      "tok$en",
      "tok&en",
    ]) {
      assert.throws(
        () => assertSafeToken(bad),
        /Refusing to embed a token/,
        `expected reject: ${JSON.stringify(bad)}`,
      );
    }
  });

  test("rejects non-strings", () => {
    assert.throws(() => assertSafeToken(undefined), /Refusing to embed/);
    assert.throws(() => assertSafeToken(null), /Refusing to embed/);
    assert.throws(() => assertSafeToken(42), /Refusing to embed/);
  });

  test("rejects empty strings", () => {
    assert.throws(() => assertSafeToken(""), /Refusing to embed/);
  });
});

describe("credentialsFilePath", () => {
  const ENV_KEY = "AGENTIC_PI_TEST_CRED_PATH";
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  test("falls back to $HOME-derived path when env var unset", () => {
    const p = credentialsFilePath(ENV_KEY);
    assert.match(p, /\.lastlight-git-credentials$/);
  });

  test("respects the env var override", () => {
    process.env[ENV_KEY] = "/var/run/agentic-pi/creds";
    assert.equal(credentialsFilePath(ENV_KEY), "/var/run/agentic-pi/creds");
  });

  test("rejects paths containing whitespace (would break git's helper-arg parsing)", () => {
    process.env[ENV_KEY] = "/tmp/path with space/creds";
    assert.throws(() => credentialsFilePath(ENV_KEY), /whitespace/);
  });
});
