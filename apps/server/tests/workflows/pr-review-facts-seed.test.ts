import { describe, it, expect } from "vitest";
import { getWorkflow } from "#src/workflows/loader.js";

/**
 * The two deterministic phases at the head of the evidence pipeline, `facts`
 * and `seed` — WP3's AC4 of `docs/plans/deterministic-pr-levers.md` §WP3: what
 * was NOT analysed must reach the model rather than read as "no findings".
 *
 * The facts → obligations hop lives in `packages/code-facts` (unit-tested
 * there). What this layer owns is the shell around it: the `coverage: "none"`
 * envelope literal embedded in `pr-review.yaml`'s fallback, which nothing
 * type-checks, and the flags the phases pass.
 */

const def = getWorkflow("pr-review");
const byName = new Map(def.phases.map((p) => [p.name, p]));

// ── AC4 ──────────────────────────────────────────────────────────────────────

const FACTS_COMMAND = (() => {
  const command = byName.get("facts")?.command;
  if (!command) throw new Error("pr-review.yaml's `facts` phase has no command");
  return command;
})();

/**
 * The degraded envelope the `facts` phase writes when the analysis cannot be
 * run at all — extracted from the `printf` FORMAT string in its shell fallback,
 * with the `%s` placeholders filled so it can be parsed as the JSON it becomes.
 */
function factsFallbackEnvelope(): Record<string, unknown> {
  const open = FACTS_COMMAND.indexOf("printf '{");
  expect(open, "no `printf '{…}'` fallback envelope in the facts phase").toBeGreaterThan(-1);
  const rest = FACTS_COMMAND.slice(open + "printf '".length);
  // `printf` is handed a literal backslash-n; the JSON body is everything before it.
  const end = rest.indexOf("\\n'");
  expect(end, "the fallback envelope's printf format is unterminated").toBeGreaterThan(-1);
  const format = rest
    .slice(0, end)
    // Runtime substitutions: timestamp, base sha, head sha, the reason string.
    .replaceAll("%s", "SUBSTITUTED")
    // Template markers the phase renders before the shell ever sees them.
    .replaceAll("{{owner}}", "acme")
    .replaceAll("{{repo}}", "widgets");
  return JSON.parse(format) as Record<string, unknown>;
}

