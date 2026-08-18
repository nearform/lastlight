import { test } from "node:test";
import assert from "node:assert/strict";

// Runs only in the `e2e` job, against the deployed staging API.
test("staging answers /health", async () => {
  const base = process.env.STAGING_BASE_URL;
  assert.ok(base, "STAGING_BASE_URL is not set");
  const res = await fetch(new URL("/health", base));
  assert.equal(res.status, 200);
});
