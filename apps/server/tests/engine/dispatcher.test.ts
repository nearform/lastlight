import { describe, it, expect, vi, afterEach } from 'vitest';
import type { EventEnvelope } from '#src/connectors/types.js';
import { setRuntimeConfig, resetRuntimeConfigForTests } from '#src/config/config.js';
import {
  defaultFixConfig,
  defaultDependenciesConfig,
  defaultReviewConfig,
} from 'lastlight-shared/config-types';
import type { Route } from '#src/engine/router.js';
import type { PrState } from '#src/engine/pr-state.js';
import { HOLD_LABEL } from '#src/cron/dependabot-discovery.js';
import {
  dispatch,
  applyPrDispatchGate,
  prPolicyConfig,
  type DispatchDeps,
} from '#src/engine/dispatcher.js';

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
 * Build a mock StateDb shaped like the carved sub-stores
 * (`db.executions` / `db.runs` / `db.approvals`). Pass the leaf mocks by their
 * (flat) method names and they're routed into the right sub-store, so call
 * sites read naturally and assertions reach e.g. `db.runs.resolveGateAndResume`.
 */
function mockDb(over: Record<string, any> = {}) {
  const m = {
    // execution-store
    isRunning: vi.fn().mockReturnValue(false),
    runningExecutions: vi.fn().mockReturnValue([]),
    recordStart: vi.fn(),
    recordFinish: vi.fn(),
    getExecutionOutput: vi.fn(),
    // execution-store — the PR state machine's derived half
    costForTriggerWorkflows: vi.fn().mockReturnValue(0),
    phaseSucceededInRun: vi.fn().mockReturnValue(true),
    // workflow-run-store
    getRun: vi.fn(),
    latestSucceededForTrigger: vi.fn().mockReturnValue(null),
    resolveGateAndResume: vi.fn(),
    resolveGateAndFail: vi.fn(),
    resolveReplyGateAndResume: vi.fn(),
    // workflow-run-store — the PR state machine's derived half
    latestForTrigger: vi.fn().mockReturnValue(null),
    activeForTrigger: vi.fn().mockReturnValue(null),
    latestSucceededForTriggers: vi.fn().mockReturnValue({}),
    // workflow-run-store — the escalation record a terminal skip writes
    createRun: vi.fn(),
    finishRun: vi.fn(),
    // approval-store
    respond: vi.fn(),
    getPendingByTrigger: vi.fn(),
    getPendingForWorkflow: vi.fn(),
    ...over,
  };
  return {
    executions: {
      isRunning: m.isRunning,
      runningExecutions: m.runningExecutions,
      recordStart: m.recordStart,
      recordFinish: m.recordFinish,
      getExecutionOutput: m.getExecutionOutput,
      costForTriggerWorkflows: m.costForTriggerWorkflows,
      phaseSucceededInRun: m.phaseSucceededInRun,
    },
    runs: {
      getRun: m.getRun,
      latestSucceededForTrigger: m.latestSucceededForTrigger,
      resolveGateAndResume: m.resolveGateAndResume,
      resolveGateAndFail: m.resolveGateAndFail,
      resolveReplyGateAndResume: m.resolveReplyGateAndResume,
      latestForTrigger: m.latestForTrigger,
      activeForTrigger: m.activeForTrigger,
      latestSucceededForTriggers: m.latestSucceededForTriggers,
      createRun: m.createRun,
      finishRun: m.finishRun,
    },
    approvals: {
      respond: m.respond,
      getPendingByTrigger: m.getPendingByTrigger,
      getPendingForWorkflow: m.getPendingForWorkflow,
    },
  };
}

/**
 * A GitHub stub shaped for `resolvePrState` — one PR read plus the four
 * head-SHA reads it fans out. Defaults describe an ordinary same-repo PR with
 * a red build, which is the case every fix-path test starts from.
 */
function prGithubStub(
  pr: {
    headRef?: string;
    headSha?: string;
    baseRef?: string;
    labels?: string[];
    headRepo?: string | null;
    draft?: boolean;
    checksState?: 'passing' | 'failing' | 'pending' | 'none';
    baseChecksState?: 'passing' | 'failing' | 'pending' | 'none';
    headAuthor?: string;
    botReview?: { state: string } | null;
    /** The bot's newest review at ANY SHA — the generated-only gate's baseline. */
    lastBotReview?: { state: string; sha: string } | null;
    /** What `getChangedPathsBetween` answers for that baseline → head. */
    changedPathsSinceReview?: string[] | null;
  } = {},
  over: Record<string, any> = {},
) {
  return {
    getPullRequest: vi.fn().mockResolvedValue({
      title: 'PR',
      body: 'b',
      draft: pr.draft ?? false,
      labels: (pr.labels ?? []).map((name) => ({ name })),
      head: {
        ref: pr.headRef ?? 'fix-branch',
        sha: pr.headSha ?? 'sha-current',
        repo: pr.headRepo === undefined ? { full_name: 'cliftonc/lastlight' } : pr.headRepo && { full_name: pr.headRepo },
      },
      base: { ref: pr.baseRef ?? 'main', repo: { full_name: 'cliftonc/lastlight' } },
    }),
    getChecksSummary: vi.fn().mockResolvedValue({
      state: pr.checksState ?? 'failing',
      settledCount: 2,
      pendingCount: 0,
    }),
    getBaseChecksState: vi.fn().mockResolvedValue(pr.baseChecksState ?? 'passing'),
    getLatestBotReview: vi.fn().mockResolvedValue(pr.botReview ?? null),
    getBotReviewHistory: vi.fn().mockResolvedValue({
      atHead: pr.botReview ?? null,
      latest: pr.lastBotReview ?? (pr.botReview ? { ...pr.botReview, sha: pr.headSha ?? 'sha-current' } : null),
    }),
    getChangedPathsBetween: vi.fn().mockResolvedValue(pr.changedPathsSinceReview ?? null),
    getCommitAuthorName: vi.fn().mockResolvedValue(pr.headAuthor ?? 'octocat'),
    getCiFailureReport: vi.fn().mockResolvedValue({ jobs: [], logsAvailable: false }),
    postComment: vi.fn().mockResolvedValue(1),
    addLabels: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as any;
}

/**
 * Deps with everything stubbed. `route` is injected so a branch test names the
 * exact Route it wants — no LLM/classifier mocking needed. Individual tests
 * override only the deps the branch under test touches.
 */
function makeDeps(route: Route, overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    db: mockDb() as any,
    github: null,
    dispatchWorkflow: vi.fn().mockResolvedValue({ success: true }),
    sessionManager: {} as any,
    runChat: vi.fn(),
    route: vi.fn().mockResolvedValue(route),
    ...overrides,
  };
}

