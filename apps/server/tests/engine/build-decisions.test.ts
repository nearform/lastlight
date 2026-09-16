/**
 * Table tests over literal {@link BuildTriggerInputs} records — no GitHub mock,
 * no sandbox, no harness.
 *
 * This is the same payoff `pr-decisions.test.ts` takes: once the decision is a
 * pure function over one resolved input record, its whole verification is a
 * table. Each case names the behaviour it protects, and each asserts the REASON
 * as well as the decision — the reason is what gets rendered in the log line,
 * the issue comment and the admin run panel, so a decision whose justification
 * drifted is a real regression even when the boolean is unchanged.
 */

import { describe, it, expect } from "vitest";
import {
  resolveBuildTrigger,
  issueTriggerId,
  type BuildTriggerInputs,
} from "#src/engine/build-decisions.js";
import type { AutonomyBudgetConfig } from "#src/config/config.js";

/**
 * The PACKAGED ceilings (`config/default.yaml` → `autonomy.budget`). Pinned as
 * literals rather than read from config: these tests are about the function's
 * behaviour AT a ceiling, and reading the real config would make every case
 * silently re-target itself the day somebody tunes the defaults.
 */
const BUDGET: AutonomyBudgetConfig = {
  maxConcurrentBuilds: 2,
  maxBuildsPerRepoPerDay: 3,
  dailyUsd: 25,
  repoDailyUsd: 10,
};

/** `resolveBuildTrigger` with the packaged budget, unless a case varies it. */
function decide(i: BuildTriggerInputs, budget: AutonomyBudgetConfig = BUDGET) {
  return resolveBuildTrigger(i, budget);
}

/**
 * A clean `ready-for-agent` on an autonomous repo, applied by a human, with no
 * history and nothing in flight. Every case overrides only what it is about.
 */
function inputs(over: Partial<BuildTriggerInputs> = {}): BuildTriggerInputs {
  return {
    repo: "cliftonc/lastlight",
    issueNumber: 190,
    labels: ["ready-for-agent"],
    addedLabel: "ready-for-agent",
    route: "labeled",
    senderIsBot: false,
    autonomyEnabled: true,
    alreadyBuilt: false,
    runInFlight: false,
    holdLabel: "lastlight-ignore",
    // Comfortably inside every ceiling, so a case that does not mention budgets
    // is not secretly about one.
    concurrentAutonomousBuilds: 0,
    buildsForRepoToday: 0,
    spendTodayUsd: 0,
    repoSpendTodayUsd: 0,
    ...over,
  };
}

describe("resolveBuildTrigger", () => {
  const cases: Array<
    [string, Partial<BuildTriggerInputs>, "dispatch" | "skip", RegExp]
  > = [
    [
      "a clean labelled issue on an autonomous repo dispatches",
      {},
      "dispatch",
      /^ready:/,
    ],
    [
      // The router already catches this on the `labeled` route — but the sweep
      // never crosses the router, so the guard has to live here too.
      "the hold label skips, silently",
      { labels: ["ready-for-agent", "lastlight-ignore"] },
      "skip",
      /^on-hold:/,
    ],
    [
      "the hold label is read from the CURRENT labels on the sweep route too",
      { route: "sweep", addedLabel: undefined, labels: ["ready-for-agent", "lastlight-ignore"] },
      "skip",
      /^on-hold:/,
    ],
    [
      // The operator's master switch: no state an individual issue can be in
      // earns it an unattended build on a repo that never opted in.
      "a repo that is not on the autonomy allow-list skips",
      { autonomyEnabled: false },
      "skip",
      /^not-autonomous:/,
    ],
    [
      // Not a verdict — a "come back later", released by the backstop sweep.
      "a live run for the same trigger skips",
      { runInFlight: true },
      "skip",
      /^run-in-flight:/,
    ],
    [
      "the api route dispatches on the same terms as the webhook",
      { route: "api", addedLabel: undefined },
      "dispatch",
      /^ready:/,
    ],
  ];

  it.each(cases)("%s", (_name, over, expected, reason) => {
    const d = decide(inputs(over));
    expect(d.decision).toBe(expected);
    expect(d.reason).toMatch(reason);
  });

  it("names the configured hold label in the reason, not a literal", () => {
    // The label is operator-configurable, so a caller telling a human which
    // label to remove cannot hardcode it.
    const d = decide(inputs({ holdLabel: "do-not-touch", labels: ["ready-for-agent", "do-not-touch"] }),
    );
    expect(d.reason).toContain("do-not-touch");
    expect(d.onHold).toEqual({ label: "do-not-touch" });
  });
});

