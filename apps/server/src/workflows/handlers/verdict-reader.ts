import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BuildAssetStore } from "../../state/build-assets.js";
import { parseReviewerVerdict } from "@lastlight/workflow-engine";
import type { ExecutorConfig } from "@lastlight/workflow-engine";
import type { ParsedVerdict } from "@lastlight/workflow-engine";
import type { VerdictArtifactReader } from "@lastlight/workflow-engine";

/**
 * App-side {@link VerdictArtifactReader}: the reviewer loop's on-disk verdict
 * fallback. The reviewer's authoritative verdict lives in `reviewer-verdict.md`
 * (its OUTPUT CONTRACT), so recover it when the stdout `VERDICT:` marker is
 * missing. Server mode reads the harvested doc from the build-asset store; repo
 * mode reads the committed doc from the host checkout under `issueDir`. Returns
 * the parsed verdict only when the file actually carries a `VERDICT:` marker
 * (else undefined — we don't launder the same fragile fallback through a
 * different source).
 *
 * Coupled to the filesystem + build-asset store, hence app-side and injected.
 */
export const fileVerdictReader: VerdictArtifactReader = {
  read({ config, repo, issueDir, taskId }): ParsedVerdict | undefined {
    let text: string | undefined;
    if (config.buildAssets === "server" && config.buildAssetsDir && config.buildAssetsKey) {
      try {
        text = new BuildAssetStore(config.buildAssetsDir).read(config.buildAssetsKey, "reviewer-verdict.md");
      } catch {
        /* fall through to the workspace copy */
      }
    }
    if (!text && issueDir) {
      const path = join(resolveHostRepoDir(config, taskId, repo), issueDir, "reviewer-verdict.md");
      try {
        if (existsSync(path)) text = readFileSync(path, "utf8");
      } catch {
        /* ignore — no recoverable verdict */
      }
    }
    if (!text) return undefined;
    const parsed = parseReviewerVerdict(text);
    return parsed.viaFallback ? undefined : parsed;
  },
};

/** Host path of the run's repo checkout — mirrors sandbox/index.ts layout. */
function resolveHostRepoDir(config: ExecutorConfig, taskId: string, repo: string): string {
  const sandboxBase = resolve(config.sandboxDir || join(config.stateDir || "data", "sandboxes"));
  const workDir = join(sandboxBase, taskId);
  const repoDir = join(workDir, repo);
  if (existsSync(join(repoDir, ".lastlight", "pr-review"))) return repoDir;
  if (existsSync(join(workDir, ".lastlight", "pr-review"))) return workDir;
  return repoDir;
}