describe("AC4 — what was NOT analysed reaches the model", () => {
  it("writes a PARSEABLE `coverage: none` envelope when the analysis cannot run", () => {
    // The literal lives inside a YAML block scalar inside a shell single-quoted
    // printf format. Nothing type-checks it, and a JSON syntax error here would
    // write garbage the seeder then refuses to read — leaving no obligations
    // AND no block saying why, which is exactly the silence the envelope exists
    // to replace.
    const envelope = factsFallbackEnvelope();
    expect(envelope.version).toBe(2);
    expect(envelope.coverage).toBe("none");
    expect(envelope.extractor).toBe("all");

    const degraded = envelope.degraded as { extractor: string; reason: string }[];
    expect(Array.isArray(degraded)).toBe(true);
    expect(degraded).toHaveLength(1);
    expect(degraded[0].extractor).toBe("facts");
    // `extractors: {}` — looked at nothing, rather than an absent key. `null`
    // means nobody looked; `[]` means looked and found none.
    expect(envelope.extractors).toEqual({});
    expect(envelope.languages).toEqual([]);
  });

  it("gives every degraded exit a reason that forbids reading it as `no findings`", () => {
    // Two ways the phase can end up with nothing: no resolvable merge base, and
    // an analyser process that DIED. Both must say so in the words the
    // downstream phases then relay — a `coverage: none` envelope read as "clean" is the
    // precise bug this pipeline was built against.
    const reasons = [...FACTS_COMMAND.matchAll(/fallback "([^"]+)"/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    for (const reason of reasons) {
      expect(reason).toContain("NOTHING here may be read as 'no findings'");
    }
    expect(reasons.some((r) => r.includes("no merge base"))).toBe(true);
    expect(reasons.some((r) => r.includes("died without writing an envelope"))).toBe(true);
  });

  it("resolves the MERGE BASE, and degrades rather than falling back to a wrong range", () => {
    // Two-dot additionally contains every commit that landed on the base branch
    // since the PR forked. Analysing the wrong range and reporting success is
    // the shape this pipeline exists to stop.
    expect(FACTS_COMMAND).toContain("git merge-base origin/{{baseBranch}} HEAD");
    // …and nowhere in the EXECUTED shell (comments may name it as the thing not
    // to do) does the range silently degrade to a one-commit approximation.
    const code = FACTS_COMMAND.split("\n").filter((l) => !/^\s*#/.test(l));
    expect(code.join("\n")).not.toMatch(/HEAD~/);
    // A resolvable-but-empty merge base is caught too — `git merge-base` prints
    // nothing and exits 0 on some failure modes.
    expect(FACTS_COMMAND).toMatch(/\[ -z "\$BASE" \]/);
  });

  it("exits 0 on every degraded path, so cron-review cannot re-dispatch forever", () => {
    // §D12: fail loud means loud in the ARTIFACT, never fatal to the run. A
    // hard-failing phase is re-dispatched by cron-review.yaml every thirty
    // minutes for as long as the PR is open.
    expect(FACTS_COMMAND).toContain("--never-fail");
    // The shell-level catch, not the flag: `--never-fail` is an in-process
    // try/catch and cannot cover a process that DIES.
    expect(FACTS_COMMAND).toMatch(/if\s+!\s+"\$FACTS"/);
    expect(FACTS_COMMAND).toContain("exit 0");
    // `set -e` would turn any of these degraded paths back into a hard failure.
    expect(FACTS_COMMAND).not.toMatch(/^\s*set -e/m);
    expect(byName.get("seed")!.command).toContain("|| true");
  });

  /**
   * f1 — the diff is staged ONCE, by the phase that already owns the range.
   *
   * Measured on the (since removed) agent survey: its five branches made ~93
   * bash calls per case and ~30 of them re-derived this one fixed merge-base
   * range. The site investigators read the same staged diff. The correctness half matters more — every re-derivation is a
   * fresh chance to write two dots, and the same corpus that motivates the
   * `merge-base` assertion above says what that costs (6125 files against 3).
   *
   * Three strings, one location: the flag on the `facts` invocation, the
   * directory `code-facts` writes into, and the path the investigators are
   * pointed at. If they part company they look for a diff nobody staged and
   * quietly go back to `git diff`.
   */
  it("stages the diff once, in the phase that resolved the range", () => {
    expect(FACTS_COMMAND).toContain("--stage-diff");
    // On the SAME invocation as the range, not a second command with its own
    // idea of the base — that would be the two-dot bug with extra steps.
    expect(FACTS_COMMAND).toMatch(/"\$FACTS" all --repo \. --base "\$BASE" --head HEAD .*--stage-diff/);
    // Loud either way: a phase that staged nothing must say so, or "the layer
    // wrote no patches" and "the branches never looked" become one silence.
    expect(FACTS_COMMAND).toContain(".lastlight/pr-review/diff/index.md");
    expect(FACTS_COMMAND).toContain("NO staged diff");
  });

  /**
   * Backlog item #24, closed: `review.analysis.maxObligations` was DEAD config
   * on the workflow path.
   *
   * It is validated in `config.ts`, clamped by the repo layer and documented in
   * the spec — and the `seed` phase invoked `lastlight-facts seed` without
   * `--max-obligations`, so the CLI's own default (also 40) applied to every
   * run. The wrong value and the right one were the same number, which is why
   * nothing measured it.
   *
   * The key is now the TOTAL BACKSTOP over the seeder's per-family ceilings
   * (contract 12, enforcement 12, state 8, security 8, tests 8), and its
   * default is their sum — so it cannot bind unless an operator raises a
   * ceiling. The two defaults are *still* equal, deliberately, which is why
   * this test pins the number on both sides rather than trusting the accident.
   */
  it("passes the obligation BACKSTOP to the seeder, defaulted in the shell", () => {
    const seed = byName.get("seed")!.command!;
    // Read into a shell variable and defaulted there — never interpolated
    // straight into the arg list, because `renderTemplate` substitutes an
    // ABSENT key with the empty string and `--max-obligations --mint` would
    // then swallow the next flag. The same rule `CONTRACT` follows.
    expect(seed).toContain('MAX_OBLIGATIONS="{{maxObligations}}"');
    expect(seed).toContain('--max-obligations "${MAX_OBLIGATIONS:-48}"');
    expect(seed).not.toMatch(/--max-obligations\s+\{\{/);
    // The shell default matches `code-facts`' own DEFAULT_MAX_OBLIGATIONS — and
    // that number is the per-family ceilings' sum — so an unprojected key
    // reproduces today's behaviour rather than seeding zero or unbounding it.
    expect(seed).toContain("--contract \"${CONTRACT:-minimal}\"");
  });

  it("writes obligations.json only — the units read it, and nothing reads a block", () => {
    const seed = byName.get("seed")!.command!;
    expect(seed).toContain("--out .lastlight/pr-review/obligations.json");
    expect(seed).not.toContain("--blocks");
    // A missing document is a LOGGED fact, not a silence…
    expect(seed).toContain("obligations.json MISSING");
    // …and it still cannot fail the run: a hard-failing phase is re-dispatched
    // by cron-review.yaml every thirty minutes, forever (§D12).
    expect(seed).toContain("exit 0");
  });
});
