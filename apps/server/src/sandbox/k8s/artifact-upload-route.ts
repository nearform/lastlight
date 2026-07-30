import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { Hono } from "hono";
import { ArtifactTooLarge, type ArtifactStore } from "../artifact-store.js";

/**
 * Mount the internal artifact-upload endpoint on the shared Hono app. A
 * sandbox Pod's exit hook `POST`s its gzipped `.lastlight/` tarball here with
 * the per-run token (`Authorization: Bearer <token>`) it received in its creds
 * Secret; the token gates each Pod to its own run namespace. Mirrors
 * `mountSkillBundle` (`skill-bundle-route.ts`) in reverse — reads instead of
 * serves. Backend-agnostic — with no k8s runs, nothing is ever registered, so
 * every request 401s.
 */
export function mountArtifactUpload(app: Hono, store: ArtifactStore): void {
  app.post("/internal/sandbox-artifacts", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token || !store.resolve(token)) return c.body(null, 401);

    const rawBody = c.req.raw.body;
    if (!rawBody) return c.body(null, 400);

    try {
      // Web ReadableStream (Hono/undici) → Node Readable. The DOM `lib` and
      // `node:stream/web` ReadableStream types don't structurally unify, hence
      // the cast — the runtime value is a plain web ReadableStream either way.
      const body = Readable.fromWeb(rawBody as NodeWebReadableStream<Uint8Array>);
      await store.unpack(token, body);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ArtifactTooLarge) return c.body(null, 413);
      // Never swallow the cause: surface it so a malformed bundle vs a broken
      // extraction is diagnosable in the harness log, not an opaque 400.
      console.error(
        `[artifact-upload] unpack failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      // traversal / malformed tar → 400
      return c.body(null, 400);
    }
  });
}
