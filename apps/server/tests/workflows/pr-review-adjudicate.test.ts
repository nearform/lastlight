import { describe, it, expect } from "vitest";
import { getWorkflow, loadPromptTemplate } from "#src/workflows/loader.js";
import { renderTemplate } from "lastlight-workflow-engine";
import type { TemplateContext } from "lastlight-workflow-engine";

/**
 * WP6c — `docs/plans/deterministic-pr-levers.md` §WP6.
 *
 * The conservation gate's own logic is unit-tested where it lives
 * (`packages/code-facts/tests/findings.test.ts`, against real files). What this
 * layer owns is the wiring, and three properties of it that nothing else
 * type-checks:
 *
 *  - **the sibling placement.** `adjudicate` hangs off `review` ALONGSIDE
 *    `post-review`, not in front of it. `trigger_rule` is per node and applies
 *    to every dep uniformly, so an `adjudicate` inside `post-review`'s dep set
 *    could not be `all_done` for one dep and `all_success` for the other — it
 *    would have had to relax the whole node, losing the invariant that a FAILED
 *    REVIEW MUST NOT POST. A worse bug than the one it fixes.
 *  - **the floor.** Reaching `max_iterations` without the `until_bash`
 *    condition is *not* a phase failure in this engine, so the gate alone
 *    cannot guarantee conservation — `reconcile` is what does, deterministically
 *    and with no model.
 *  - **the asymmetry, in the prompt.** The adjudicator may re-rank, re-tier and
 *    demote; it may delete only against a transcript. That is a MEASURED bound
 *    (two models scored against 2,145 labelled comments, neither beat keeping
 *    everything), and the prompt is the only place it is stated to the thing
 *    that has to honour it.
 */

const def = getWorkflow("pr-review");
const byName = new Map(def.phases.map((p) => [p.name, p]));
const adjudicate = byName.get("adjudicate");
const reconcile = byName.get("reconcile");
if (!adjudicate) throw new Error("pr-review.yaml has no `adjudicate` phase");
if (!reconcile) throw new Error("pr-review.yaml has no `reconcile` phase");

