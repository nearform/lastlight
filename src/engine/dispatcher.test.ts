import { describe, it, expect, vi } from 'vitest';
import type { EventEnvelope } from '../connectors/types.js';
import type { Route } from './router.js';
import { dispatch, type DispatchDeps } from './dispatcher.js';

/** Minimal EventEnvelope for dispatcher tests. */
function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: 'evt-1',
    source: 'github',
    type: 'comment.created',
    repo: 'cliftonc/lastlight',
    sender: 'octocat',
    senderIsBot: false,
    body: '',
    raw: {},
    reply: vi.fn().mockResolvedValue(undefined),
    timestamp: new Date(),
    ...overrides,
  };
}

/**
 * Deps with everything stubbed. `route` is injected so a branch test names the
 * exact Route it wants — no LLM/classifier mocking needed. Individual tests
 * override only the deps the branch under test touches.
 */
function makeDeps(route: Route, overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    db: {} as any,
    github: null,
    dispatchWorkflow: vi.fn().mockResolvedValue({ success: true }),
    sessionManager: {} as any,
    runChat: vi.fn(),
    route: vi.fn().mockResolvedValue(route),
    reviewPostsCheck: false,
    ...overrides,
  };
}

/** A successful ChatResult with the fields the chat handler reads. */
function chatResult(overrides: Partial<import('./chat.js').ChatResult> = {}): import('./chat.js').ChatResult {
  return {
    text: 'hello back',
    success: true,
    durationMs: 12,
    agentSessionId: 'agent-sess-1',
    dashboardSessionId: 'dash-1',
    turns: 1,
    ...overrides,
  };
}

describe('dispatch — chat handler', () => {
  const chatRoute = (ctx: Record<string, unknown> = {}): Route => ({
    action: 'handler',
    handler: 'chat',
    context: { sessionId: 'sess-1', message: 'hi', sender: 'octocat', ...ctx },
  });

  it('runs the chat turn, replies with its text, and returns handled', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const db = {
      recordStart: vi.fn(),
      recordFinish: vi.fn(),
    };
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(undefined),
      setAgentSessionId: vi.fn(),
    };
    const runChat = vi.fn().mockResolvedValue(chatResult());
    const deps = makeDeps(chatRoute(), {
      db: db as any,
      sessionManager: sessionManager as any,
      runChat,
    });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'handled', handler: 'chat' });
    expect(runChat).toHaveBeenCalledWith('hi', 'sess-1', 'octocat', undefined);
    expect(envelope.reply).toHaveBeenCalledWith('hello back');
    expect(db.recordStart).toHaveBeenCalledTimes(1);
    expect(db.recordFinish).toHaveBeenCalledTimes(1);
    const finishArg = db.recordFinish.mock.calls[0][1];
    expect(finishArg.success).toBe(true);
  });

  it('resumes the existing agent session and persists a new one', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue({ agentSessionId: 'prior-sess' }),
      setAgentSessionId: vi.fn(),
    };
    const runChat = vi.fn().mockResolvedValue(chatResult({ agentSessionId: 'new-sess' }));
    const deps = makeDeps(chatRoute(), {
      db: { recordStart: vi.fn(), recordFinish: vi.fn() } as any,
      sessionManager: sessionManager as any,
      runChat,
    });

    await dispatch(envelope, deps);

    // Resumes with the stored agent session id...
    expect(runChat).toHaveBeenCalledWith('hi', 'sess-1', 'octocat', 'prior-sess');
    // ...and persists the new one the turn minted.
    expect(sessionManager.setAgentSessionId).toHaveBeenCalledWith('sess-1', 'new-sess');
  });

  it('records failure and replies with an apology when the chat turn throws', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const db = { recordStart: vi.fn(), recordFinish: vi.fn() };
    const runChat = vi.fn().mockRejectedValue(new Error('boom'));
    const deps = makeDeps(chatRoute(), {
      db: db as any,
      sessionManager: { getSession: vi.fn(), setAgentSessionId: vi.fn() } as any,
      runChat,
    });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'handled', handler: 'chat' });
    expect(db.recordFinish.mock.calls[0][1].success).toBe(false);
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/error/i));
  });
});