/**
 * THE ASYMMETRY — the whole point of the `already-built` branch, asserted as a
 * named pair because the two halves are only correct with reference to each
 * other.
 *
 * `alreadyBuilt` is the idempotency key, and what it MEANS depends on who
 * re-applied the label. Against our own bot it is a loop guard and binds
 * absolutely; against a human it is a retry instruction and yields — the same
 * rule `resolveReviewTrigger` follows when it puts the explicit-request branch
 * above the per-head dedup, because a dedup aimed at machines looping should
 * bind machines.
 */
describe("resolveBuildTrigger — the already-built asymmetry", () => {
  it("already-built + senderIsBot: true → skip (an automated re-label can never re-spend)", () => {
    const d = decide(inputs({ alreadyBuilt: true, senderIsBot: true }));
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^already-built:/);
  });

  it("already-built + senderIsBot: false → dispatch (a maintainer re-label is an explicit retry)", () => {
    const d = decide(inputs({ alreadyBuilt: true, senderIsBot: false }));
    expect(d.decision).toBe("dispatch");
    // The reason records WHICH argument reached dispatch, so a re-spend is
    // greppable after the fact rather than indistinguishable from a first run.
    expect(d.reason).toMatch(/^retry:/);
  });

  it("the two halves differ ONLY in senderIsBot", () => {
    const bot = decide(inputs({ alreadyBuilt: true, senderIsBot: true }));
    const human = decide(inputs({ alreadyBuilt: true, senderIsBot: false }));
    expect(bot.decision).not.toBe(human.decision);
  });

  it("a bot label on an issue with NO prior build still dispatches", () => {
    // The guard is on the repeat, not on the sender: our triage bot applying
    // the label for the first time is the designed happy path.
    const d = decide(inputs({ alreadyBuilt: false, senderIsBot: true }));
    expect(d.decision).toBe("dispatch");
    expect(d.reason).toMatch(/^ready:/);
  });

  it("a run in flight still outranks a human retry", () => {
    // Not policy — two builds on one issue means two agents pushing the same
    // branch. A physical constraint no instruction overrides.
    const d = decide(inputs({ alreadyBuilt: true, senderIsBot: false, runInFlight: true }),
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^run-in-flight:/);
  });
});

/**
 * BRANCH PRECEDENCE. Each case makes several conditions true at once and pins
 * which one gets to answer — the ordering IS the design, so it needs assertions
 * that fail when somebody reorders the branches.
 */
describe("resolveBuildTrigger — branch precedence", () => {
  const everything: Partial<BuildTriggerInputs> = {
    labels: ["ready-for-agent", "lastlight-ignore"],
    autonomyEnabled: false,
    alreadyBuilt: true,
    senderIsBot: true,
    runInFlight: true,
  };

  it("hold outranks everything, including a clean dispatch", () => {
    const d = decide(inputs({ labels: ["ready-for-agent", "lastlight-ignore"] }),
    );
    expect(d.reason).toMatch(/^on-hold:/);
  });

  it("hold outranks not-autonomous, already-built and run-in-flight together", () => {
    expect(decide(inputs(everything)).reason).toMatch(/^on-hold:/);
  });

  it("not-autonomous outranks already-built and run-in-flight", () => {
    const d = decide(inputs({ ...everything, labels: ["ready-for-agent"] }));
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^not-autonomous:/);
  });

  it("already-built outranks run-in-flight", () => {
    // Both would skip, but the reason a human reads must be the durable one:
    // "we already built this" is a different instruction from "try again later".
    const d = decide(inputs({ alreadyBuilt: true, senderIsBot: true, runInFlight: true }),
    );
    expect(d.reason).toMatch(/^already-built:/);
  });

  it("run-in-flight is the last skip before dispatch", () => {
    const d = decide(inputs({ runInFlight: true }));
    expect(d.reason).toMatch(/^run-in-flight:/);
  });
});