/** A successful ChatResult with the fields the chat handler reads. */
function chatResult(overrides: Partial<import('#src/engine/chat/chat.js').ChatResult> = {}): import('#src/engine/chat/chat.js').ChatResult {
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
    const db = mockDb();
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
    expect(db.executions.recordStart).toHaveBeenCalledTimes(1);
    expect(db.executions.recordFinish).toHaveBeenCalledTimes(1);
    const finishArg = (db.executions.recordFinish as any).mock.calls[0][1];
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
      db: mockDb() as any,
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
    const db = mockDb();
    const runChat = vi.fn().mockRejectedValue(new Error('boom'));
    const deps = makeDeps(chatRoute(), {
      db: db as any,
      sessionManager: { getSession: vi.fn(), setAgentSessionId: vi.fn() } as any,
      runChat,
    });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'handled', handler: 'chat' });
    expect((db.executions.recordFinish as any).mock.calls[0][1].success).toBe(false);
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
      { db: mockDb({ runningExecutions: vi.fn().mockReturnValue([]) }) as any },
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
        db: mockDb({
          runningExecutions: vi.fn().mockReturnValue([
            { skill: 'build', repo: 'cliftonc/lastlight', issueNumber: 12, startedAt: 'now' },
          ]),
        }) as any,
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
      { db: mockDb({ isRunning }) as any, dispatchWorkflow },
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
      { db: mockDb({ isRunning: vi.fn().mockReturnValue(true) }) as any },
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

  it('replies when no pending approval is found', async () => {
    const envelope = makeEnvelope({ type: 'comment.created' });
    const db = mockDb({ getPendingByTrigger: vi.fn().mockReturnValue(null) });
    const deps = makeDeps(
      approvalRoute({ decision: 'approved', repo: 'cliftonc/lastlight', issueNumber: 3 }),
      { db: db as any },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'handled', handler: 'approval-response' });
    expect(db.approvals.respond).not.toHaveBeenCalled();
    expect(db.runs.resolveGateAndResume).not.toHaveBeenCalled();
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/no pending approval/i));
  });

  it('approves: resolves the gate + resumes the run atomically, and re-dispatches the workflow', async () => {
    const envelope = makeEnvelope({ type: 'comment.created' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const db = mockDb({
      getPendingByTrigger: vi.fn().mockReturnValue({ id: 'appr-1', workflowRunId: 'run-1' }),
      getRun: vi.fn().mockReturnValue({
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

    // The atomic op is the single respond('approved') + setRunning path.
    expect(db.runs.resolveGateAndResume).toHaveBeenCalledWith('appr-1', 'maintainer');
    expect(db.approvals.respond).not.toHaveBeenCalled();
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      'build',
      expect.objectContaining({ repo: 'cliftonc/lastlight', issueNumber: 3, _triggerType: 'approval' }),
    );
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/approved/i));
  });

  it('approves but cannot resume without a GitHub App', async () => {
    const envelope = makeEnvelope({ type: 'comment.created' });
    const dispatchWorkflow = vi.fn();
    const db = mockDb({
      getPendingByTrigger: vi.fn().mockReturnValue({ id: 'appr-1', workflowRunId: 'run-1' }),
      getRun: vi.fn().mockReturnValue({ id: 'run-1', workflowName: 'build', triggerId: 'x/y#3', issueNumber: 3 }),
    });
    const deps = makeDeps(
      approvalRoute({ decision: 'approved', repo: 'x/y', issueNumber: 3 }),
      { db: db as any, github: null, dispatchWorkflow },
    );

    await dispatch(envelope, deps);

    // No GitHub App → record the approval without the atomic resume.
    expect(db.approvals.respond).toHaveBeenCalledWith('appr-1', 'approved', 'maintainer', undefined);
    expect(db.runs.resolveGateAndResume).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/cannot resume/i));
  });

  it('rejects: fails the run atomically and confirms', async () => {
    const envelope = makeEnvelope({ type: 'comment.created' });
    const db = mockDb({
      getPendingForWorkflow: vi.fn().mockReturnValue({ id: 'appr-2', workflowRunId: 'run-2' }),
    });
    const deps = makeDeps(
      approvalRoute({ decision: 'rejected', reason: 'too risky', workflowRunId: 'run-2' }),
      { db: db as any },
    );

    await dispatch(envelope, deps);

    expect(db.runs.resolveGateAndFail).toHaveBeenCalledWith('appr-2', 'maintainer', 'too risky');
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/rejected/i));
  });
});

describe('dispatch — explore-reply handler', () => {
  const replyRoute = (ctx: Record<string, unknown>): Route => ({
    action: 'handler',
    handler: 'explore-reply',
    context: { sender: 'octocat', reply: 'my answer', workflowRunId: 'run-1', ...ctx },
  });

  it('no-ops without dispatching when the run is not found', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const dispatchWorkflow = vi.fn();
    const db = mockDb({ getRun: vi.fn().mockReturnValue(undefined) });
    const deps = makeDeps(replyRoute({}), { db: db as any, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'handled', handler: 'explore-reply' });
    expect(db.runs.resolveReplyGateAndResume).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('no-ops when there is no pending reply gate', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const dispatchWorkflow = vi.fn();
    const db = mockDb({
      getRun: vi.fn().mockReturnValue({ id: 'run-1', triggerId: 'slack:t:c:th' }),
      getPendingForWorkflow: vi.fn().mockReturnValue({ id: 'g1', kind: 'approval' }),
    });
    const deps = makeDeps(replyRoute({}), { db: db as any, dispatchWorkflow });

    await dispatch(envelope, deps);

    expect(db.runs.resolveReplyGateAndResume).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('resolves the gate, appends the Q&A, resumes and re-dispatches explore (Slack)', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const db = mockDb({
      getRun: vi.fn().mockReturnValue({
        id: 'run-1',
        triggerId: 'slack:team:chan:thread',
        repo: 'lastlight',
        issueNumber: undefined,
        context: { owner: 'cliftonc' },
        scratch: { socratic: { lastOutput: 'What problem are we solving?', qa: [] } },
      }),
      getPendingForWorkflow: vi.fn().mockReturnValue({ id: 'gate-1', kind: 'reply' }),
    });
    const deps = makeDeps(
      replyRoute({ channelId: 'chan', threadId: 'thread' }),
      { db: db as any, dispatchWorkflow },
    );

    await dispatch(envelope, deps);

    // One atomic call resolves the gate, merges the Q&A scratch patch, and resumes.
    expect(db.runs.resolveReplyGateAndResume).toHaveBeenCalledTimes(1);
    const [runId, gateId, replyText, responder, scratchPatch] =
      (db.runs.resolveReplyGateAndResume as any).mock.calls[0];
    expect(runId).toBe('run-1');
    expect(gateId).toBe('gate-1');
    expect(replyText).toBe('my answer');
    expect(responder).toBe('octocat');
    expect(scratchPatch.socratic.qa).toHaveLength(1);
    expect(scratchPatch.socratic.qa[0]).toMatchObject({
      question: 'What problem are we solving?',
      answer: 'my answer',
      sender: 'octocat',
    });
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      'explore',
      expect.objectContaining({ triggerId: 'slack:team:chan:thread', channelId: 'chan', threadId: 'thread' }),
    );
  });
});

describe('dispatch — build dispatch', () => {
  const buildRoute = (ctx: Record<string, unknown> = {}): Route => ({
    action: 'handler',
    handler: 'build',
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

  it('dispatches the build workflow and records a build-cycle execution', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', raw: { comment: { id: 999 } } });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = { reactToComment: vi.fn().mockResolvedValue(undefined) };
    const db = mockDb();
    const deps = makeDeps(buildRoute(), { db: db as any, github: github as any, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'dispatched', workflow: 'build' });
    expect(db.executions.recordStart).toHaveBeenCalledWith(expect.objectContaining({ skill: 'build-cycle', issueNumber: 27 }));
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
      { db: mockDb() as any, github: null, dispatchWorkflow },
    );

    await dispatch(envelope, deps);

    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/starting build/i));
    expect(dispatchWorkflow).toHaveBeenCalledWith('build', expect.objectContaining({ _triggerType: 'chat' }));
  });
});