describe('dispatch — chat-reset handler', () => {
  it('deactivates the session and confirms', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const sessionManager = { deactivateSession: vi.fn() };
    const deps = makeDeps(
      { action: 'handler', handler: 'chat-reset', context: { sessionId: 'sess-9' } },
      { sessionManager: sessionManager as any },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'handled', handler: 'chat-reset' });
    expect(sessionManager.deactivateSession).toHaveBeenCalledWith('sess-9');
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/reset/i));
  });
});

describe('dispatch — status-report handler', () => {
  it('reports no running tasks when the ledger is empty', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const deps = makeDeps(
      { action: 'handler', handler: 'status-report', context: {} },
      { db: { runningExecutions: vi.fn().mockReturnValue([]) } as any },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'handled', handler: 'status-report' });
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/no tasks/i));
  });

  it('lists running tasks', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const deps = makeDeps(
      { action: 'handler', handler: 'status-report', context: {} },
      {
        db: {
          runningExecutions: vi.fn().mockReturnValue([
            { skill: 'build', repo: 'cliftonc/lastlight', issueNumber: 12, startedAt: 'now' },
          ]),
        } as any,
      },
    );

    await dispatch(envelope, deps);

    const msg = (envelope.reply as any).mock.calls[0][0] as string;
    expect(msg).toMatch(/build/);
    expect(msg).toMatch(/cliftonc\/lastlight/);
    expect(msg).toMatch(/12/);
  });
});

describe('dispatch — already-running guard', () => {
  it('skips when the handler is already running for the trigger', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', issueNumber: 7 });
    const isRunning = vi.fn().mockReturnValue(true);
    const dispatchWorkflow = vi.fn();
    const deps = makeDeps(
      { action: 'handler', handler: 'pr-review', context: { repo: 'cliftonc/lastlight' } },
      { db: { isRunning } as any, dispatchWorkflow },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect(isRunning).toHaveBeenCalledWith('pr-review', '7');
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(envelope.reply).not.toHaveBeenCalled();
  });

  it('warns the user on a duplicate message-triggered run', async () => {
    const envelope = makeEnvelope({ type: 'message', id: 'evt-x' });
    const deps = makeDeps(
      { action: 'handler', handler: 'issue-triage', context: { repo: 'cliftonc/lastlight' } },
      { db: { isRunning: vi.fn().mockReturnValue(true) } as any },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/already running/i));
  });
});

