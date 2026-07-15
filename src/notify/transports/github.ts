/**
 * GitHub binding for the progress notifier. Owns a single comment id and edits
 * it in place on every `publish()`; `note()` posts a fresh comment for moments
 * that deserve a real notification (approval prompts, terminal summary).
 */
import type { GitHubClient } from "../../engine/github/github.js";
import type { NotifierTransport, ProgressModel } from "../types.js";

export interface GitHubTransportDeps {
  github: GitHubClient;
  owner: string;
  repo: string;
  issueNumber: number;
  /** Existing status-comment id from a resumed run, if any. */
  commentId?: number;
  /** Persist the comment id the first time it's created (so resume re-attaches). */
  save?: (commentId: number) => void;
}

export class GitHubTransport implements NotifierTransport {
  /** No terminal ping — the finished checklist + the PR-opened event suffice. */
  readonly terminalPing = false;
  private commentId?: number;

  constructor(private readonly deps: GitHubTransportDeps) {
    this.commentId = deps.commentId;
  }

  async publish(markdown: string, _model?: ProgressModel): Promise<void> {
    // GitHub renders markdown natively — the structured model is Slack-only.
    const { github, owner, repo, issueNumber } = this.deps;
    if (this.commentId !== undefined) {
      await github.updateComment(owner, repo, this.commentId, markdown);
    } else {
      const id = await github.postComment(owner, repo, issueNumber, markdown);
      this.commentId = id;
      this.deps.save?.(id);
    }
  }

  async note(markdown: string): Promise<void> {
    const { github, owner, repo, issueNumber } = this.deps;
    await github.postComment(owner, repo, issueNumber, markdown);
  }
}