describe('dispatch — 👀 ack on github events', () => {
  // A generic handler route so the ack runs independent of any specific branch.
  const triageRoute = (): Route => ({
    action: 'handler',
    handler: 'issue-triage',
    context: { _routeKey: 'github.issue_comment', repo: 'cliftonc/lastlight', issueNumber: 7, sender: 'octocat' },
  });

  function ackGithub() {
    return {
      reactToComment: vi.fn().mockResolvedValue(undefined),
      reactToReviewComment: vi.fn().mockResolvedValue(undefined),
      reactToIssue: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('reacts 👀 on the comment for a classified issue comment', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', issueNumber: 7, raw: { comment: { id: 999 } } });
    const github = ackGithub();
    await dispatch(envelope, makeDeps(triageRoute(), { github: github as any }));
    expect(github.reactToComment).toHaveBeenCalledWith('cliftonc', 'lastlight', 999, 'eyes');
  });

  it('reacts 👀 on the review comment for a pr review comment', async () => {
    const envelope = makeEnvelope({ type: 'pr_review_comment.created', prNumber: 5, raw: { comment: { id: 42 } } });
    const github = ackGithub();
    await dispatch(envelope, makeDeps(triageRoute(), { github: github as any }));
    expect(github.reactToReviewComment).toHaveBeenCalledWith('cliftonc', 'lastlight', 42, 'eyes');
  });

  it('reacts 👀 on the issue itself for a freshly opened issue', async () => {
    const envelope = makeEnvelope({ type: 'issue.opened', issueNumber: 7, raw: {} });
    const github = ackGithub();
    await dispatch(envelope, makeDeps(triageRoute(), { github: github as any }));
    expect(github.reactToIssue).toHaveBeenCalledWith('cliftonc', 'lastlight', 7, 'eyes');
  });

  it('does not react on non-github (message) events', async () => {
    const envelope = makeEnvelope({ type: 'message', source: 'slack' });
    const github = ackGithub();
    await dispatch(envelope, makeDeps(triageRoute(), { github: github as any }));
    expect(github.reactToComment).not.toHaveBeenCalled();
    expect(github.reactToIssue).not.toHaveBeenCalled();
  });

  it('stays silent (no throw) when there is no comment id', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', issueNumber: 7, raw: {} });
    const github = ackGithub();
    await dispatch(envelope, makeDeps(triageRoute(), { github: github as any }));
    expect(github.reactToComment).not.toHaveBeenCalled();
  });
});

describe('dispatch — pr-fix dispatch', () => {
  const prFixRoute = (ctx: Record<string, unknown> = {}): Route => ({
    action: 'handler',
    handler: 'pr-fix',
    context: { _routeKey: 'github.pr_fix', repo: 'cliftonc/lastlight', prNumber: 5, sender: 'octocat', commentBody: 'fix it', ...ctx },
  });

  it('hands the resolved snapshot down instead of re-reading the PR', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 5 });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = prGithubStub({ headRef: 'fix-branch', headSha: 'abc', baseRef: 'release/2.x' });
    const deps = makeDeps(prFixRoute(), { db: mockDb() as any, github, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'dispatched', workflow: 'pr-fix' });
    // ONE PR read for the whole dispatch — `handlePrFix` used to issue a
    // second one of its own.
    expect(github.getPullRequest).toHaveBeenCalledTimes(1);
    const ctx = dispatchWorkflow.mock.calls[0][1];
    expect(ctx.prNumber).toBe(5);
    expect(ctx._triggerType).toBe('webhook');
    // The enrichment itself is `renderContext`'s job at `dispatchWorkflow`;
    // what this seam owes it is the snapshot.
    expect(ctx._prState).toMatchObject({
      repo: 'cliftonc/lastlight',
      prNumber: 5,
      headRef: 'fix-branch',
      headSha: 'abc',
      baseRef: 'release/2.x',
      checksState: 'failing',
    });
  });

  it('does not dispatch a fork PR — bails before any sandbox and posts a notice', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 5 });
    const dispatchWorkflow = vi.fn();
    const github = prGithubStub({ headRef: 'their-branch', headRepo: 'octocat/lastlight' });
    const deps = makeDeps(prFixRoute(), { db: mockDb() as any, github, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toContain('fork-pr');
    expect(github.postComment).toHaveBeenCalledWith(
      'cliftonc',
      'lastlight',
      5,
      expect.stringContaining('octocat/lastlight'),
    );
  });

  it('treats a deleted-fork PR (null head.repo) as a fork and bails', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 5 });
    const dispatchWorkflow = vi.fn();
    const github = prGithubStub({ headRef: 'gone', headRepo: null });
    const deps = makeDeps(prFixRoute(), { db: mockDb() as any, github, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('skipped');
    expect(github.postComment).toHaveBeenCalled();
  });

  it('does not dispatch when the branch cannot be resolved', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 5 });
    const dispatchWorkflow = vi.fn();
    const deps = makeDeps(prFixRoute(), { db: mockDb() as any, github: null, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('ignored');
  });

  it('refuses to act on a PR it could not read, and says which read failed', async () => {
    const envelope = makeEnvelope({ type: 'pr.checks_failed', prNumber: 5 });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    // `getPullRequest` is the one read whose degraded values are all the
    // PERMISSIVE ones — `labels: []`, `isFork: false`, `headSha: ''` — so a 502
    // yields a snapshot that LOOKS healthy and every guard below it evaluates
    // defaults rather than facts (#256). Every other read still fails open; see
    // the next case.
    const github = prGithubStub({}, {
      getPullRequest: vi.fn().mockRejectedValue(new Error('502 from GitHub')),
    });
    const deps = makeDeps(prFixRoute(), { db: mockDb() as any, github, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toContain('read-degraded');
    expect((outcome as any).reason).toContain('502 from GitHub');
  });

  it('makes that refusal transient — no label, no comment, no run row', async () => {
    // A "come back later", exactly like a run-lock drop: the cron re-pickup is
    // what makes dropping sound, and every side effect here would be a durable
    // statement written against a pull request we could not read.
    const envelope = makeEnvelope({ type: 'pr.checks_failed', prNumber: 5 });
    const db = mockDb();
    const github = prGithubStub({}, {
      getPullRequest: vi.fn().mockRejectedValue(new Error('403 from GitHub')),
    });
    const deps = makeDeps(prFixRoute(), { db: db as any, github });

    await dispatch(envelope, deps);

    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
    expect(db.runs.createRun).not.toHaveBeenCalled();
  });

  it('still fails open on a checks read error — no skip on incomplete data', async () => {
    const envelope = makeEnvelope({ type: 'pr.checks_failed', prNumber: 5 });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = prGithubStub({}, {
      getChecksSummary: vi.fn().mockRejectedValue(new Error('boom')),
      // A base we could not read must never read as `upstream-broken`.
      getBaseChecksState: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const deps = makeDeps(prFixRoute(), { db: mockDb() as any, github, dispatchWorkflow });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'dispatched', workflow: 'pr-fix' });
    const state = dispatchWorkflow.mock.calls[0][1]._prState;
    expect(state.readErrors).toHaveLength(2);
    expect(state.baseChecksState).toBe('none');
  });
});

