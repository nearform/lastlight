import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../../src/state/migrate.js";

/**
 * The #279 backfill: converge both repo-bearing tables on (owner, BARE repo).
 *
 * Rows are inserted with raw SQL on purpose — the stores now normalize at their
 * write choke points, so going through them would seed the shape we are trying
 * to prove the migration fixes.
 */
describe("migrate() — repo normalization (issue #279)", () => {
  function seed(): Database.Database {
    const raw = new Database(":memory:");
    migrate(raw);

    const run = raw.prepare(
      `INSERT INTO workflow_runs (id, workflow_name, trigger_id, owner, repo, current_phase, status, started_at, updated_at)
       VALUES (?, 'build', ?, ?, ?, 'phase_0', 'succeeded', '2026-01-01', '2026-01-01')`,
    );
    // Legacy: the qualified string in `repo`, no owner column value.
    run.run("r-legacy", "nearform/lastlight#1", null, "nearform/lastlight");
    // Legacy + an owner that was already backfilled from context.owner.
    run.run("r-both", "nearform/lastlight#2", "nearform", "nearform/lastlight");
    // Already the stored shape.
    run.run("r-modern", "nearform/lastlight#3", "nearform", "lastlight");
    // Bare repo, no owner column, no qualified string — but the trigger id
    // still names the account. This is the whole pre-owner-column population
    // on the drizby instance (8 rows).
    run.run("r-from-trigger", "cliftonc/lastlight#19", null, "lastlight");
    // Genuinely un-backfillable: nothing anywhere records the account.
    run.run("r-orphan", "42", null, "lastlight");
    // Slack-originated: the trigger id carries no repo to read.
    run.run("r-slack", "slack:T1:C1:1.0", null, "lastlight");

    const exec = raw.prepare(
      `INSERT INTO executions (id, trigger_type, trigger_id, skill, owner, repo, started_at, workflow_run_id)
       VALUES (?, 'webhook', ?, ?, NULL, ?, '2026-01-01', ?)`,
    );
    // Dispatcher-written build-cycle row: qualified repo, no owning run.
    exec.run("e-qualified", "3", "build-cycle", "nearform/lastlight", null);
    // Phase row: bare repo, owner recoverable from the owning run.
    exec.run("e-phase", "nearform/lastlight#3", "build:architect", "lastlight", "r-modern");
    // Phase row whose run is itself legacy — depends on workflow_runs going first.
    exec.run("e-legacy-run", "nearform/lastlight#1", "build:architect", "lastlight", "r-legacy");
    // Un-backfillable: bare repo, no run, no account.
    exec.run("e-orphan", "42", "build:architect", "lastlight", null);
    // Chat turn: no repo at all.
    exec.run("e-chat", "slack:T1:C1:1.0", "chat", null, null);

    return raw;
  }

  function runs(db: Database.Database) {
    const rows = db
      .prepare(`SELECT id, owner, repo FROM workflow_runs ORDER BY id`)
      .all() as { id: string; owner: string | null; repo: string | null }[];
    return Object.fromEntries(rows.map((r) => [r.id, [r.owner, r.repo]]));
  }

  function execs(db: Database.Database) {
    const rows = db
      .prepare(`SELECT id, owner, repo FROM executions ORDER BY id`)
      .all() as { id: string; owner: string | null; repo: string | null }[];
    return Object.fromEntries(rows.map((r) => [r.id, [r.owner, r.repo]]));
  }

  it("splits legacy qualified rows and rescues the account first", () => {
    const db = seed();
    migrate(db);

    expect(runs(db)).toEqual({
      "r-legacy": ["nearform", "lastlight"],
      // An owner already on the row wins; only `repo` is de-qualified.
      "r-both": ["nearform", "lastlight"],
      "r-modern": ["nearform", "lastlight"],
      // Last resort: the trigger id, which is built from the same pair at
      // dispatch and which the resume paths already prefer over the columns.
      "r-from-trigger": ["cliftonc", "lastlight"],
      // Nothing on these rows records the account. Left alone rather than
      // guessed — a filter reads a null owner as "always visible".
      "r-orphan": [null, "lastlight"],
      "r-slack": [null, "lastlight"],
    });

    expect(execs(db)).toEqual({
      // Owner off the qualified string it already carried.
      "e-qualified": ["nearform", "lastlight"],
      // Owner off the owning run.
      "e-phase": ["nearform", "lastlight"],
      // …including a run that only just got its own owner in this same pass,
      // which is why workflow_runs is normalized first.
      "e-legacy-run": ["nearform", "lastlight"],
      "e-orphan": [null, "lastlight"],
      "e-chat": [null, null],
    });

    db.close();
  });

  it("is idempotent — a second and third pass move nothing", () => {
    const db = seed();
    migrate(db);
    const afterFirst = { runs: runs(db), execs: execs(db) };

    migrate(db);
    migrate(db);

    expect({ runs: runs(db), execs: execs(db) }).toEqual(afterFirst);
    db.close();
  });

  it("adds executions.owner to a DB that predates the column", () => {
    const db = seed();
    db.exec(`ALTER TABLE executions DROP COLUMN owner`);
    expect(() => db.prepare(`SELECT owner FROM executions`).all()).toThrow();

    migrate(db);

    expect(execs(db)["e-phase"]).toEqual(["nearform", "lastlight"]);
    db.close();
  });

  it("leaves no slash behind in either table", () => {
    const db = seed();
    migrate(db);

    const stray = db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT repo FROM workflow_runs WHERE instr(repo, '/') > 0
           UNION ALL
           SELECT repo FROM executions WHERE instr(repo, '/') > 0
         )`,
      )
      .get() as { c: number };
    expect(stray.c).toBe(0);
    db.close();
  });
});
