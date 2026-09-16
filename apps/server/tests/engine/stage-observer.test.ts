/**
 * The TERMINAL stage advance — the second and final call site of
 * `advanceStage`, and the thing that stops `agent-building` being a dead end.
 *
 * These drive the observer through a REAL `StateDb`: the cases call
 * `db.runs.finishRun(...)` and assert on what reached the faked GitHub client,
 * rather than invoking an exported handler directly. That is deliberate and it
 * is the whole point of the module — the claim being tested is "a run reaching
 * a terminal status moves its issue's label", and the link that claim depends
 * on is the store's `TerminalRunObserver` firing. A test that called the async
 * half directly would pass with the observer unregistered.
 *
 * Likewise the label assertions are made on the GitHub CLIENT calls, never on a
 * mocked `advanceStage`: what matters is that the right label reached GitHub,
 * and mocking the advance would fake exactly the link under test.
 *
 * The two easy mistakes in this module each get a case: a `paused` run (an
 * approval gate — still in flight, must not be reported as finished) and a
 * non-stage run (an `@bot build`, which must never acquire stage labels it
 * did not enter the pipeline through).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { installStageObserver } from "#src/engine/stage-observer.js";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import {
  STAGE_AGENT_BUILDING,
  STAGE_AGENT_BLOCKED,
  STAGE_READY_FOR_HUMAN,
} from "#src/engine/stage-labels.js";
import { makeTestDb } from "../helpers/state-db.js";
import type { StateDb } from "#src/state/db.js";
import type { GitHubClient } from "#src/engine/github/github.js";

// The observer logs through the pino LoggerPort; mock it so the suite's stderr
// stays free of real JSON from the degradation and failure cases.
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

const OWNER = "cliftonc";
const NAME = "lastlight";
const REPO = `${OWNER}/${NAME}`;
const ISSUE = 412;

/** A GitHub stand-in recording the two label writes the advance is made of. */
function fakeGithub(
  over: { addLabels?: () => Promise<void>; removeLabel?: () => Promise<void> } = {},
) {
  const addLabels = vi.fn(async (_o: string, _r: string, _n: number, _names: string[]) => {
    if (over.addLabels) await over.addLabels();
  });
  const removeLabel = vi.fn(async (_o: string, _r: string, _n: number, _name: string) => {
    if (over.removeLabel) await over.removeLabel();
  });
  return { addLabels, removeLabel } as unknown as GitHubClient & {
    addLabels: ReturnType<typeof vi.fn>;
    removeLabel: ReturnType<typeof vi.fn>;
  };
}

/**
 * A run as the build gate would have left it: dispatched under the `build`
 * stage, so it carries `_stage` on its context and sits on `agent-building`.
 */
async function seedStageRun(
  db: StateDb,
  id: string,
  context: Record<string, unknown> = { _stage: "build", _autonomous: true },
): Promise<string> {
  await db.runs.createRun({
    id,
    workflowName: "build",
    triggerId: `${REPO}#${ISSUE}`,
    owner: OWNER,
    repo: NAME,
    issueNumber: ISSUE,
    currentPhase: "architect",
    status: "running",
    context,
    startedAt: new Date().toISOString(),
  });
  return id;
}