describe('dispatch — the PR-scoped run lock', () => {
  const fixRoute = (): Route => ({
    action: 'handler',
    handler: 'dependabot-ci-fix',
    context: { repo: 'cliftonc/lastlight', prNumber: 190 },
  });

  it('drops a second PR-scoped run while another workflow holds the PR', async () => {
    const envelope = makeEnvelope({ type: 'pr.checks_failed', prNumber: 190 });
    const db = mockDb({
      activeForTrigger: vi.fn().mockReturnValue({ id: 'run-4821', workflowName: 'pr-fix' }),
    });
    const deps = makeDeps(fixRoute(), { db: db as any, github: prGithubStub() });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    // The reason is now produced by the DECISION (`runLockDrop`) rather than
    // written out a second time here, so the dispatcher's log line, the admin
    // panel and this outcome are three renderings of one string.
    expect((outcome as any).reason).toContain('run-in-flight: pr-fix run-4821');
    expect(deps.dispatchWorkflow).not.toHaveBeenCalled();
    // The lock spans EVERY PR-scoped workflow, keyed on `owner/repo#N`.
    expect(db.runs.activeForTrigger).toHaveBeenCalledWith(
      expect.arrayContaining(['pr-fix', 'dependabot-ci-fix', 'dependabot-pr-merge', 'pr-review']),
      'cliftonc/lastlight#190',
    );
  });

  it('does NOT escalate the PR it dropped — a lock loss is a "come back later"', async () => {
    // Ordering regression: the lock must be checked BEFORE the escalating
    // skips, or a PR whose budget the in-flight run is still spending gets
    // labelled `requires-human` for it.
    const envelope = makeEnvelope({ type: 'pr.checks_failed', prNumber: 190 });
    const db = mockDb({
      activeForTrigger: vi.fn().mockReturnValue({ id: 'run-4821', workflowName: 'pr-fix' }),
      costForTriggerWorkflows: vi.fn().mockReturnValue(99),
    });
    const github = prGithubStub();
    const deps = makeDeps(fixRoute(), { db: db as any, github });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toContain('run-in-flight');
    // No label, no comment, no escalation run row.
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
    expect(db.runs.createRun).not.toHaveBeenCalled();
  });

  it('drops the MERGE route too — auto-merge against a PR whose fix run is in flight', async () => {
    // 09 → S4 names this sequence verbatim: the fix pushes, CI goes green while
    // the run is still writing its comment and marker, `pr.checks_passed` fires,
    // and `dependabot-pr-merge` enables auto-merge on a tree still being
    // rewritten. `resolveMergeDisposition` never read the lock.
    const envelope = makeEnvelope({ type: 'pr.checks_passed', prNumber: 190 });
    const db = mockDb({
      activeForTrigger: vi.fn().mockReturnValue({ id: 'run-99', workflowName: 'dependabot-ci-fix' }),
    });
    const deps = makeDeps(
      {
        action: 'handler',
        handler: 'dependabot-pr-merge',
        context: { repo: 'cliftonc/lastlight', prNumber: 190 },
      },
      { db: db as any, github: prGithubStub({ checksState: 'passing' }) },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toContain('run-in-flight: dependabot-ci-fix run-99');
    expect(deps.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('does not override the lock for an explicit @bot request — it replies instead', async () => {
    // The lock is not policy but a physical constraint (one workspace, one
    // branch, one agent), so `explicitRequest` — which DOES override the label
    // guard, the mode, the draft filter and the per-SHA dedup — cannot buy past
    // it. `resolveReviewTrigger` used to answer `dispatch` here; only the
    // dispatcher's own inline guard stopped it, and that guard is gone.
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 190, body: '@last-light review' });
    const db = mockDb({
      activeForTrigger: vi.fn().mockReturnValue({ id: 'run-7', workflowName: 'pr-fix' }),
    });
    const deps = makeDeps(
      {
        action: 'handler',
        handler: 'pr-review',
        context: { repo: 'cliftonc/lastlight', prNumber: 190 },
      },
      { db: db as any, github: prGithubStub() },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect(deps.dispatchWorkflow).not.toHaveBeenCalled();
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/already working on this PR/i));
  });

  it('replies to a dropped human request — a maintainer silently dropped just asks again', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 190 });
    const db = mockDb({
      activeForTrigger: vi.fn().mockReturnValue({ id: 'run-4821', workflowName: 'dependabot-ci-fix' }),
    });
    const deps = makeDeps(fixRoute(), { db: db as any, github: prGithubStub() });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringMatching(/already working on this PR/i));
  });

  it('leaves the legacy already-running guard in place for non-PR-scoped workflows', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', issueNumber: 7 });
    const isRunning = vi.fn().mockReturnValue(true);
    const db = mockDb({ isRunning });
    const deps = makeDeps(
      { action: 'handler', handler: 'issue-triage', context: { repo: 'cliftonc/lastlight', issueNumber: 7 } },
      { db: db as any, github: prGithubStub() },
    );

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect(isRunning).toHaveBeenCalledWith('issue-triage', '7');
    expect(db.runs.activeForTrigger).not.toHaveBeenCalled();
  });
});

/**
 * The CRON / `/api/run` half of the gate.
 *
 * `dispatchWorkflow` (src/index.ts) is a closure inside `main()` and cannot be
 * reached from a test — which is exactly why the cron route's dispatch gate had
 * no coverage at all, and exactly where two of the defects fixed here hid: the
 * run lock was read by the dispatcher and by `resolveReviewTrigger`, neither of
 * which the cron fan-out crosses. The gate is now ONE exported function that
 * both routes call, so this is the cron route's dispatch gate under test, not a
 * re-implementation of it.
 */