/**
 * The envelope contract. Every decision — dispatch or skip, every branch —
 * carries a non-empty `"<case>: <explanation>"` reason and the FULL input
 * record, because the log line, the comment and the panel are three renderings
 * of one source and none of them may re-derive a field the gate already read.
 */
describe("resolveBuildTrigger — the decision envelope", () => {
  const everyBranch: Array<[string, Partial<BuildTriggerInputs>]> = [
    ["on-hold", { labels: ["ready-for-agent", "lastlight-ignore"] }],
    ["not-autonomous", { autonomyEnabled: false }],
    ["already-built", { alreadyBuilt: true, senderIsBot: true }],
    ["run-in-flight", { runInFlight: true }],
    ["concurrency-exhausted", { concurrentAutonomousBuilds: 2 }],
    ["repo-quota-exhausted", { buildsForRepoToday: 3 }],
    ["budget-exhausted", { spendTodayUsd: 25 }],
    ["retry", { alreadyBuilt: true, senderIsBot: false }],
    ["ready", {}],
  ];

  it.each(everyBranch)("%s carries a non-empty <case>: <explanation> reason", (_name, over) => {
    const d = decide(inputs(over));
    expect(d.reason.length).toBeGreaterThan(0);
    // The grammar itself: a greppable case name, a colon, then prose.
    expect(d.reason).toMatch(/^[a-z-]+: \S/);
  });

  it.each(everyBranch)("%s carries the full input record", (_name, over) => {
    const given = inputs(over);
    const d = decide(given);
    expect(d.inputs).toMatchObject({
      repo: given.repo,
      issueNumber: given.issueNumber,
      route: given.route,
      senderIsBot: given.senderIsBot,
      autonomyEnabled: given.autonomyEnabled,
      alreadyBuilt: given.alreadyBuilt,
      runInFlight: given.runInFlight,
      holdLabel: given.holdLabel,
    });
    expect(d.inputs.labels).toEqual([...given.labels]);
  });

  it("copies the labels rather than aliasing the caller's array", () => {
    // The record is what the panel renders long after the decision; it must not
    // be a live view of something the caller may still mutate.
    const given = inputs();
    const d = decide(given);
    expect(d.inputs.labels).not.toBe(given.labels);
  });
});

/**
 * `issueTriggerId` — the idempotency key itself.
 *
 * `alreadyBuilt` is a lookup on this exact string. A single character of drift
 * from what `workflow_runs.triggerId` stores means the key silently never
 * matches, and the label loop this gate exists to stop runs forever. So the
 * format is pinned literally, not derived.
 */
describe("issueTriggerId", () => {
  it("produces exactly owner/repo#N", () => {
    expect(issueTriggerId("cliftonc/lastlight", 190)).toBe("cliftonc/lastlight#190");
  });

  it("matches what the decision puts in its own reason", () => {
    const d = decide(inputs({ repo: "nearform/lastlight", issueNumber: 7, runInFlight: true }));
    expect(d.reason).toContain("nearform/lastlight#7");
  });
});

/**
 * THE BUDGET CEILINGS.
 *
 * Three branches that share a shape — a reading, a configured limit, `>=` —
 * and differ in what the caller does about them. These cases pin the boundary
 * itself (at the limit refuses, one under it runs), the ordering among the
 * three, and the one property that is easy to lose in a refactor: that a
 * configured `0` means "refuse everything" rather than "unset".
 */