describe('dispatch — approval-response handler', () => {
  const approvalRoute = (ctx: Record<string, unknown>): Route => ({
    action: 'handler',
    handler: 'approval-response',
    context: { sender: 'maintainer', ...ctx },
  });

  function approvalDb(over: Record<string, any> = {}) {
    return {
      isRunning: vi.fn().mockReturnValue(false),
      respondToApproval: vi.fn(),
      resumeWorkflowRun: vi.fn(),
      finishWorkflowRun: vi.fn(),
      getPendingApprovalByTrigger: vi.fn(),
      getPendingApprovalForWorkflow: vi.fn(),
      getWorkflowRun: vi.fn(),
      ...over,
    };
  }

  it('replies when no pending approval is found', async () => {
    const envelope = makeEnvelope({ type: 'comment.created' });
    const db = approvalDb({ getPendingApprovalByTrigger: vi.fn().mockReturnValue(null) });
    const deps = makeDeps(
      approvalRoute({ decision: 'approved', repo: 'cliftonc/lastlight', issueNumber: 3 }),
      { db: db as any },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'handled', handler: 'approval-response' });
    expect(db.respondToApproval).not.toHaveBeenCalled();
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/no pending approval/i));
  });

  it('approves: records the decision, resumes the run, and re-dispatches the workflow', async () => {
    const envelope = makeEnvelope({ type: 'comment.created' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const db = approvalDb({
      getPendingApprovalByTrigger: vi.fn().mockReturnValue({ id: 'appr-1', workflowRunId: 'run-1' }),
      getWorkflowRun: vi.fn().mockReturnValue({
        id: 'run-1',
        workflowName: 'build',
        triggerId: 'cliftonc/lastlight#3',
        issueNumber: 3,
      }),
    });
    const deps = makeDeps(
      approvalRoute({ decision: 'approved', repo: 'cliftonc/lastlight', issueNumber: 3 }),
      { db: db as any, github: {} as any, dispatchWorkflow },
    );

    await dispatch(envelope, deps);

    expect(db.respondToApproval).toHaveBeenCalledWith('appr-1', 'approved', 'maintainer', undefined);
    expect(db.resumeWorkflowRun).toHaveBeenCalledWith('run-1');
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      'build',
      expect.objectContaining({ repo: 'cliftonc/lastlight', issueNumber: 3, _triggerType: 'approval' }),
    );
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/approved/i));
  });

  it('approves but cannot resume without a GitHub App', async () => {
    const envelope = makeEnvelope({ type: 'comment.created' });
    const dispatchWorkflow = vi.fn();
    const db = approvalDb({
      getPendingApprovalByTrigger: vi.fn().mockReturnValue({ id: 'appr-1', workflowRunId: 'run-1' }),
      getWorkflowRun: vi.fn().mockReturnValue({ id: 'run-1', workflowName: 'build', triggerId: 'x/y#3', issueNumber: 3 }),
    });
    const deps = makeDeps(
      approvalRoute({ decision: 'approved', repo: 'x/y', issueNumber: 3 }),
      { db: db as any, github: null, dispatchWorkflow },
    );

    await dispatch(envelope, deps);

    expect(db.respondToApproval).toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/cannot resume/i));
  });

  it('rejects: finishes the run as failed and confirms', async () => {
    const envelope = makeEnvelope({ type: 'comment.created' });
    const db = approvalDb({
      getPendingApprovalForWorkflow: vi.fn().mockReturnValue({ id: 'appr-2', workflowRunId: 'run-2' }),
      getWorkflowRun: vi.fn().mockReturnValue({ id: 'run-2', workflowName: 'build' }),
    });
    const deps = makeDeps(
      approvalRoute({ decision: 'rejected', reason: 'too risky', workflowRunId: 'run-2' }),
      { db: db as any },
    );

    await dispatch(envelope, deps);

    expect(db.respondToApproval).toHaveBeenCalledWith('appr-2', 'rejected', 'maintainer', 'too risky');
    expect(db.finishWorkflowRun).toHaveBeenCalledWith('run-2', 'failed', expect.stringMatching(/rejected/i));
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/rejected/i));
  });
});

describe('dispatch — explore-reply handler', () => {
  const replyRoute = (ctx: Record<string, unknown>): Route => ({
    action: 'handler',
    handler: 'explore-reply',
    context: { sender: 'octocat', reply: 'my answer', workflowRunId: 'run-1', ...ctx },
  });

  function replyDb(over: Record<string, any> = {}) {
    return {
      isRunning: vi.fn().mockReturnValue(false),
      getWorkflowRun: vi.fn(),
      getPendingApprovalForWorkflow: vi.fn(),
      resolveReplyGate: vi.fn(),
      getExecutionOutput: vi.fn(),
      updateWorkflowRunScratch: vi.fn(),
      resumeWorkflowRun: vi.fn(),
      ...over,
    };
  }

  it('no-ops without dispatching when the run is not found', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const dispatchWorkflow = vi.fn();
    const db = replyDb({ getWorkflowRun: vi.fn().mockReturnValue(undefined) });
    const deps = makeDeps(replyRoute({}), { db: db as any, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'handled', handler: 'explore-reply' });
    expect(db.resolveReplyGate).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('no-ops when there is no pending reply gate', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const dispatchWorkflow = vi.fn();
    const db = replyDb({
      getWorkflowRun: vi.fn().mockReturnValue({ id: 'run-1', triggerId: 'slack:t:c:th' }),
      getPendingApprovalForWorkflow: vi.fn().mockReturnValue({ id: 'g1', kind: 'approval' }),
    });
    const deps = makeDeps(replyRoute({}), { db: db as any, dispatchWorkflow });

    await dispatch(envelope, deps);

    expect(db.resolveReplyGate).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('resolves the gate, appends the Q&A, resumes and re-dispatches explore (Slack)', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const db = replyDb({
      getWorkflowRun: vi.fn().mockReturnValue({
        id: 'run-1',
        triggerId: 'slack:team:chan:thread',
        repo: 'lastlight',
        issueNumber: undefined,
        context: { owner: 'cliftonc' },
        scratch: { socratic: { lastOutput: 'What problem are we solving?', qa: [] } },
      }),
      getPendingApprovalForWorkflow: vi.fn().mockReturnValue({ id: 'gate-1', kind: 'reply' }),
    });
    const deps = makeDeps(
      replyRoute({ channelId: 'chan', threadId: 'thread' }),
      { db: db as any, dispatchWorkflow },
    );

    await dispatch(envelope, deps);

    expect(db.resolveReplyGate).toHaveBeenCalledWith('gate-1', 'my answer', 'octocat');
    const scratchPatch = db.updateWorkflowRunScratch.mock.calls[0][1];
    expect(scratchPatch.socratic.qa).toHaveLength(1);
    expect(scratchPatch.socratic.qa[0]).toMatchObject({
      question: 'What problem are we solving?',
      answer: 'my answer',
      sender: 'octocat',
    });
    expect(db.resumeWorkflowRun).toHaveBeenCalledWith('run-1');
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      'explore',
      expect.objectContaining({ triggerId: 'slack:team:chan:thread', channelId: 'chan', threadId: 'thread' }),
    );
  });
});

