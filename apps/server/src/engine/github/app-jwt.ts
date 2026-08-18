import { createSign } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Build a short-lived RS256 App JWT — the credential that authenticates the App
 * *itself* (as opposed to one of its installations). Two things need it: the
 * installation-token mint (`git-auth.ts`) and the installation directory
 * (`installations.ts`), which is why it lives in its own module rather than in
 * either of them.
 *
 * Hand-rolled with node's `crypto` so the harness carries no JWT dependency.
 * `iat` is backdated 60s to tolerate clock skew; GitHub caps the lifetime at
 * 10 minutes.
 */
export function appJwt(appId: string, privateKeyPath: string): string {
  const privateKey = readFileSync(resolve(privateKeyPath), "utf-8");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}
