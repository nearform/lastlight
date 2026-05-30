---
title: "Event Model"
order: 4
description: "The canonical EventEnvelope schema. The shape every integration normalizes its platform-specific payload into before the router sees it."
---

## Purpose

The Event Model is the contract between [Integrations](/spec/03-integrations)
and the [Router](/spec/05-router). It exists to keep the router (and
everything downstream) free of platform-specific shapes — GitHub webhook
JSON, Slack Bolt event objects, raw HTTP bodies — without losing the
information those payloads carry.

If you add a new event source, you implement one new `Connector` that
produces this shape. Nothing else changes.

## Schema

```ts
export interface EventEnvelope {
  /** Unique event ID — used for dedup. */
  id: string;
  /** Source connector name: "github" | "slack" | (future) "discord", etc. */
  source: string;
  /** Normalized event type (see EventType). */
  type: EventType;
  /** Repository in owner/repo form. Absent for non-repo-scoped events. */
  repo?: string;
  /** Issue or PR number on GitHub. */
  issueNumber?: number;
  /** PR number, distinct from issueNumber for PR-only routing decisions. */
  prNumber?: number;
  /** Login / username of the originator. */
  sender: string;
  /** True if the originator is a bot — used for self-loop checks. */
  senderIsBot: boolean;
  /** Event body text — issue body, comment body, PR description, message text. */
  body: string;
  /** Title — issues and PRs only. */
  title?: string;
  /** Labels currently on the issue/PR at event time. Snapshot, not delta. */
  labels?: string[];
  /** GitHub author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE. */
  authorAssociation?: string;
  /** Original platform payload. Connector-specific data goes here. */
  raw: unknown;
  /** Post a reply on the same platform / thread. Fire-and-forget. */
  reply: (msg: string) => Promise<void>;
  /** Event time, set by the connector. */
  timestamp: Date;
}

export type EventType =
  | "issue.opened"
  | "issue.reopened"
  | "issue.closed"
  | "pr.opened"
  | "pr.synchronize"      // new commits pushed to a PR
  | "pr.reopened"
  | "pr.closed"
  | "pr.merged"
  | "comment.created"
  | "pr_review.submitted"
  | "pr_review_comment.created"
  | "message";            // generic chat-platform message (Slack today)
```

Required fields: `id`, `source`, `type`, `sender`, `senderIsBot`,
`body`, `raw`, `reply`, `timestamp` (nine). Everything else is
platform-conditional.

Defined in `src/connectors/types.ts`. Imported as `EventEnvelope` /
`EventType` across the codebase — there is exactly one definition.

## Behaviour

Connectors build `EventEnvelope` literals directly — there is no
builder helper, no validation layer between connector and router. The
router trusts the connector to produce a conforming object.

The order of events through the system:

1. Connector receives a platform payload.
2. Connector runs auth (HMAC, allowlist, etc.).
3. Connector decides whether the payload should produce an envelope at
   all. Many GitHub actions (`labeled`, `edited`, etc.) drop here. See
   [Integrations](/spec/03-integrations).
4. Connector constructs the envelope and emits `event`.
5. `ConnectorRegistry` forwards it to the central handler in the
   harness.
6. The harness calls `routeEvent(envelope)` ([Router](/spec/05-router))
   and dispatches the matched workflow or skill.

The envelope is read in steps 5 and 6; from then on it lives only in
the workflow context where dispatched code may pull fields from it.

## Platform field availability

| Field | GitHub events | Slack `message` |
|---|---|---|
| `repo` | always | never |
| `issueNumber` | issues + PRs + comments + reviews | never |
| `prNumber` | PR events + PR comments only | never |
| `title` | issues + PRs (+ comments via parent) | never |
| `labels` | issues + PRs (snapshot at event time) | never |
| `authorAssociation` | always (see below) | never |
| `senderIsBot` | always `false` (bot self-events are filtered at the connector) | always `false` |
| `raw.sessionId` / `channelId` / `threadId` | n/a | always (Slack — session routing) |

For Slack, channel id, thread id, and platform user id live in
`envelope.raw`, not on the top-level envelope. The canonical schema
stays small; platform extras stay in `raw`. The chat skill reads them
back when it needs to route a reply to the right thread.

## `authorAssociation`

