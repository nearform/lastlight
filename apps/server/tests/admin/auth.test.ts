import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  createToken,
  verifyToken,
  verifyTokenForRefresh,
  decodeToken,
  authIsEnabled,
  REFRESH_GRACE_SECONDS,
} from "#src/admin/auth.js";

const SECRET = "test-secret-key";

/** Mint a signed token with an arbitrary payload — for crafting expired ones. */
function signToken(payload: object): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

const nowS = () => Math.floor(Date.now() / 1000);

describe("authIsEnabled", () => {
  it("is off when nothing is configured", () => {
    expect(authIsEnabled({})).toBe(false);
  });

  it("is on with an admin password", () => {
    expect(authIsEnabled({ adminPassword: "pw" })).toBe(true);
  });

  it("is on with Slack OAuth (id + secret), no password", () => {
    expect(authIsEnabled({ slackOAuthClientId: "C1", slackOAuthClientSecret: "s" })).toBe(true);
  });

  it("Slack OAuth needs BOTH id and secret", () => {
    expect(authIsEnabled({ slackOAuthClientId: "C1" })).toBe(false);
  });

  it("is on with GitHub OAuth when an allowed-org is set", () => {
    expect(
      authIsEnabled({ githubOAuthClientId: "g", githubOAuthClientSecret: "s", githubAllowedOrg: "acme" }),
    ).toBe(true);
  });

  it("GitHub OAuth without an allowed-org does NOT enable auth", () => {
    // Mirrors the dashboard's githubOAuthEnabled gate — creds alone aren't enough.
    expect(authIsEnabled({ githubOAuthClientId: "g", githubOAuthClientSecret: "s" })).toBe(false);
  });
});

describe("createToken / verifyToken", () => {
  it("creates a valid token and verifies it", () => {
    const token = createToken(SECRET);
    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("creates a token with method=password and verifies it", () => {
    const token = createToken(SECRET, "password");
    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("creates a token with method=slack and verifies it", () => {
    const token = createToken(SECRET, "slack");
    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("rejects a token signed with a different secret", () => {
    const token = createToken(SECRET, "slack");
    expect(verifyToken(token, "wrong-secret")).toBe(false);
  });

  it("backward compat: tokens without method field still verify", async () => {
    // Manually craft a token without method field (old format)
    const crypto = await import("node:crypto");
    const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const payloadB64 = Buffer.from(payload).toString("base64url");
    const sig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
    const token = `${payloadB64}.${sig}`;
    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("rejects a tampered token", () => {
    const token = createToken(SECRET, "slack");
    const tampered = token.slice(0, -2) + "xx";
    expect(verifyToken(tampered, SECRET)).toBe(false);
  });

  it("rejects a token with wrong part count", () => {
    expect(verifyToken("notavalidtoken", SECRET)).toBe(false);
  });
});

describe("decodeToken", () => {
  it("returns exp and method for a valid token", () => {
    const token = createToken(SECRET, "slack");
    const decoded = decodeToken(token);
    expect(decoded?.method).toBe("slack");
    expect(typeof decoded?.exp).toBe("number");
  });

  it("decodes WITHOUT verifying the signature (tampered sig still decodes)", () => {
    const token = createToken(SECRET, "password");
    const tampered = token.slice(0, -2) + "xx";
    expect(decodeToken(tampered)?.method).toBe("password");
  });

  it("drops an unrecognized method", () => {
    expect(decodeToken(signToken({ exp: nowS() + 100, method: "evil" }))?.method).toBeUndefined();
  });

  it("carries a verified login and survives decode (issue #205)", () => {
    const token = createToken(SECRET, "github", "octocat");
    expect(verifyToken(token, SECRET)).toBe(true);
    const decoded = decodeToken(token);
    expect(decoded?.method).toBe("github");
    expect(decoded?.login).toBe("octocat");
  });

  it("login is absent for 2-arg (signature-compatible) callers", () => {
    expect(decodeToken(createToken(SECRET, "password"))?.login).toBeUndefined();
    expect(decodeToken(createToken(SECRET))?.login).toBeUndefined();
  });

  it("drops a non-string login", () => {
    expect(decodeToken(signToken({ exp: nowS() + 100, login: 123 }))?.login).toBeUndefined();
  });

  it("returns null when exp is missing", () => {
    expect(decodeToken(signToken({ method: "slack" }))).toBeNull();
  });

  it("returns null for a malformed token", () => {
    expect(decodeToken("nope")).toBeNull();
  });
});

describe("verifyTokenForRefresh", () => {
  it("accepts a live token", () => {
    expect(verifyTokenForRefresh(createToken(SECRET), SECRET)).toBe(true);
  });

  it("accepts a token expired within the grace window", () => {
    const token = signToken({ exp: nowS() - REFRESH_GRACE_SECONDS + 60 });
    expect(verifyToken(token, SECRET)).toBe(false); // strictly expired
    expect(verifyTokenForRefresh(token, SECRET)).toBe(true); // but still refreshable
  });

  it("rejects a token expired beyond the grace window", () => {
    const token = signToken({ exp: nowS() - REFRESH_GRACE_SECONDS - 60 });
    expect(verifyTokenForRefresh(token, SECRET)).toBe(false);
  });

  it("rejects a grace-window token signed with a different secret", () => {
    const token = signToken({ exp: nowS() - 60 });
    expect(verifyTokenForRefresh(token, "wrong-secret")).toBe(false);
  });
});
