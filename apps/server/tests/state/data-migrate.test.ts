/**
 * The sqlite → postgres data migration.
 *
 * Hermetic: the target is PGlite (real Postgres, compiled to WASM), so the part
 * that actually needs proving runs in the ordinary test command — that a row
 * read through the SQLite schema can be written through the Postgres one
 * UNCHANGED. Three column mappings differ between the dialects and each fails
 * in its own direction:
 *
 * | column | sqlite | postgres | what a bad copy does |
 * |---|---|---|---|
 * | `executions.success` | `0/1` integer | real `boolean` | writes `1` into a boolean → error, or silently wrong |
 * | `workflow_runs.context` | JSON text | `jsonb` | double-encodes, or `JSON.parse`s an object |
 * | `messaging_messages.id` | AUTOINCREMENT | GENERATED ALWAYS | rejects the explicit id outright |
 *
 * The row-count verification inside `copyStateData` would catch none of those —
 * they are value bugs, not row bugs — so the assertions here read the values
 * back rather than counting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { asStateClient, tablesOf } from "#src/state/client.js";
import { StateDb } from "#src/state/db.js";
import * as pgSchema from "#src/state/schema/pg.js";
import {
  TABLE_ORDER,
  assertCoversEveryTable,
  copyStateData,
  type MigrateProgress,
} from "#src/state/data-migrate.js";
import { makeTestDb } from "../helpers/state-db.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/pg", import.meta.url));

const openPglite: PGlite[] = [];
afterEach(async () => {
  for (const p of openPglite.splice(0)) await p.close();
});

async function makePgTarget(): Promise<StateDb> {
  const pglite = new PGlite({ parsers: { 20: (v: string) => Number(v) } });
  openPglite.push(pglite);
  const client = asStateClient(drizzle(pglite, { schema: pgSchema }));
  await migrate(client as never, { migrationsFolder: MIGRATIONS });
  return StateDb.fromClient(client, "postgres");
}

/**
 * At least one row in every one of the fifteen tables.
 *
 * Written straight through the schema rather than through the store APIs on
 * purpose: the migration's job is to move whatever is in the database, not
 * whatever the current stores would have put there, and a real `lastlight.db`
 * has rows written by every version that ever ran. The awkward values are
 * deliberate — a `false` boolean (not just `true`, which survives a `1`
 * coercion), a tri-state NULL, nested JSON, and a non-ASCII string.
 */
