/**
 * `ProgressNotifier` — the concrete {@link ProgressReporter} the runner drives.
 *
 * It owns the current {@link ProgressModel}, re-renders once per mutation, and
 * fans the rendered markdown out to every wired transport's `publish()`. It
 * knows nothing about GitHub or Slack — that lives behind
 * {@link NotifierTransport}. Multiple transports can be attached (e.g. a
 * GitHub-triggered build that also mirrors to a Slack thread); each owns its
 * own in-place-update handle.
 *
 * Mutations are serialized through an in-flight chain so two quick transitions
 * can't race on `publish()` and post out of order (or double-create the
 * surface before the first create's handle is stored).
 */
import { renderProgress } from "./render.js";
import { setStep, upsertBefore } from "./model.js";
import type {
  ApprovalNoteMeta,
  NotifierTransport,
  ProgressModel,
  ProgressReporter,
  ProgressStep,
  StepStatus,
} from "./types.js";

export class ProgressNotifier implements ProgressReporter {
  private model: ProgressModel | null = null;
  private readonly transports: NotifierTransport[];
  private chain: Promise<void> = Promise.resolve();

  constructor(transports: NotifierTransport[]) {
    this.transports = transports.filter(Boolean);
  }

  /** Serialize a mutation + publish so transitions can't interleave. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn, fn);
    return this.chain;
  }

  private async publish(): Promise<void> {
    if (!this.model) return;
    const model = this.model;
    const body = renderProgress(model);
    // Best-effort per transport — one platform failing must not block the other.
    await Promise.all(
      this.transports.map((t) =>
        t.publish(body, model).catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          console.warn(`[notifier] publish failed: ${m}`);
        }),
      ),
    );
  }

  start(model: ProgressModel): Promise<void> {
    return this.enqueue(async () => {
      this.model = model;
      await this.publish();
    });
  }

  step(key: string, status: StepStatus, detail?: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.model) return;
      this.model = { ...this.model, steps: setStep(this.model.steps, key, status, detail) };
      await this.publish();
    });
  }

  insertStep(step: ProgressStep, beforeKey?: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.model) return;
      this.model = { ...this.model, steps: upsertBefore(this.model.steps, step, beforeKey) };
      await this.publish();
    });
  }

  footer(markdown: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.model) return;
      const footer = markdown.trim() || undefined;
      this.model = { ...this.model, footer };
      await this.publish();
    });
  }

  note(markdown: string): Promise<void> {
    return this.noteTo(this.transports, markdown);
  }

  noteApproval(markdown: string, meta: ApprovalNoteMeta): Promise<void> {
    return this.enqueue(async () => {
      if (!markdown.trim() || this.transports.length === 0) return;
      await Promise.all(
        this.transports.map((t) =>
          // Rich surfaces render interactive controls; the rest post plain text.
          (t.noteApproval ? t.noteApproval(markdown, meta) : t.note(markdown)).catch(
            (err: unknown) => {
              const m = err instanceof Error ? err.message : String(err);
              console.warn(`[notifier] noteApproval failed: ${m}`);
            },
          ),
        ),
      );
    });
  }

  noteTerminal(markdown: string): Promise<void> {
    return this.noteTo(this.transports.filter((t) => t.terminalPing), markdown);
  }

  private noteTo(transports: NotifierTransport[], markdown: string): Promise<void> {
    return this.enqueue(async () => {
      if (!markdown.trim() || transports.length === 0) return;
      await Promise.all(
        transports.map((t) =>
          t.note(markdown).catch((err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            console.warn(`[notifier] note failed: ${m}`);
          }),
        ),
      );
    });
  }
}
