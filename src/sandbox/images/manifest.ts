/**
 * Baked-in manifest for the `default` agentic-pi-dev image.
 *
 * The image is built and released by `.github/workflows/image.yml`,
 * which tags releases on `image-v*` (independent from the npm `v*`
 * stream). After cutting an `image-v<x.y.z>` release, copy the
 * per-arch URLs and sha256s from the release's `manifest.json` into
 * the placeholders below and ship a new npm version.
 *
 * The sha256 is the authoritative signature — the loader verifies it
 * before extracting. Reproducibility across rebuilds is best-effort
 * (depends on Alpine mirror state), not guaranteed.
 */

export interface ImageArchive {
  url: string;
  sha256: string;
  /** Size hint used for download progress / sanity check. Optional. */
  uncompressedBytes: number;
}

export interface ImageManifest {
  name: string;
  version: string;
  archives: {
    aarch64: ImageArchive;
    x86_64: ImageArchive;
  };
}

// Pinned to image-v0.1.0 (first published release). Bump in lockstep
// with new image-v* releases — copy the published manifest.json
// verbatim. `uncompressedBytes` is informational only; the sha256 is
// the load-bearing check.
export const DEFAULT_IMAGE_MANIFEST: ImageManifest = {
  name: "agentic-pi-dev",
  version: "0.1.0",
  archives: {
    aarch64: {
      url: "https://github.com/cliftonc/agentic-pi/releases/download/image-v0.1.0/agentic-pi-dev-aarch64.tar.gz",
      sha256: "2b5d303cbcdb8753d0b9eb1a15345b0b32140bc517ee07e3e946c6484093481c",
      uncompressedBytes: 352753267,
    },
    x86_64: {
      url: "https://github.com/cliftonc/agentic-pi/releases/download/image-v0.1.0/agentic-pi-dev-x86_64.tar.gz",
      sha256: "08676e200b8ecd91e3727e67c295408756426447f9390a0f92c2d27d389e72f9",
      uncompressedBytes: 378160995,
    },
  },
};

export function isManifestPublished(m: ImageManifest = DEFAULT_IMAGE_MANIFEST): boolean {
  return m.archives.aarch64.sha256.length === 64 && m.archives.x86_64.sha256.length === 64;
}