describe('dispatch — build dispatch', () => {
  const buildRoute = (ctx: Record<string, unknown> = {}): Route => ({
    action: 'handler',
    handler: 'github-orchestrator',
    context: {
      _routeKey: 'github.issue_build',
      repo: 'cliftonc/lastlight',
      issueNumber: 27,
      title: 'Add feature',
      body: 'please',
      labels: ['enhancement'],
      sender: 'octocat',
      commentBody: '@last-light build this',
      ...ctx,
    },
  });

  function buildDb(over: Record<string, any> = {}) {
    return { isRunning: vi.fn().mockReturnValue(false), recordStart: vi.fn(), recordFinish: vi.fn(), ...over };
  }

  it('dispatches the build workflow and records a build-cycle execution', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', raw: { comment: { id: 999 } } });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = { reactToComment: vi.fn().mockResolvedValue(undefined) };
    const db = buildDb();
    const deps = makeDeps(buildRoute(), { db: db as any, github: github as any, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'dispatched', workflow: 'build' });
    expect(db.recordStart).toHaveBeenCalledWith(expect.objectContaining({ skill: 'build-cycle', issueNumber: 27 }));
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      'build',
      expect.objectContaining({
        repo: 'cliftonc/lastlight',
        issueNumber: 27,
        title: 'Add feature',
        labels: ['enhancement'],
        _triggerType: 'webhook',
      }),
    );
    // Build dispatch does not leak the internal _routeKey into the workflow context.
    expect(dispatchWorkflow.mock.calls[0][1]).not.toHaveProperty('_routeKey');
  });

  it('acks a message-triggered build before running', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const deps = makeDeps(
      buildRoute({ _routeKey: 'slack.build' }),
      { db: buildDb() as any, github: null, dispatchWorkflow },
    );

    await dispatch(envelope, deps);

    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/starting build/i));
    expect(dispatchWorkflow).toHaveBeenCalledWith('build', expect.objectContaining({ _triggerType: 'chat' }));
  });
});

describe('dispatch — pr-fix dispatch', () => {
  const prFixRoute = (ctx: Record<string, unknown> = {}): Route => ({
    action: 'handler',
    handler: 'pr-fix',
    context: { _routeKey: 'github.pr_fix', repo: 'cliftonc/lastlight', prNumber: 5, sender: 'octocat', commentBody: 'fix it', ...ctx },
  });

  it('resolves the PR branch + CI failures and dispatches pr-fix', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 5 });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = {
      getPullRequest: vi.fn().mockResolvedValue({ title: 'PR', body: 'b', head: { ref: 'fix-branch', sha: 'abc' } }),
      getFailedChecks: vi.fn().mockResolvedValue('test-suite failed'),
    };
    const deps = makeDeps(prFixRoute(), {
      db: { isRunning: vi.fn().mockReturnValue(false) } as any,
      github: github as any,
      dispatchWorkflow,
    });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'dispatched', workflow: 'pr-fix' });
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      'pr-fix',
      expect.objectContaining({ prNumber: 5, branch: 'fix-branch', failedChecks: 'test-suite failed', _triggerType: 'webhook' }),
    );
  });

  it('does not dispatch when the branch cannot be resolved', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 5 });
    const dispatchWorkflow = vi.fn();
    const deps = makeDeps(prFixRoute(), {
      db: { isRunning: vi.fn().mockReturnValue(false) } as any,
      github: null,
      dispatchWorkflow,
    });

    const outcome = await dispatch(envelope, deps);

    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('ignored');
  });
});