/**
 * The observer fires the GitHub work and returns — so a test has to let the
 * microtask queue drain before asserting on what reached the client.
 */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe("installStageObserver", () => {
  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
    // Real config from a real overlay: the observer reads the stage's
    // `running` / `on_success` / `on_failure` labels, and a stubbed config
    // would let those drift from what a deployment actually gets.
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
    const dir = mkdtempSync(join(tmpdir(), "stage-observer-"));
    writeFileSync(join(dir, "config.yaml"), `autonomy:\n  repos:\n    - "${REPO}"\n`);
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", dir);
    loadConfig();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("a SUCCEEDED build lands on the success terminus, running label off", async () => {
    const github = fakeGithub();
    installStageObserver(db, { github });
    await seedStageRun(db, "run-ok");

    await db.runs.finishRun("run-ok", "succeeded");
    await settle();

    // Add first, then remove — the ordering rule, seen from the other end.
    expect(github.addLabels).toHaveBeenCalledWith(OWNER, NAME, ISSUE, [STAGE_READY_FOR_HUMAN]);
    expect(github.removeLabel).toHaveBeenCalledWith(OWNER, NAME, ISSUE, STAGE_AGENT_BUILDING);
  });

  it("a FAILED build lands on the failure terminus", async () => {
    const github = fakeGithub();
    installStageObserver(db, { github });
    await seedStageRun(db, "run-failed");

    await db.runs.finishRun("run-failed", "failed");
    await settle();

    expect(github.addLabels).toHaveBeenCalledWith(OWNER, NAME, ISSUE, [STAGE_AGENT_BLOCKED]);
    expect(github.removeLabel).toHaveBeenCalledWith(OWNER, NAME, ISSUE, STAGE_AGENT_BUILDING);
  });

  it("a CANCELLED build lands on the failure terminus too — not left building", async () => {
    // From the issue's point of view a cancel and a failure are the same fact:
    // the build did not get there and a person needs to look. Leaving a
    // cancelled run on `agent-building` would strand it exactly as before.
    const github = fakeGithub();
    installStageObserver(db, { github });
    await seedStageRun(db, "run-cancelled");

    await db.runs.finishRun("run-cancelled", "cancelled");
    await settle();

    expect(github.addLabels).toHaveBeenCalledWith(OWNER, NAME, ISSUE, [STAGE_AGENT_BLOCKED]);
  });

  it("a PAUSED run moves NOTHING — an approval gate is not a terminus", async () => {
    // The easy mistake in this module. A run sitting on `post_architect` is
    // still in flight; labelling it `ready-for-human` would report a build as
    // finished mid-run, and the later resume would move the label a second
    // time. `pauseRun` is not a terminal transition and must notify nobody.
    const github = fakeGithub();
    installStageObserver(db, { github });
    await seedStageRun(db, "run-paused");

    await db.runs.setPaused("run-paused");
    await settle();

    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("a run with no stage on its context moves nothing — an `@bot build` is not a stage run", async () => {
    // A human-asked build never entered the pipeline through a label, so it
    // must not acquire one on the way out.
    const github = fakeGithub();
    installStageObserver(db, { github });
    await seedStageRun(db, "run-manual", { repo: REPO, issueNumber: ISSUE });

    await db.runs.finishRun("run-manual", "succeeded");
    await settle();

    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("an explicitly non-autonomous run moves nothing", async () => {
    const github = fakeGithub();
    installStageObserver(db, { github });
    await seedStageRun(db, "run-not-auto", { _stage: "build", _autonomous: false });

    await db.runs.finishRun("run-not-auto", "succeeded");
    await settle();

    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("an UNKNOWN stage moves nothing and does not throw", async () => {
    // An operator renamed the stage between dispatch and completion. There is
    // no label vocabulary to move within, so there is nothing correct to do.
    const github = fakeGithub();
    installStageObserver(db, { github });
    await seedStageRun(db, "run-unknown", { _stage: "nope", _autonomous: true });

    await expect(db.runs.finishRun("run-unknown", "succeeded")).resolves.toBeUndefined();
    await settle();

    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("a GitHub failure does not throw out of the observer", async () => {
    // The observer contract: the terminal transition is already persisted, and
    // no projection of it may undo that or cost the other observers theirs.
    const github = fakeGithub({
      addLabels: async () => {
        throw new Error("GitHub is down");
      },
    });
    installStageObserver(db, { github });
    await seedStageRun(db, "run-boom");

    await expect(db.runs.finishRun("run-boom", "succeeded")).resolves.toBeUndefined();
    await settle();

    // The add failed, so the remove was never attempted — the issue stays on
    // `agent-building`, a true statement about it, rather than falling out of
    // the pipeline carrying no label at all.
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("firing twice is harmless — the advance is idempotent at both ends", async () => {
    // The observer can fire more than once for one run (a restart-resumed run
    // that finishes twice, a cancel racing a finish). It carries no dedup
    // state and needs none: re-adding a present label is a GitHub no-op and
    // `removeLabel` swallows the 404 that means "already gone".
    const github = fakeGithub();
    installStageObserver(db, { github });
    await seedStageRun(db, "run-twice");

    await db.runs.finishRun("run-twice", "succeeded");
    await db.runs.finishRun("run-twice", "succeeded");
    await settle();

    expect(github.addLabels).toHaveBeenCalledTimes(2);
    for (const call of github.addLabels.mock.calls) {
      expect(call).toEqual([OWNER, NAME, ISSUE, [STAGE_READY_FOR_HUMAN]]);
    }
    expect(github.removeLabel).toHaveBeenCalledTimes(2);
  });

  it("tells the caller a label moved, so a cached copy of it can be dropped", async () => {
    // The board reads labels through a 120 s cache and run status live from the
    // database, so without this a card shows FAILED while still sitting in the
    // "building" column — one card disagreeing with itself.
    const onAdvanced = vi.fn();
    const github = fakeGithub();
    installStageObserver(db, { github, onAdvanced });
    await seedStageRun(db, "run-notify");

    await db.runs.finishRun("run-notify", "succeeded");
    await settle();

    expect(onAdvanced).toHaveBeenCalledWith(REPO);
  });

  it("stays QUIET when the advance degraded — there is nothing better to re-read", async () => {
    // Half-advanced means the issue now carries both labels. Busting the cache
    // would spend a GitHub request to fetch the same wrong answer.
    const onAdvanced = vi.fn();
    const github = fakeGithub({
      removeLabel: async () => {
        throw new Error("GitHub said no");
      },
    });
    installStageObserver(db, { github, onAdvanced });
    await seedStageRun(db, "run-half");

    await db.runs.finishRun("run-half", "succeeded");
    await settle();

    expect(onAdvanced).not.toHaveBeenCalled();
  });

  it("a throwing listener cannot undo an advance that already happened", async () => {
    const github = fakeGithub();
    installStageObserver(db, {
      github,
      onAdvanced: () => {
        throw new Error("cache exploded");
      },
    });
    await seedStageRun(db, "run-throws");

    await db.runs.finishRun("run-throws", "succeeded");
    await settle();

    // The labels still moved: the notification is the last thing, and advisory.
    expect(github.addLabels).toHaveBeenCalled();
    expect(github.removeLabel).toHaveBeenCalled();
  });

  it("falls back to parsing triggerId when the columns are not populated", async () => {
    const github = fakeGithub();
    installStageObserver(db, { github });
    await db.runs.createRun({
      id: "run-bare",
      workflowName: "build",
      triggerId: `${REPO}#${ISSUE}`,
      currentPhase: "architect",
      status: "running",
      context: { _stage: "build", _autonomous: true },
      startedAt: new Date().toISOString(),
    });

    await db.runs.finishRun("run-bare", "succeeded");
    await settle();

    expect(github.addLabels).toHaveBeenCalledWith(OWNER, NAME, ISSUE, [STAGE_READY_FOR_HUMAN]);
  });
});