GitHub-only. Values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`,
`NONE`. The router treats the first three as "maintainer":

```ts
// src/engine/router.ts:28
const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
```

`@last-light` build commands from a `CONTRIBUTOR` or `NONE` get a
polite decline (`router.ts:123–130`) and never reach a workflow.

## `reply()`

```ts
reply: (msg: string) => Promise<void>;
```

- **GitHub** — posts a comment on the source issue or PR via the
  configured `replyFn(owner, repo, issueNumber, msg)`.
  (`github-webhook.ts:237`)
- **Slack** — calls `sendMessage(channelId, threadId, chunk)` for each
  chunk of a chunked message, replying into the originating thread.
  (`base.ts:89–99`)

Both are async, both return `Promise<void>`. Neither returns the
resulting artifact (comment URL, message ts). Callers that need the
artifact must fetch it via the platform API separately.

`reply()` is fire-and-forget — GitHub's variant silently no-ops if
`replyFn` or issue context is missing; Slack's is wrapped in `.catch()`
at the call site (`src/index.ts:994`). A re-implementation that wants
to surface delivery failures must thread errors through explicitly.

## `raw`

The original platform payload, plus connector-attached metadata for
Slack:

```ts
// github-webhook.ts:256
raw: payload  // the full GitHub webhook body, unmodified

// base.ts:109–115
raw: {
  ...(typeof raw === "object" && raw !== null ? raw : {}),
  sessionId,
  platformUserId,
  channelId,
  threadId,
}
```

Downstream code reads `raw` rarely — the harness pulls `raw.comment?.id`
to react to a triggering GitHub comment (`src/index.ts:942`), and the
chat skill pulls session ids out of Slack's `raw` for thread-resumption
after a harness restart (`src/index.ts:192–194`). The router itself
never inspects `raw` — all routing decisions use top-level fields.

## Invariants

- **One canonical definition.** Every consumer imports
  `EventEnvelope` / `EventType` from `src/connectors/types.ts`. There is
  no duplicate or platform-extended version.
- **`labels` is a snapshot, not a delta.** If a label is added after the
  event, the original envelope still reflects the old set. This is
  intentional — events are immutable.
- **`senderIsBot: true` does not exist in practice.** Both connectors
  filter bot events upstream (or set the field `false` because there is
  no bot path that produces an envelope). Code that branches on
  `senderIsBot === true` is dead.
- **`type === "message"` is the only chat-platform type.** No Slack-
  specific subtypes (`message.app_mention`, `message.dm`). Disambiguation
  inside chat happens via fields in `raw` and by the router examining
  the body for `@last-light` mentions.
- **No factory.** Connectors build literals inline. A re-implementation
  may add a builder helper but should not add a validation step — the
  connector is the contract.
- **Fields look optional but aren't, for some events.** A workflow that
  expects `repo` should refuse to run if `envelope.repo` is missing.
  The schema is permissive; the consumers' contracts are not.

## Current implementation

| Piece | File |
|---|---|
| `EventEnvelope`, `EventType`, `Connector` | `src/connectors/types.ts` |
| GitHub normalizer | `src/connectors/github-webhook.ts:157–260` |
| Slack / messaging normalizer | `src/connectors/messaging/base.ts:47–121` |
| Router consumer | `src/engine/router.ts` |
| Harness consumer | `src/index.ts:560–1124` |
| Test factory | `src/engine/router.test.ts:24–38` |

## Rebuild notes

- **Keep the envelope small.** Resist the temptation to add
  per-integration fields. Anything platform-specific belongs in `raw`.
  The schema stays comprehensible because every field justifies its
  presence by being meaningful for at least two integrations.
- **Treat `raw` as opaque from the router's perspective.** A new
  router decision should be possible without changing the EventEnvelope
  schema — add a new top-level field only when the data is universal.
- **Make `type` an enum, not a free-form string.** Catching a typo at
  the connector boundary is much cheaper than catching it in a workflow
  five minutes after dispatch.
- **`reply()` as a closure on the envelope is the right shape.** The
  alternative — connectors expose a `reply(envelopeId, msg)` method —
  forces every consumer to know which connector to call into. The
  closure pattern means callers only need the envelope they already
  have.
- **Async, fire-and-forget reply, by default.** Most callers don't
  need delivery confirmation. If a re-implementation makes `reply()`
  return a useful value (a comment URL or message ts), it should still
  be discardable — the common path is "post and move on".
- **Snapshot semantics on time-varying fields.** Labels, author
  association, body text — capture them at event time. Re-fetching at
  workflow-run time creates surprising races where the agent acts on
  state that didn't exist when the event fired.