describe("adjudicate — the phase", () => {
  it("has its own model key, guarded so unset falls through to `models.review`", () => {
    // Lever f3. The adjudicator is a RANKING pass over an already-generated
    // set — a different task from survey discovery — so an overlay must be
    // able to move it without also moving `review`. The {{#if}} pair is
    // load-bearing: a bare `{{models.review-adjudicate}}` renders EMPTY when
    // the key is unset, and `resolveModelVariant` then falls back to the
    // DEFAULT model, not to `models.review`.
    expect(adjudicate!.model).toBe(
      "{{#if models.review-adjudicate}}{{models.review-adjudicate}}{{/if}}" +
        "{{#if !models.review-adjudicate}}{{models.review}}{{/if}}"
    );
    expect(adjudicate!.model).not.toBe("{{models.review-survey}}");
  });

  it("renders `models.review-adjudicate` when the key is set", () => {
    // Rendered from the REAL YAML, so an edit to the template breaks this.
    const rendered = renderTemplate(adjudicate!.model!, {
      models: {
        review: "anthropic/claude-haiku-4-5-20251001",
        "review-adjudicate": "anthropic/claude-sonnet-4-6",
      },
    } as unknown as TemplateContext);
    // Exactly — the phase executor treats any non-empty render as
    // authoritative, so stray whitespace would become part of the model id.
    expect(rendered).toBe("anthropic/claude-sonnet-4-6");
  });

  it("falls through to `models.review` when the key is unset", () => {
    const rendered = renderTemplate(adjudicate!.model!, {
      models: { review: "anthropic/claude-haiku-4-5-20251001" },
    } as unknown as TemplateContext);
    expect(rendered).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("reads with a FRESH context", () => {
    // Agents shown the reasoning that produced a false report fail to reject it
    // 96% of the time. The adjudicator reads records, quotes and transcripts.
    expect(adjudicate!.generic_loop?.fresh_context).toBe(true);
  });

  it("declares `on_soft_failure` INSIDE the loop, where the schema reads it", () => {
    // At phase level zod strips the key and the policy silently reverts to
    // `{ retries: 0, then: "fail" }` — one degenerate turn then hard-fails the
    // whole review, which records no `assessedHeadShaByWorkflow` and hands
    // `cron-review.yaml` something to re-dispatch every thirty minutes forever.
    // All six survey phases had it in the wrong place until it was measured.
    // `pr-review-probes.test.ts` asserts this for `falsify` and for every
    // `survey_*` phase — that selector does not reach `adjudicate`, so this is
    // its own assertion rather than a reuse.
    expect((adjudicate as Record<string, unknown>).on_soft_failure).toBeUndefined();
    expect(adjudicate!.generic_loop?.on_soft_failure).toEqual({ retries: 1, then: "complete" });
  });

  it("gates on the conservation check, with no unrendered template marker", () => {
    const gate = adjudicate!.generic_loop?.until_bash ?? "";
    // `validateShellCommand` rejects any command containing `{{` outright, so a
    // templated gate is a phase that cannot run at all.
    expect(gate).not.toContain("{{");
    expect(gate).not.toContain("}}");
    expect(gate).toContain("LASTLIGHT_FACTS_BIN");
    expect(gate).toContain("/opt/lastlight/bin/lastlight-facts");
    expect(gate).toContain("findings --dir .lastlight/pr-review");
    // Strict here. `--repair` belongs to `reconcile`; a self-repairing gate
    // would close on the first iteration and the model would never get the
    // second one.
    expect(gate).not.toContain("--repair");
  });

  it("rides the pipeline switch alone — it installs nothing and executes nothing", () => {
    expect(adjudicate!.skip_if).toBe("analysisEnabled != true");
  });
});

describe("adjudicate — the sibling placement, which is the load-bearing part", () => {
  it("hangs off `review` beside `post-review`, never in front of it", () => {
    expect(adjudicate!.depends_on).toEqual(["review"]);
    expect(byName.get("post-review")?.depends_on).toEqual(["review"]);
  });

  it("cannot stop a review being posted, however it fails", () => {
    // The whole point. `post-review` keeps the default `all_success` over
    // `review` only — so a failed, skipped or cut-short adjudicator is simply
    // not in the question `post-review` asks.
    const deps = byName.get("post-review")?.depends_on ?? [];
    expect(deps).not.toContain("adjudicate");
    expect(deps).not.toContain("reconcile");
    expect(byName.get("post-review")?.trigger_rule).toBeUndefined();
  });

  it("is declared BEFORE post-review, which is what orders them", () => {
    // The scheduler is sequential and takes `ready[0]` in declaration order.
    // Siblings have no edge between them, so declaration order is the ONLY
    // thing that runs the adjudicator before the post.
    const names = def.phases.map((p) => p.name);
    expect(names.indexOf("adjudicate")).toBeLessThan(names.indexOf("post-review"));
    expect(names.indexOf("reconcile")).toBeLessThan(names.indexOf("post-review"));
    expect(names.indexOf("adjudicate")).toBeLessThan(names.indexOf("reconcile"));
  });
});

describe("reconcile — §D12's floor", () => {
  it("is deterministic: a bash phase, no model, no prompt", () => {
    expect(reconcile!.type).toBe("bash");
    expect(reconcile!.model).toBeUndefined();
    expect(reconcile!.prompt).toBeUndefined();
  });

  it("runs even when the adjudicator failed or was cut short", () => {
    // `all_done`, because that is exactly when there is something to repair.
    expect(reconcile!.depends_on).toEqual(["adjudicate"]);
    expect(reconcile!.trigger_rule).toBe("all_done");
  });

  it("repairs rather than checks, and exits 0 on every path", () => {
    const cmd = reconcile!.command ?? "";
    expect(cmd).not.toContain("{{");
    expect(cmd).toContain("findings --dir .lastlight/pr-review --repair");
    // A phase that fails hard records no `assessedHeadShaByWorkflow` and is
    // re-dispatched every thirty minutes, forever.
    expect(cmd).toMatch(/exit 0/);
    expect(cmd).toMatch(/if ! ".*" findings/);
  });

  it("still skips entirely on a deployment that never opted in", () => {
    // `all_done` on a SKIPPED dep is satisfied, so without its own `skip_if`
    // this phase would run a sandbox command on every pr-review in production.
    expect(reconcile!.skip_if).toBe("analysisEnabled != true");
  });
});

describe("the adjudicate prompt carries the constraints that have money on them", () => {
  const raw = loadPromptTemplate("prompts/review-adjudicate.md");

  it("states the asymmetry: re-rank and demote freely, delete only on a transcript", () => {
    expect(raw).toMatch(/re-rank/i);
    expect(raw).toMatch(/delete a finding only when a probe transcript refutes it/i);
    expect(raw).toMatch(/Demotion is not suppression/i);
  });

  it("carries the MEASURED reason, not just the instruction", () => {
    // An instruction with no reason attached is one a model will trade away
    // under pressure. The AACR-Bench result is what makes this a bound.
    expect(raw).toMatch(/neither beat\s*\n?keeping everything|neither beat keeping everything/i);
    expect(raw).toMatch(/0\.825/);
    expect(raw).toMatch(/only shrinking/i);
  });

  it("says an `unprobed` hypothesis reaches the review", () => {
    // AC2, and the v2 regression: only a transcript-refuted claim is dropped.
    expect(raw).toMatch(/`unprobed` hypothesis reaches the review/i);
  });

  it("says an absent verdicts file licenses no deletion at all", () => {
    expect(raw).toMatch(/nothing may be dropped on\s*\n?this run at all|nothing may be dropped/i);
  });

  it("names the three tiers and which one costs recall", () => {
    for (const tier of ["inline", "body", "internal"]) expect(raw).toContain(`\`${tier}\``);
    expect(raw).toMatch(/only tier that costs recall/i);
  });

  it("asks for deduplication across families with the union of evidence", () => {
    expect(raw).toMatch(/Deduplicate across families/i);
    expect(raw).toMatch(/union/i);
  });

  it("states the conservation gate, and that `internal` is the answer to a thin claim", () => {
    expect(raw).toMatch(/must appear exactly once/i);
    expect(raw).toMatch(/Silence is not a disposition/i);
    // The id-list shorthand was PROMPTED once (2026-08-25) and reverted the
    // same day: with a bare-id filing available, the adjudicator bulk-filed
    // internal and stopped promoting — posted findings fell from 5-8 to 1-3
    // per case and micro-recall collapsed on the live band. The gate still
    // ACCEPTS `internal[]` (code support is harmless), but the prompt must
    // keep the full-row friction that makes the model look at each claim.
    expect(raw).toMatch(/write it down at `internal` tier/i);
    expect(raw).not.toMatch(/"internal": \[/);
  });

  it("tells it to quote the code rather than count the lines", () => {
    expect(raw).toContain("existingCode");
    expect(raw).toMatch(/do not count the lines/i);
  });

  it("names every file it reads and the one file it owns", () => {
    for (const f of [
      ".lastlight/pr-review/hypotheses/*.jsonl",
      ".lastlight/pr-review/probes/verdicts.jsonl",
      ".lastlight/pr-review/probes/*.txt",
      ".lastlight/pr-review/findings.json",
    ]) {
      expect(raw, f).toContain(f);
    }
    // The other seven prompts all say "do NOT write findings.json — a later
    // phase owns it". This is that phase; it has to claim the file explicitly
    // or the instruction is left dangling with no owner.
    expect(raw).toMatch(/You own this file now/i);
  });

  it("runs the conservation ledger — at the start, and again as the self-check", () => {
    // Backlog #9: nothing else pins the `--ledger` instruction, so a prompt
    // edit could silently drop the checklist the conservation gate is built on.
    const ledger = raw.match(/"\$FACTS" findings --dir \.lastlight\/pr-review --ledger/g);
    expect(ledger?.length).toBeGreaterThanOrEqual(2);
  });

  it("carries the three measured calibration rules", () => {
    // §2l (`b2e63961`): the 1641 canary's false positives went 7/5 → 0/1/3 on
    // exactly these lines. The headline precision claim of the pipeline rests
    // on them staying in the prompt.
    expect(raw).toMatch(/A VERIFICATION REPORT is always `internal`, whatever its\s+confidence/);
    expect(raw).toMatch(/A SPECULATIVE HAZARD is always `internal`, whatever its\s+confidence/);
    expect(raw).toMatch(/Confidence prices the defect, not your certainty/);
  });

  it("renders with no leftover template marker", () => {
    const rendered = renderTemplate(raw, {
      owner: "acme",
      repo: "widgets",
      prNumber: 190,
      headSha: "abcdef1",
      baseBranch: "main",
    } as unknown as TemplateContext);
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");
  });
});
