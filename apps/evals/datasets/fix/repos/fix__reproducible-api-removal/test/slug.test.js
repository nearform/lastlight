import { test } from "node:test";
import assert from "node:assert/strict";
import { slug } from "../src/slug.js";

test("slugs a title", () => {
  assert.equal(slug("Hello There World"), "hello-there-world");
});