describe('dispatch — the webhook route reads the repo-clamped policy', () => {
  // The gate existed twice and read different config: the dispatcher called
  // `getRuntimeConfig()` (operator-only, because it runs BEFORE
  // `resolveRepoRunConfig`), while `dispatchWorkflow` used `repoConfig?.fix ??
  // config.fix`. And `dispatchWorkflow` only gates `if (!prState)` — the webhook
  // route always hands `_prState` down — so on EVERY webhook-originated PR
  // dispatch a managed repo's clamps were silently not applied, while
  // `renderContext` rendered them into the prompt and `lastlight repo config
  // show` reported them.
  afterEach(() => resetRuntimeConfigForTests());

  const fixRoute = (): Route => ({
    action: 'handler',
    handler: 'dependabot-ci-fix',
    context: { repo: 'cliftonc/lastlight', prNumber: 190 },
  });

  /** A PR on its second attempt: runs under the operator's 3, exhausted under a repo's 1. */
  function secondAttemptDb() {
    return mockDb({
      latestForTrigger: vi.fn().mockReturnValue({
        id: 'run-1',
        workflowName: 'dependabot-ci-fix',
        status: 'succeeded',
        context: { prState: { headSha: 'sha-current', attempt: 1 } },
        scratch: {},
      }),
    });
  }

  it('applies a repo-clamped fix.maxAttempts that the operator config would have allowed', async () => {
    setRuntimeConfig({
      botName: 'last-light',
      botLogin: 'last-light[bot]',
      fix: defaultFixConfig(), // maxAttempts: 3
      dependencies: defaultDependenciesConfig(),
      review: defaultReviewConfig(),
    } as any);
    const envelope = makeEnvelope({ type: 'pr.checks_failed', prNumber: 190 });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = prGithubStub();
    const resolveRepoPolicy = vi.fn().mockResolvedValue({
      fix: { ...defaultFixConfig(), maxAttempts: 1 },
    });
    const deps = makeDeps(fixRoute(), {
      db: secondAttemptDb() as any,
      github,
      dispatchWorkflow,
      resolveRepoPolicy,
    });

    const outcome = await dispatch(envelope, deps);

    expect(resolveRepoPolicy).toHaveBeenCalledWith(
      'dependabot-ci-fix',
      expect.objectContaining({ repo: 'cliftonc/lastlight', prNumber: 190 }),
    );
    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toMatch(/attempts-exhausted: attempt 2 exceeds fix\.maxAttempts 1/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('runs the same PR when no repo layer applies — the clamp is the only difference', async () => {
    setRuntimeConfig({
      botName: 'last-light',
      botLogin: 'last-light[bot]',
      fix: defaultFixConfig(),
      dependencies: defaultDependenciesConfig(),
      review: defaultReviewConfig(),
    } as any);
    const envelope = makeEnvelope({ type: 'pr.checks_failed', prNumber: 190 });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const deps = makeDeps(fixRoute(), {
      db: secondAttemptDb() as any,
      github: prGithubStub(),
      dispatchWorkflow,
      resolveRepoPolicy: vi.fn().mockResolvedValue(undefined),
    });

    expect((await dispatch(envelope, deps)).kind).toBe('dispatched');
    expect(dispatchWorkflow).toHaveBeenCalled();
  });

  it('applies a repo-clamped review.trigger on the webhook route', async () => {
    // `review.trigger` is unclamped (free), so a repo may legitimately differ
    // from the operator in EITHER direction — which is what made this seam
    // observable: the sweep honoured the repo's value and the webhook did not.
    setRuntimeConfig({
      botName: 'last-light',
      botLogin: 'last-light[bot]',
      fix: defaultFixConfig(),
      dependencies: defaultDependenciesConfig(),
      review: { ...defaultReviewConfig(), trigger: 'eager' },
    } as any);
    const envelope = makeEnvelope({ type: 'pr.opened', repo: 'cliftonc/lastlight', prNumber: 8 });
    const dispatchWorkflow = vi.fn();
    const github = prGithubStub({ checksState: 'passing' }, { createCheckRun: vi.fn().mockResolvedValue(1) });
    const deps = makeDeps(
      {
        action: 'handler',
        handler: 'pr-review',
        context: { _routeKey: 'github.pr_opened', repo: 'cliftonc/lastlight', prNumber: 8 },
      },
      {
        db: mockDb() as any,
        github,
        dispatchWorkflow,
        resolveRepoPolicy: vi.fn().mockResolvedValue({
          review: { ...defaultReviewConfig(), trigger: 'on-request', postsCheck: true },
        }),
      },
    );

    const outcome = await dispatch(envelope, deps);

    // Under the operator's `eager` this would have dispatched.
    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toMatch(/^pr-review: on-request:/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    // And the placeholder is the repo's mode's, not the operator's.
    expect(github.createCheckRun).toHaveBeenCalledWith(
      'cliftonc',
      'lastlight',
      'sha-current',
      'last-light/review',
      expect.objectContaining({ conclusion: 'neutral' }),
    );
  });
});

describe('applyPrDispatchGate — the cron / api route crosses the same gate', () => {
  afterEach(() => resetRuntimeConfigForTests());

  function prState(over: Partial<PrState> = {}): PrState {
    return {
      repo: 'cliftonc/lastlight',
      prNumber: 190,
      headSha: 'abcdef1234567890',
      headAuthor: 'dependabot[bot]',
      headIsOurs: false,
      headRef: 'dependabot/npm/lodash-4.17.21',
      baseRef: 'main',
      isDraft: false,
      isFork: false,
      headRepoFullName: 'cliftonc/lastlight',
      labels: [],
      title: 'Bump lodash',
      body: '',
      checksState: 'failing',
      settledCheckCount: 3,
      baseChecksState: 'passing',
      botReviewAtHead: null,
      ciReport: null,
      attempt: 1,
      flakyDeferrals: 0,
      escalatedAtSha: null,
      intervention: null,
    forkNoticedAtSha: null,
      priorAttempts: [],
      notes: [],
      priorDiagnosisClass: null,
      cumulativeCostUsd: 0,
    costBaselineUsd: 0,
      assessedHeadShaByWorkflow: {},
      runInFlight: null,
      readErrors: [],
      ...over,
    } as PrState;
  }

  const policy = () => ({
    fix: defaultFixConfig(),
    dependencies: defaultDependenciesConfig(),
    review: defaultReviewConfig(),
  });

  it('blocks the daily red sweep from dispatching onto a PR with a live fix run', async () => {
    // `fix-red-dependency-prs` fans out straight to `dispatchWorkflow`, which
    // never read `runInFlight` — so this dispatched `dependabot-ci-fix` into the
    // same shared `${repo}-${prNumber}-fix` workspace a `pr-fix` agent was
    // working in.
    const db = mockDb();
    const github = prGithubStub();
    const d = await applyPrDispatchGate(
      {
        workflowName: 'dependabot-ci-fix',
        state: prState({ runInFlight: { workflow: 'pr-fix', runId: 'run-4821' } }),
        policy: policy(),
        route: 'attention',
        logPrefix: '[dispatch]',
      },
      { db: db as any, github },
    );

    expect(d.decision).toBe('skip');
    expect(d.runInFlight).toEqual({ workflow: 'pr-fix', runId: 'run-4821' });
    // Dropped, not escalated: no label, no comment, no escalation run row.
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
    expect(db.runs.createRun).not.toHaveBeenCalled();
  });

  it('blocks the daily green sweep from merging a PR with a live fix run', async () => {
    const db = mockDb();
    const github = prGithubStub({ checksState: 'passing' });
    const d = await applyPrDispatchGate(
      {
        workflowName: 'dependabot-pr-merge',
        state: prState({
          checksState: 'passing',
          runInFlight: { workflow: 'dependabot-ci-fix', runId: 'run-99' },
        }),
        policy: policy(),
        route: 'attention',
        logPrefix: '[dispatch]',
      },
      { db: db as any, github },
    );

    expect(d.decision).toBe('skip');
    expect(d.reason).toMatch(/^run-in-flight: dependabot-ci-fix run-99/);
  });

  it('still escalates a genuinely terminal skip on this route — the crons reach most exhausted PRs', async () => {
    const db = mockDb();
    const github = prGithubStub();
    const d = await applyPrDispatchGate(
      {
        workflowName: 'dependabot-ci-fix',
        state: prState({ attempt: 9 }),
        policy: policy(),
        route: 'attention',
        logPrefix: '[dispatch]',
      },
      { db: db as any, github },
    );

    expect(d.escalation).toBe('attempts-exhausted');
    // The run row is the load-bearing part: without it `escalatedAtSha` never
    // persists and the next dispatch reads our own label as a human's hold.
    expect(db.runs.createRun).toHaveBeenCalled();
    expect(github.addLabels).toHaveBeenCalled();
  });

  it('honours a repo-clamped fix.maxAttempts — the same policy object the prompt renders', async () => {
    const db = mockDb();
    const github = prGithubStub();
    // A repo that clamped itself to one attempt. `attempt: 2` runs under the
    // operator's default of 3 and is exhausted under the repo's 1.
    const clamped = { ...policy(), fix: { ...defaultFixConfig(), maxAttempts: 1 } };
    const d = await applyPrDispatchGate(
      {
        workflowName: 'dependabot-ci-fix',
        state: prState({ attempt: 2 }),
        policy: clamped,
        route: 'attention',
        logPrefix: '[dispatch]',
      },
      { db: db as any, github },
    );

    expect(d.decision).toBe('skip');
    expect(d.reason).toMatch(/attempts-exhausted: attempt 2 exceeds fix\.maxAttempts 1/);
    expect(
      (
        await applyPrDispatchGate(
          {
            workflowName: 'dependabot-ci-fix',
            state: prState({ attempt: 2 }),
            policy: policy(),
            route: 'attention',
            logPrefix: '[dispatch]',
          },
          { db: mockDb() as any, github: prGithubStub() },
        )
      ).decision,
    ).toBe('run');
  });

  /**
   * The retry's standalone row (03-retry-intervention.md → "Where the record
   * lives"). A retry that RESULTS IN A RUN needs none — `dispatchWorkflow`
   * persists the whole snapshot on `context.prState`, so the dispatched run
   * carries it. This is the other case.
   */
  const RETRY = {
    at: '2026-08-02T10:00:00.000Z',
    atSha: 'abcdef1234567890',
    via: 'comment' as const,
    by: 'alice',
  };

  it('records a retry the gate then skipped, so the ask is not lost', async () => {
    // `upstream-broken` is the case that matters: the base branch is red at the
    // exact moment somebody asks. A skip writes no run row, so without this the
    // retry evaporates — the base goes green an hour later, the PR is picked up,
    // the budget is still spent, and it escalates again.
    const db = mockDb();
    const github = prGithubStub();
    const d = await applyPrDispatchGate(
      {
        workflowName: 'dependabot-ci-fix',
        state: prState({ intervention: RETRY, baseChecksState: 'failing' }),
        policy: policy(),
        route: 'attention',
        logPrefix: '[dispatch]',
      },
      { db: db as any, github },
    );

    expect(d.reason).toMatch(/^upstream-broken:/);
    expect(db.runs.createRun).toHaveBeenCalledTimes(1);
    const row = db.runs.createRun.mock.calls[0][0];
    expect(row.currentPhase).toBe('retry-requested');
    expect(row.context.prState.intervention).toEqual(RETRY);
    // Recorded, not escalated: nothing is said on the PR.
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it('records NOTHING when the hold beat the retry', async () => {
    // Locked decision 4. The hold is not "come back later", it is "do not come
    // back" — recording a retry underneath it would re-arm the PR the moment
    // the label came off, on the strength of an ask we refused.
    const db = mockDb();
    const github = prGithubStub();
    const d = await applyPrDispatchGate(
      {
        workflowName: 'dependabot-ci-fix',
        state: prState({ intervention: RETRY, labels: ['lastlight-ignore'] }),
        policy: { ...policy(), holdLabel: 'lastlight-ignore' },
        route: 'attention',
        logPrefix: '[dispatch]',
      },
      { db: db as any, github },
    );

    expect(d.onHold).toEqual({ label: 'lastlight-ignore' });
    expect(db.runs.createRun).not.toHaveBeenCalled();
  });

  it('records NOTHING when a run already owns the PR', async () => {
    // A row written while another run owns the PR would become the
    // `latestForTrigger` the next dispatch reads its history off, displacing
    // the live run's own snapshot and losing its harvested attempt line. The
    // route's reply already says "ask me again if it doesn't cover what you
    // need", which is the right answer to a retry aimed at work in flight.
    const db = mockDb();
    const github = prGithubStub();
    await applyPrDispatchGate(
      {
        workflowName: 'dependabot-ci-fix',
        state: prState({ intervention: RETRY, runInFlight: { workflow: 'pr-fix', runId: 'run-1' } }),
        policy: policy(),
        route: 'attention',
        logPrefix: '[dispatch]',
      },
      { db: db as any, github },
    );

    expect(db.runs.createRun).not.toHaveBeenCalled();
  });

  it('reviews a never-settling PR on the sweep route — the release mechanism it claims to be', async () => {
    const db = mockDb();
    const github = prGithubStub({ checksState: 'pending' });
    const d = await applyPrDispatchGate(
      {
        workflowName: 'pr-review',
        state: prState({ checksState: 'pending' }),
        policy: { ...policy(), review: { ...defaultReviewConfig(), trigger: 'after-checks' } },
        route: 'sweep',
        logPrefix: '[dispatch]',
      },
      { db: db as any, github },
    );

    expect(d.decision).toBe('run');
    expect(d.review).toBe('dispatch');
  });
});

describe('prPolicyConfig — one config for both gates', () => {
  afterEach(() => resetRuntimeConfigForTests());

  it('prefers the repo layer over the operator config, leaf by leaf', () => {
    setRuntimeConfig({
      botName: 'last-light',
      botLogin: 'last-light[bot]',
      fix: { ...defaultFixConfig(), maxAttempts: 3 },
      dependencies: defaultDependenciesConfig(),
      review: { ...defaultReviewConfig(), trigger: 'eager' },
    } as any);

    expect(prPolicyConfig().fix.maxAttempts).toBe(3);
    expect(prPolicyConfig().review.trigger).toBe('eager');

    const layer = {
      fix: { ...defaultFixConfig(), maxAttempts: 1 },
      review: { ...defaultReviewConfig(), trigger: 'on-request' as const },
    };
    expect(prPolicyConfig(layer).fix.maxAttempts).toBe(1);
    expect(prPolicyConfig(layer).review.trigger).toBe('on-request');
    // A leaf the layer does not carry still comes from the operator.
    expect(prPolicyConfig(layer).dependencies).toEqual(defaultDependenciesConfig());
  });
});

describe('dispatch — generic messaging dispatch', () => {
  it('dispatches the workflow with a chat trigger and a run-start ack', async () => {
    const envelope = makeEnvelope({ type: 'message' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const deps = makeDeps(
      { action: 'handler', handler: 'issue-triage', context: { _routeKey: 'x', repo: 'cliftonc/lastlight', sender: 'octocat' } },
      { db: mockDb() as any, dispatchWorkflow },
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

describe('dispatch — the Slack thread transcript', () => {
  // A Slack thread is one conversation however each message was handled, but
  // only ChatRunner wrote to messaging_messages — so a message the classifier
  // sent to a workflow left no trace, and the next chat turn in the SAME
  // thread rehydrated an empty history and answered as if freshly introduced.

  /** A SessionManager stub recording just the two writes the transcript makes. */
  function transcriptSpy() {
    return {
      addMessage: vi.fn(),
      touchSession: vi.fn(),
      getSession: vi.fn().mockReturnValue(undefined),
      setAgentSessionId: vi.fn(),
      findActiveThreadSession: vi.fn().mockReturnValue(null),
    };
  }

  const slackEnvelope = () =>
    makeEnvelope({
      type: 'message',
      source: 'slack',
      body: 'how does the sandbox work in cliftonc/lastlight?',
      raw: { sessionId: 'sess-1', channelId: 'C1', threadId: 'T1' },
    });

  it('records the inbound message and the acks of a workflow-routed turn', async () => {
    const envelope = slackEnvelope();
    const sessionManager = transcriptSpy();
    const deps = makeDeps(
      {
        action: 'handler',
        handler: 'answer',
        context: { repo: 'cliftonc/lastlight', sender: 'clifton' },
      },
      { sessionManager: sessionManager as any, dispatchWorkflow: vi.fn().mockResolvedValue({ success: true }) },
    );

    await dispatch(envelope, deps);
    // handleMessageDispatch acks through the wrapped reply on a floating
    // promise — let it settle.
    await new Promise((r) => setImmediate(r));

    const recorded = sessionManager.addMessage.mock.calls.map((c) => [c[1], c[2]]);
    expect(recorded[0]).toEqual(['user', 'how does the sandbox work in cliftonc/lastlight?']);
    expect(recorded.some(([role, text]) => role === 'assistant' && /completed/.test(text))).toBe(true);
    expect(sessionManager.touchSession).toHaveBeenCalledWith('sess-1');
  });

  it('leaves the chat path alone — ChatRunner owns that transcript', async () => {
    const envelope = slackEnvelope();
    const sessionManager = transcriptSpy();
    const deps = makeDeps(
      { action: 'handler', handler: 'chat', context: { sessionId: 'sess-1', message: 'hi', sender: 'clifton' } },
      { sessionManager: sessionManager as any, runChat: vi.fn().mockResolvedValue(chatResult()) },
    );

    await dispatch(envelope, deps);

    // Recording here as well is exactly the double-write that moved
    // persistence into ChatRunner in the first place.
    expect(sessionManager.addMessage).not.toHaveBeenCalled();
  });

  it('records a router refusal, so the thread knows what it was told', async () => {
    const envelope = slackEnvelope();
    const sessionManager = transcriptSpy();
    const deps = makeDeps(
      { action: 'reply', message: "I don't manage that repo." },
      { sessionManager: sessionManager as any },
    );

    await dispatch(envelope, deps);

    expect(sessionManager.addMessage.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['user', 'how does the sandbox work in cliftonc/lastlight?'],
      ['assistant', "I don't manage that repo."],
    ]);
  });

  it('does not record a github event', async () => {
    const sessionManager = transcriptSpy();
    const deps = makeDeps(
      { action: 'handler', handler: 'issue-triage', context: { repo: 'cliftonc/lastlight' } },
      { sessionManager: sessionManager as any },
    );

    await dispatch(makeEnvelope({ type: 'issue.opened' }), deps);

    expect(sessionManager.addMessage).not.toHaveBeenCalled();
  });
});

describe('dispatch — the pr-review trigger gate (Phase 7)', () => {
  // `review.trigger` used to be enforceable in four places, only one of which
  // was config-aware. It is now ONE pure function over the PR snapshot, called
  // from the single dispatch choke point — so these cases are the webhook
  // route's half of a contract the cron and comment routes share by
  // construction (09 → S2).
  afterEach(() => resetRuntimeConfigForTests());

  function withReview(over: Partial<ReturnType<typeof defaultReviewConfig>> = {}) {
    setRuntimeConfig({
      botName: 'last-light',
      botLogin: 'last-light[bot]',
      fix: defaultFixConfig(),
      dependencies: defaultDependenciesConfig(),
      review: { ...defaultReviewConfig(), ...over },
    } as any);
  }

  function reviewDeps(github: any, dispatchWorkflow: any, envType = 'pr.opened') {
    return {
      envelope: makeEnvelope({ type: envType as any, repo: 'cliftonc/lastlight', prNumber: 8 }),
      deps: makeDeps(
        {
          action: 'handler',
          handler: 'pr-review',
          context: { _routeKey: 'github.pr_opened', repo: 'cliftonc/lastlight', prNumber: 8 },
        },
        { db: mockDb() as any, github, dispatchWorkflow },
      ),
    };
  }

  it('eager reviews on PR attention, in parallel with CI', async () => {
    withReview({ trigger: 'eager' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = prGithubStub({ checksState: 'pending' });
    const { envelope, deps } = reviewDeps(github, dispatchWorkflow);

    expect(await dispatch(envelope, deps)).toEqual({ kind: 'dispatched', workflow: 'pr-review' });
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      'pr-review',
      expect.objectContaining({ _triggerType: 'webhook' }),
    );
    // The dispatcher no longer owns the check at all — creation moved to the
    // one choke point every route crosses (09 → S2).
    expect(github.createCheckRun).toBeUndefined();
  });

  it('after-checks defers on PR attention and posts a `queued` check', async () => {
    withReview({ trigger: 'after-checks', postsCheck: true });
    const dispatchWorkflow = vi.fn();
    const github = prGithubStub(
      { checksState: 'pending' },
      { createCheckRun: vi.fn().mockResolvedValue(4242) },
    );
    const { envelope, deps } = reviewDeps(github, dispatchWorkflow);

    const outcome = await dispatch(envelope, deps);
    expect(outcome.kind).toBe('skipped');
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(github.createCheckRun).toHaveBeenCalledWith(
      'cliftonc',
      'lastlight',
      'sha-current',
      'last-light/review',
      expect.objectContaining({ status: 'queued' }),
    );
  });

  it('on-request skips and posts a `neutral` check whose Re-run is the affordance', async () => {
    withReview({ trigger: 'on-request', postsCheck: true });
    const dispatchWorkflow = vi.fn();
    const github = prGithubStub({}, { createCheckRun: vi.fn().mockResolvedValue(4242) });
    const { envelope, deps } = reviewDeps(github, dispatchWorkflow);

    expect((await dispatch(envelope, deps)).kind).toBe('skipped');
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(github.createCheckRun).toHaveBeenCalledWith(
      'cliftonc',
      'lastlight',
      'sha-current',
      'last-light/review',
      expect.objectContaining({ status: 'completed', conclusion: 'neutral' }),
    );
  });

  it('a settled check suite is what after-checks actually fires on', async () => {
    withReview({ trigger: 'after-checks' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = prGithubStub({ checksState: 'failing' });
    const { envelope, deps } = reviewDeps(github, dispatchWorkflow, 'pr.checks_settled');

    expect(await dispatch(envelope, deps)).toEqual({ kind: 'dispatched', workflow: 'pr-review' });
  });

  it('skips a DRAFT PR on the webhook path — which had no draft check at all before', async () => {
    withReview({ trigger: 'eager', skipDraft: true, postsCheck: true });
    const dispatchWorkflow = vi.fn();
    const github = prGithubStub(
      { draft: true, checksState: 'passing' },
      { createCheckRun: vi.fn() },
    );
    const { envelope, deps } = reviewDeps(github, dispatchWorkflow);

    const outcome = await dispatch(envelope, deps);
    expect(outcome).toEqual({
      kind: 'skipped',
      reason: 'pr-review: draft: review.skipDraft is on',
    });
    // A run that never dispatches creates NO check, rather than creating one and
    // immediately concluding it (09 → S2).
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it('skips a head we already reviewed — one API call, not a sandbox run', async () => {
    withReview({ trigger: 'eager', postsCheck: true });
    const dispatchWorkflow = vi.fn();
    const github = prGithubStub(
      { botReview: { state: 'APPROVED' } },
      { createCheckRun: vi.fn() },
    );
    const { envelope, deps } = reviewDeps(github, dispatchWorkflow);

    const outcome = await dispatch(envelope, deps);
    expect(outcome.kind).toBe('skipped');
    expect((outcome as { reason: string }).reason).toMatch(/already-reviewed/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it('an explicit @bot review always dispatches — overriding mode, draft AND dedup', async () => {
    withReview({ trigger: 'on-request', skipDraft: true });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = prGithubStub({ draft: true, botReview: { state: 'APPROVED' } });
    const envelope = makeEnvelope({
      type: 'comment.created',
      repo: 'cliftonc/lastlight',
      prNumber: 8,
      body: '@last-light review',
    });
    const deps = makeDeps(
      {
        action: 'handler',
        handler: 'pr-review',
        context: { _routeKey: 'github.pr_review', repo: 'cliftonc/lastlight', prNumber: 8 },
      },
      { db: mockDb() as any, github, dispatchWorkflow },
    );

    expect(await dispatch(envelope, deps)).toEqual({ kind: 'dispatched', workflow: 'pr-review' });
  });

  it('a review requested from us by name is an explicit request too', async () => {
    withReview({ trigger: 'on-request' });
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const github = prGithubStub();
    const envelope = makeEnvelope({
      type: 'pr.review_requested',
      repo: 'cliftonc/lastlight',
      prNumber: 8,
      requestedReviewer: 'last-light[bot]',
    });
    const deps = makeDeps(
      {
        action: 'handler',
        handler: 'pr-review',
        context: { _routeKey: 'github.pr_review_requested', repo: 'cliftonc/lastlight', prNumber: 8 },
      },
      { db: mockDb() as any, github, dispatchWorkflow },
    );

    expect(await dispatch(envelope, deps)).toEqual({ kind: 'dispatched', workflow: 'pr-review' });
  });

  it('does not post a placeholder on the 30-minute sweep route — that would be one check per tick', async () => {
    withReview({ trigger: 'on-request', postsCheck: true });
    const dispatchWorkflow = vi.fn();
    const github = prGithubStub({}, { createCheckRun: vi.fn() });
    // A sweep dispatch never crosses `dispatch()`; the closest webhook analogue
    // is a settle event, which is also not PR attention.
    const { envelope, deps } = reviewDeps(github, dispatchWorkflow, 'pr.checks_settled');

    expect((await dispatch(envelope, deps)).kind).toBe('skipped');
    expect(github.createCheckRun).not.toHaveBeenCalled();
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

describe('dispatch — escalating a terminal skip', () => {
  const fixRoute = (): Route => ({
    action: 'handler',
    handler: 'dependabot-ci-fix',
    context: { repo: 'cliftonc/lastlight', prNumber: 190 },
  });

  /** A prior fix run that took the PR to its last allowed attempt. */
  const exhausted = () =>
    mockDb({
      latestForTrigger: vi.fn().mockReturnValue({
        id: 'r1',
        context: { prState: { attempt: 3, headSha: 'sha-current' } },
      }),
    });

  it('labels, comments and RECORDS the skip — silence is what this replaces', async () => {
    const envelope = makeEnvelope({ type: 'pr.checks_failed', prNumber: 190 });
    const github = prGithubStub({ headSha: 'sha-current' });
    const db = exhausted();
    const deps = makeDeps(fixRoute(), { github, db: db as any });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toContain('attempts-exhausted');
    expect(deps.dispatchWorkflow).not.toHaveBeenCalled();
    expect(github.addLabels).toHaveBeenCalledWith('cliftonc', 'lastlight', 190, ['requires-human']);
    expect(github.postComment).toHaveBeenCalledTimes(1);
    // The row is the load-bearing part: without it `escalatedAtSha` never
    // persists, and the next dispatch reads our own label as a human's
    // permanent hold (09 → D1).
    expect(db.runs.createRun).toHaveBeenCalledTimes(1);
    const row = (db.runs.createRun as any).mock.calls[0][0];
    expect(row.workflowName).toBe('dependabot-ci-fix');
    expect(row.triggerId).toBe('cliftonc/lastlight#190');
    expect(row.context.prState.escalatedAtSha).toBe('sha-current');
    // `succeeded`, not `failed` — 09 → S1 reserves `failed` for malfunction.
    expect(db.runs.finishRun).toHaveBeenCalledWith(row.id, 'succeeded', expect.anything());
  });

  it('applies nothing on a non-escalating skip', async () => {
    // A red base is not this PR's fault and self-heals — labelling it would
    // poison `requires-human` with a condition that resolves itself.
    const envelope = makeEnvelope({ type: 'pr.checks_failed', prNumber: 190 });
    const github = prGithubStub({ headSha: 'sha-current', baseChecksState: 'failing' });
    const db = exhausted();
    const deps = makeDeps(fixRoute(), { github, db: db as any });

    const outcome = await dispatch(envelope, deps);

    expect((outcome as any).reason).toContain('upstream-broken');
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
    expect(db.runs.createRun).not.toHaveBeenCalled();
  });
});

describe('dispatch — the dependency-merge disposition', () => {
  const checksRoute = (ctx: Record<string, unknown> = {}): Route => ({
    action: 'handler',
    handler: 'dependabot-pr-merge',
    context: { repo: 'cliftonc/lastlight', prNumber: 190, ...ctx },
  });

  it('DISPATCHES a PR carrying requires-human — the label is a notification, not a state', async () => {
    // 02-hold-label.md. `requires-human` used to be inferred into a permanent
    // "bot, stay out" whenever no escalating run of ours matched — which meant
    // it worked only on a PR we had never touched, and read as our own label
    // everywhere else. Nothing reads it now; the HOLD label below is the block.
    const envelope = makeEnvelope({ type: 'pr.checks_passed', prNumber: 190 });
    const github = prGithubStub({ labels: ['requires-human'], checksState: 'passing' });
    const deps = makeDeps(checksRoute(), { github });

    const outcome = await dispatch(envelope, deps);

    expect(outcome).toEqual({ kind: 'dispatched', workflow: 'dependabot-pr-merge' });
  });

  it('skips SILENTLY when the hold label is on the PR', async () => {
    // No label, no comment, no run row, no reply — a cron/webhook tick that
    // finds the hold says nothing at all (locked decision 3).
    const envelope = makeEnvelope({ type: 'pr.checks_passed', prNumber: 190 });
    const github = prGithubStub({ labels: [HOLD_LABEL], checksState: 'passing' });
    const deps = makeDeps(checksRoute(), { github });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toContain('on-hold');
    expect(deps.dispatchWorkflow).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
    expect(envelope.reply).not.toHaveBeenCalled();
  });

  it('replies exactly once when an EXPLICIT request loses to the hold', async () => {
    // Locked decision 4: the hold beats an explicit request, and the bot says
    // so — otherwise it is silently ignoring a direct instruction, which is
    // worse than refusing it. The reply belongs to the ROUTE that has a human on
    // the other end, which is why the cron tick above stays quiet.
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 190, body: '@last-light merge this' });
    const github = prGithubStub({ labels: [HOLD_LABEL], checksState: 'passing' });
    const deps = makeDeps(checksRoute(), { github });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect(deps.dispatchWorkflow).not.toHaveBeenCalled();
    expect(envelope.reply).toHaveBeenCalledTimes(1);
    expect(envelope.reply).toHaveBeenCalledWith(expect.stringContaining(HOLD_LABEL));
  });

  it('skips when this workflow already assessed the current head SHA', async () => {
    const envelope = makeEnvelope({ type: 'pr.checks_passed', prNumber: 190 });
    const github = prGithubStub({ headSha: 'sha-current', checksState: 'passing' });
    const db = mockDb({
      latestSucceededForTriggers: vi.fn().mockReturnValue({
        'dependabot-pr-merge': { id: 'r1', context: { prState: { headSha: 'sha-current' } } },
      }),
    });
    const deps = makeDeps(checksRoute(), { github, db: db as any });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toContain('already-assessed');
  });

  it('honours a pre-snapshot run row that persisted only a bare headSha', async () => {
    // The upgrade path: rows written before `context.prState` existed carried
    // `context.headSha` alone. Ignoring them would re-assess every open PR once.
    const envelope = makeEnvelope({ type: 'pr.checks_passed', prNumber: 190 });
    const github = prGithubStub({ headSha: 'sha-current', checksState: 'passing' });
    const db = mockDb({
      latestSucceededForTriggers: vi.fn().mockReturnValue({
        'dependabot-pr-merge': { id: 'r1', context: { headSha: 'sha-current' } },
      }),
    });
    const deps = makeDeps(checksRoute(), { github, db: db as any });

    expect((await dispatch(envelope, deps)).kind).toBe('skipped');
  });

  it('skips while CI is still running — the cheapest possible wait', async () => {
    const envelope = makeEnvelope({ type: 'pr.checks_passed', prNumber: 190 });
    const github = prGithubStub({ checksState: 'pending' });
    const deps = makeDeps(checksRoute(), { github });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('skipped');
    expect((outcome as any).reason).toContain('checks-pending');
    expect(deps.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('runs once for a genuinely new head SHA', async () => {
    const envelope = makeEnvelope({ type: 'pr.checks_passed', prNumber: 190 });
    const github = prGithubStub({ headSha: 'sha-new', checksState: 'passing' });
    const db = mockDb({
      latestSucceededForTriggers: vi.fn().mockReturnValue({
        'dependabot-pr-merge': { id: 'r1', context: { prState: { headSha: 'sha-old' } } },
      }),
    });
    const deps = makeDeps(checksRoute(), { github, db: db as any });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('dispatched');
    expect(deps.dispatchWorkflow).toHaveBeenCalledTimes(1);
  });

  it('does NOT gate a human @bot comment request — an explicit ask is an override', async () => {
    const envelope = makeEnvelope({ type: 'comment.created', prNumber: 190 });
    const github = prGithubStub({ labels: ['requires-human'], checksState: 'passing' });
    const deps = makeDeps(checksRoute(), { github });

    const outcome = await dispatch(envelope, deps);

    expect(outcome.kind).toBe('dispatched');
    expect(deps.dispatchWorkflow).toHaveBeenCalledTimes(1);
  });
});