describe("resolveBuildTrigger — the budget ceilings", () => {
  it("refuses AT the concurrency ceiling, not one past it", () => {
    // `>=`: two allowed means two is the limit, not the last one that fits.
    const at = decide(inputs({ concurrentAutonomousBuilds: 2 }));
    expect(at.decision).toBe("skip");
    expect(at.reason).toMatch(/^concurrency-exhausted:/);

    const under = decide(inputs({ concurrentAutonomousBuilds: 1 }));
    expect(under.decision).toBe("dispatch");
  });

  it("refuses AT the per-repo day quota, and names the reset", () => {
    const at = decide(inputs({ buildsForRepoToday: 3 }));
    expect(at.decision).toBe("skip");
    expect(at.reason).toMatch(/^repo-quota-exhausted:/);
    // The reason is rendered to a human; a ceiling with no reset time reads as
    // permanent.
    expect(at.reason).toContain("midnight UTC");

    expect(decide(inputs({ buildsForRepoToday: 2 })).decision).toBe("dispatch");
  });

  it("refuses at the HARNESS spend ceiling, scoped `harness`", () => {
    const d = decide(inputs({ spendTodayUsd: 25 }));
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^budget-exhausted:/);
    expect(d.budgetExhausted).toEqual({ scope: "harness", limitUsd: 25, spentUsd: 25 });
  });

  it("refuses at the PER-REPO spend ceiling, scoped `repo`", () => {
    // Harness spend is well under its own ceiling — only the repo's is blown.
    const d = decide(inputs({ spendTodayUsd: 12, repoSpendTodayUsd: 10 }));
    expect(d.decision).toBe("skip");
    expect(d.budgetExhausted).toEqual({ scope: "repo", limitUsd: 10, spentUsd: 10 });
    expect(d.reason).toContain("cliftonc/lastlight");
  });

  it("reports the HARNESS ceiling when both are blown", () => {
    // The broader fact, and the more useful one: a repo told it is over its own
    // limit would go and raise that limit to no effect.
    const d = decide(inputs({ spendTodayUsd: 40, repoSpendTodayUsd: 30 }));
    expect(d.budgetExhausted?.scope).toBe("harness");
  });

  it("dispatches with every reading just under every ceiling", () => {
    const d = decide(
      inputs({
        concurrentAutonomousBuilds: 1,
        buildsForRepoToday: 2,
        spendTodayUsd: 24.99,
        repoSpendTodayUsd: 9.99,
      }),
    );
    expect(d.decision).toBe("dispatch");
    expect(d.reason).toMatch(/^ready:/);
  });
});

/**
 * A CONFIGURED `0` MEANS "REFUSE EVERYTHING".
 *
 * The operator's way to stop the pipeline dead without un-configuring it. It is
 * only correct because the comparison is `>=` and because config load keeps a
 * `0` as a real setting rather than treating it as unset — two facts in
 * different files, which is exactly why this is pinned here as behaviour.
 */
describe("resolveBuildTrigger — a budget of 0 refuses everything", () => {
  const zero = { maxConcurrentBuilds: 0, maxBuildsPerRepoPerDay: 0, dailyUsd: 0, repoDailyUsd: 0 };

  it("refuses a completely idle harness when every ceiling is 0", () => {
    // Nothing running, nothing built, nothing spent — and still refused.
    const d = decide(inputs(), zero);
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^concurrency-exhausted:/);
  });

  it.each([
    ["maxConcurrentBuilds", { ...BUDGET, maxConcurrentBuilds: 0 }, /^concurrency-exhausted:/],
    ["maxBuildsPerRepoPerDay", { ...BUDGET, maxBuildsPerRepoPerDay: 0 }, /^repo-quota-exhausted:/],
    ["dailyUsd", { ...BUDGET, dailyUsd: 0 }, /^budget-exhausted:/],
    ["repoDailyUsd", { ...BUDGET, repoDailyUsd: 0 }, /^budget-exhausted:/],
  ])("a 0 on %s alone refuses an idle harness", (_name, budget, reason) => {
    const d = decide(inputs(), budget as typeof BUDGET);
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(reason);
  });
});

/**
 * PRECEDENCE, with budgets in the picture. Two rules:
 *
 * 1. Every CORRECTNESS gate outranks every budget — a build we must not run at
 *    all is never a budget question, and answering "out of budget" to a held
 *    issue would tell somebody to go and raise a limit that would change
 *    nothing.
 * 2. Among the budgets, cheapest-and-most-transient first, so the ceiling
 *    reported is the one that will clear soonest.
 */