async function seed(db: StateDb): Promise<void> {
  const now = new Date().toISOString();
  const t = tablesOf(db.client);
  const c = db.client;

  await c.insert(t.workflowRuns).values({
    id: "run-1",
    workflowName: "build",
    triggerId: "acme/widgets#7",
    owner: "acme",
    repo: "widgets",
    issueNumber: 7,
    currentPhase: "architect",
    phaseHistory: [{ phase: "architect", status: "completed", at: now }] as never,
    status: "running",
    context: { plan: { steps: ["a", "b"] }, depth: 3, flag: false, note: "café ☕" },
    startedAt: now,
    updatedAt: now,
    restartCount: 0,
  });

  await c.insert(t.executions).values([
    {
      id: "exec-ok",
      triggerType: "webhook",
      triggerId: "acme/widgets#7",
      skill: "build",
      owner: "acme",
      repo: "widgets",
      issueNumber: 7,
      startedAt: now,
      finishedAt: now,
      success: true,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 1.25,
      workflowRunId: "run-1",
      extensionStatus: { github: { enabled: true } } as never,
    },
    {
      // `consecutiveFailures()` reads `success === false`, so a copy that
      // turned this into `true` would turn every cron-failure alert off.
      id: "exec-bad",
      triggerType: "cron",
      triggerId: "acme/widgets",
      skill: "review",
      startedAt: now,
      finishedAt: now,
      success: false,
      error: "boom",
    },
    // Still in flight — the tri-state NULL must stay NULL, not become `false`.
    { id: "exec-running", triggerType: "chat", triggerId: "thread-1", skill: "chat", startedAt: now },
  ]);

  await c.insert(t.workflowApprovals).values({
    id: "appr-1",
    workflowRunId: "run-1",
    gate: "post_architect",
    summary: "Ship it?",
    status: "pending",
    requestedBy: "cliftonc",
    createdAt: now,
  });

  await c.insert(t.cronOverrides).values({
    name: "cron-review",
    enabled: false,
    schedule: "0 * * * *",
    updatedAt: now,
    updatedBy: "op",
  });
  await c.insert(t.workflowOverrides).values({
    name: "pr-review",
    enabled: false,
    updatedAt: now,
    updatedBy: "op",
  });
  await c.insert(t.cronRuns).values({
    id: "cron-1",
    cronName: "cron-review",
    workflow: "pr-review",
    source: "schedule",
    startedAt: now,
    status: "running",
  });

  await c.insert(t.users).values({
    id: "user-1",
    githubId: 42,
    login: "cliftonc",
    name: "Clifton",
    email: "c@example.com",
    avatarUrl: "https://example.com/a.png",
    slackUserId: "U123",
    isBlocked: false,
    emailIsPlaceholder: false,
    createdAt: now,
    updatedAt: now,
  });

  // The three composite-PK team tables + the sync marker.
  await c.insert(t.githubTeams).values({
    org: "acme",
    slug: "core",
    name: "Core",
    reposSyncedAt: now,
    truncated: false,
  });
  await c.insert(t.githubTeamRepos).values({ org: "acme", teamSlug: "core", repo: "acme/widgets" });
  await c.insert(t.githubTeamMembers).values({ org: "acme", teamSlug: "core", login: "cliftonc" });
  await c.insert(t.githubVisibilitySync).values({ login: "cliftonc", syncedAt: now, status: "ok" });

  await c.insert(t.feedbackAnchors).values({
    id: "anchor-1",
    source: "slack",
    kind: "message",
    externalId: "1700000000.0001",
    channel: "C123",
    owner: "acme",
    repo: "widgets",
    issueNumber: 7,
    workflowRunId: "run-1",
    workflowName: "build",
    createdAt: now,
  });
  await c.insert(t.feedbackSignals).values({
    id: "signal-1",
    anchorId: "anchor-1",
    source: "slack",
    workflowRunId: "run-1",
    workflowName: "build",
    emoji: "+1",
    score: 1,
    sentiment: "positive",
    reactor: "U123",
    observedAt: now,
  });

  // The one foreign key in the schema — and the one generated id.
  await c.insert(t.messagingSessions).values({
    id: "sess-1",
    platform: "slack",
    channelId: "C123",
    threadId: "1700000000.0001",
    userId: "U123",
    agentSessionId: "agent-1",
    createdAt: now,
    lastActivityAt: now,
    messageCount: 2,
    active: true,
  });
  await c.insert(t.messagingMessages).values([
    { sessionId: "sess-1", role: "user", content: "hello", timestamp: now },
    { sessionId: "sess-1", role: "assistant", content: "hi ☕", timestamp: now },
  ]);
}