describe('dispatch — generic messaging dispatch', () => {
  it('dispatches the workflow with a chat trigger and a run-start ack', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const deps = makeDeps(
      { action: 'handler', handler: 'issue-triage', context: { _routeKey: 'x', repo: 'cliftonc/lastlight', sender: 'octocat' } },
      { db: { isRunning: vi.fn().mockReturnValue(false) } as any, dispatchWorkflow },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'dispatched', workflow: 'issue-triage' });
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      'issue-triage',
      expect.objectContaining({ repo: 'cliftonc/lastlight', _triggerType: 'chat' }),
      expect.any(Function),
    );
    // _routeKey is stripped from the workflow context.
    expect(dispatchWorkflow.mock.calls[0][1]).not.toHaveProperty('_routeKey');
  });
});

describe('dispatch — webhook dispatch', () => {
  it('dispatches the workflow with a webhook trigger and no review check by default', async () => {
    const envelope = makeEnvelope({ type: 'pr.opened', repo: 'cliftonc/lastlight', prNumber: 8 });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = { createCheckRun: vi.fn() };
    const deps = makeDeps(
      { action: 'handler', handler: 'pr-review', context: { _routeKey: 'github.pr_opened', repo: 'cliftonc/lastlight', prNumber: 8 } },
      { db: { isRunning: vi.fn().mockReturnValue(false) } as any, github: github as any, dispatchWorkflow, reviewPostsCheck: false },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'dispatched', workflow: 'pr-review' });
    expect(dispatchWorkflow).toHaveBeenCalledWith('pr-review', expect.objectContaining({ _triggerType: 'webhook' }));
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it('posts an in-progress review check when reviewPostsCheck is enabled', async () => {
    const envelope = makeEnvelope({ type: 'pr.opened', repo: 'cliftonc/lastlight', prNumber: 8 });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = {
      getPullRequestHeadSha: vi.fn().mockResolvedValue('headsha'),
      createCheckRun: vi.fn().mockResolvedValue(4242),
      updateCheckRun: vi.fn().mockResolvedValue(undefined),
      getLatestBotReview: vi.fn().mockResolvedValue({ state: 'APPROVED', body: 'lgtm' }),
    };
    const deps = makeDeps(
      { action: 'handler', handler: 'pr-review', context: { _routeKey: 'github.pr_opened', repo: 'cliftonc/lastlight', prNumber: 8 } },
      { db: { isRunning: vi.fn().mockReturnValue(false) } as any, github: github as any, dispatchWorkflow, reviewPostsCheck: true },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'dispatched', workflow: 'pr-review' });
    expect(github.createCheckRun).toHaveBeenCalledWith(
      'cliftonc', 'lastlight', 'headsha', 'last-light/review', expect.anything(),
    );
  });
});

describe('dispatch — passthrough decisions', () => {
  it('returns ignored for an ignore route without replying', async () => {
    const envelope = makeEnvelope();
    const deps = makeDeps({ action: 'ignore', reason: 'no bot mention' });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'ignored', reason: 'no bot mention' });
    expect(envelope.reply).not.toHaveBeenCalled();
  });

  it('replies and returns replied for a reply route', async () => {
    const envelope = makeEnvelope();
    const deps = makeDeps({ action: 'reply', message: 'only maintainers can do that' });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'replied', message: 'only maintainers can do that' });
    expect(envelope.reply).toHaveBeenCalledWith('only maintainers can do that');
  });
});