describe("resolveBuildTrigger — budgets vs the correctness gates", () => {
  /** Every ceiling blown at once. */
  const broke: Partial<BuildTriggerInputs> = {
    concurrentAutonomousBuilds: 9,
    buildsForRepoToday: 9,
    spendTodayUsd: 999,
    repoSpendTodayUsd: 999,
  };

  it.each([
    ["on-hold", { labels: ["ready-for-agent", "lastlight-ignore"] }, /^on-hold:/],
    ["not-autonomous", { autonomyEnabled: false }, /^not-autonomous:/],
    ["already-built", { alreadyBuilt: true, senderIsBot: true }, /^already-built:/],
    ["run-in-flight", { runInFlight: true }, /^run-in-flight:/],
  ])("%s outranks every budget ceiling", (_name, over, reason) => {
    const d = decide(inputs({ ...broke, ...over }));
    expect(d.reason).toMatch(reason);
    // And the terminal consequence must not be attached to a skip that was not
    // about money.
    expect(d.budgetExhausted).toBeUndefined();
  });

  it("concurrency outranks the repo quota and the spend ceiling", () => {
    expect(decide(inputs(broke)).reason).toMatch(/^concurrency-exhausted:/);
  });

  it("the repo quota outranks the spend ceiling", () => {
    const d = decide(inputs({ ...broke, concurrentAutonomousBuilds: 0 }));
    expect(d.reason).toMatch(/^repo-quota-exhausted:/);
  });

  it("a human retry does NOT outrank a budget — the ceiling is the point", () => {
    // The `already-built` asymmetry lets a maintainer re-spend deliberately.
    // That is bounded by these ceilings and by nothing else, which is the whole
    // reason Phase 2 exists.
    const d = decide(inputs({ alreadyBuilt: true, senderIsBot: false, ...broke }));
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^concurrency-exhausted:/);
  });
});

/**
 * `budgetExhausted` is the typed key the gate's one terminal consequence hangs
 * off — a comment and a label. It must be set on that branch and NOWHERE else,
 * or an issue gets commented for running out of concurrency.
 */
describe("resolveBuildTrigger — budgetExhausted is set only on budget-exhausted", () => {
  it.each([
    ["on-hold", { labels: ["ready-for-agent", "lastlight-ignore"] }],
    ["not-autonomous", { autonomyEnabled: false }],
    ["already-built", { alreadyBuilt: true, senderIsBot: true }],
    ["run-in-flight", { runInFlight: true }],
    ["concurrency-exhausted", { concurrentAutonomousBuilds: 2 }],
    ["repo-quota-exhausted", { buildsForRepoToday: 3 }],
    ["retry", { alreadyBuilt: true, senderIsBot: false }],
    ["ready", {}],
  ])("%s carries no budgetExhausted", (_name, over) => {
    expect(decide(inputs(over)).budgetExhausted).toBeUndefined();
  });

  it("budget-exhausted carries the numbers the comment has to name", () => {
    const d = decide(inputs({ spendTodayUsd: 31.5 }));
    expect(d.budgetExhausted).toEqual({ scope: "harness", limitUsd: 25, spentUsd: 31.5 });
  });
});

/**
 * The budget CEILINGS travel on the input record alongside the readings. A
 * panel showing "3 builds today" cannot tell you whether that was refused
 * without the limit it was measured against.
 */
describe("resolveBuildTrigger — the budget on the record", () => {
  it("records the readings and the ceilings together", () => {
    const d = decide(inputs({ buildsForRepoToday: 3 }));
    expect(d.inputs).toMatchObject({
      concurrentAutonomousBuilds: 0,
      buildsForRepoToday: 3,
      spendTodayUsd: 0,
      repoSpendTodayUsd: 0,
      budget: BUDGET,
    });
  });

  it("copies the budget rather than aliasing the caller's object", () => {
    const budget = { ...BUDGET };
    const d = decide(inputs(), budget);
    expect(d.inputs.budget).not.toBe(budget);
  });
});