describe("data-migrate", () => {
  it("covers every table in the schema", () => {
    // The guard that stops a 16th table from being silently left behind.
    expect(() => assertCoversEveryTable()).not.toThrow();
    expect(TABLE_ORDER).toHaveLength(15);
  });

  it("orders messaging_sessions before messaging_messages (the only FK)", () => {
    const keys = TABLE_ORDER.map((t) => t.key);
    expect(keys.indexOf("messagingSessions")).toBeLessThan(keys.indexOf("messagingMessages"));
  });

  it("copies every row and every value across the dialect boundary", async () => {
    const source = await makeTestDb();
    await seed(source);
    const target = await makePgTarget();

    const events: MigrateProgress[] = [];
    const result = await copyStateData(source, target, {
      batchSize: 2,
      onProgress: (e) => events.push(e),
    });

    // Row counts first — the cheap half.
    expect(result.tables).toHaveLength(15);
    expect(result.totalRows).toBeGreaterThan(0);
    for (const t of result.tables) expect(t.target).toBe(t.source);
    expect(events.at(-1)).toMatchObject({ type: "done", totalRows: result.totalRows });

    // Read the target back through its OWN schema objects, so the assertions
    // exercise the Postgres value mapping rather than a store's massaging.
    const dst = tablesOf(target.client);
    const execs = Object.fromEntries(
      (await target.client.select().from(dst.executions)).map((r) => [r.id, r]),
    );

    // Booleans: `false` must arrive as `false`, not `0` and not `true`.
    expect(execs["exec-bad"].success).toBe(false);
    expect(execs["exec-bad"].error).toBe("boom");
    expect(execs["exec-ok"].success).toBe(true);
    // The tri-state NULL survives as "still running", not as a failure.
    expect(execs["exec-running"].success).toBeNull();
    // `real` → `double precision`, the only float in the schema.
    expect(execs["exec-ok"].costUsd).toBeCloseTo(1.25);
    // JSON text → jsonb on a nullable column, and NULL where there was none.
    expect(execs["exec-ok"].extensionStatus).toEqual({ github: { enabled: true } });
    expect(execs["exec-bad"].extensionStatus).toBeNull();

    // The booleans the stores actually gate on.
    expect(await target.isWorkflowEnabled("pr-review")).toBe(false);
    expect((await target.getCronOverride("cron-review"))?.enabled).toBe(false);

    // JSON → jsonb: nested, with a non-ASCII string and a nested `false`.
    const [run] = await target.client.select().from(dst.workflowRuns);
    expect(run.context).toEqual({
      plan: { steps: ["a", "b"] },
      depth: 3,
      flag: false,
      note: "café ☕",
    });
    expect(run.phaseHistory).toHaveLength(1);

    // Composite-PK tables and the feedback pair.
    const [team] = await target.client.select().from(dst.githubTeams);
    expect(team).toMatchObject({ org: "acme", slug: "core", truncated: false });
    expect(await target.client.select().from(dst.githubTeamMembers)).toHaveLength(1);
    const [signal] = await target.client.select().from(dst.feedbackSignals);
    expect(signal).toMatchObject({ anchorId: "anchor-1", score: 1, emoji: "+1" });

    // The generated id: Postgres assigns its own (GENERATED ALWAYS rejects an
    // explicit one), and nothing references it — but the ORDER must survive,
    // because a thread reads back as its message sequence.
    const messages = await target.client
      .select()
      .from(dst.messagingMessages)
      .orderBy(dst.messagingMessages.id);
    expect(messages.map((m) => m.content)).toEqual(["hello", "hi ☕"]);
    expect(messages[0].id).toBeTypeOf("number");
  });

  it("refuses a non-empty target unless truncate is passed", async () => {
    const source = await makeTestDb();
    await seed(source);
    const target = await makePgTarget();
    await copyStateData(source, target, {});

    // Second run into the same target: primary keys would collide half-way
    // through and leave an interleaved mess, so it must not start at all.
    await expect(copyStateData(source, target, {})).rejects.toThrow(/not empty/i);

    // …and with --truncate it is a clean re-run, not a duplicate.
    const again = await copyStateData(source, target, { truncate: true });
    for (const t of again.tables) expect(t.target).toBe(t.source);
  });

  it("dry-run counts without writing", async () => {
    const source = await makeTestDb();
    await seed(source);
    const target = await makePgTarget();

    const result = await copyStateData(source, target, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.tables.find((t) => t.table === "executions")?.source).toBe(3);
    expect(result.totalRows).toBe(0);
    expect(await target.client.select().from(tablesOf(target.client).executions)).toHaveLength(0);
  });

  it("refuses to run in the wrong direction", async () => {
    const pg = await makePgTarget();
    const sqlite = await makeTestDb();
    await expect(copyStateData(pg, sqlite, {})).rejects.toThrow(/Source must be a SQLite/i);
    await expect(copyStateData(sqlite, sqlite, {})).rejects.toThrow(/Target must be a Postgres/i);
  });

  it("batches without skipping or repeating rows", async () => {
    const source = await makeTestDb();
    const now = new Date().toISOString();
    // 25 rows over a batch size of 4 — a size that divides unevenly, so an
    // off-by-one in the LIMIT/OFFSET walk shows up as a short final batch.
    const st = tablesOf(source.client);
    for (let i = 0; i < 25; i++) {
      await source.client.insert(st.executions).values({
        id: `e-${String(i).padStart(3, "0")}`,
        triggerType: "webhook",
        triggerId: "acme/widgets#1",
        skill: "build",
        startedAt: now,
      });
    }
    const target = await makePgTarget();
    const result = await copyStateData(source, target, { batchSize: 4 });
    const executions = result.tables.find((t) => t.table === "executions")!;
    expect(executions).toMatchObject({ source: 25, copied: 25, target: 25 });
    const ids = (await target.client.select().from(tablesOf(target.client).executions)).map(
      (e) => e.id,
    );
    // Distinctness is the real assertion: an off-by-one in the OFFSET walk
    // shows up as a repeated row, which the counts alone would still pass.
    expect(new Set(ids).size).toBe(25);
  });
});
