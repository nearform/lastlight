/**
 * Replay ONE survey branch against a preserved workspace, in seconds not hours.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A full `pr-review` eval case runs ~13 phases and took **23–47 minutes** per
 * case at `--concurrency 3` (2026-09-22 arms `191307` / `201815`), so the
 * feedback loop on a survey-prompt edit was a $30, hour-long, 8-case arm whose
 * run-to-run band is wider than most effects being tested: those two arms,
 * identical in every input, scored **12/25 and 8/25**, sharing only 6 gold.
 *
 * Almost none of that machinery is involved in the question that actually
 * moves: **does a survey branch, standing at a real defect, write the RISK or
 * the REASSURANCE?** The 2026-09-22 CONFIRM audit of `1587-r3` found the pass
 * reaching two gold and recording them as *"Dual-roster race condition
 * resolved"* and *"Nonce max-age enforced server-side"* — right lines, opposite
 * verdict. `review.analysis`'s discharge rule (`c4810269`) exists to convert
 * exactly those, and was then measured **inert**: `needsProbe` ran at 11.5% and
 * 12.7% across the two arms against a 15.6% baseline, i.e. the rule is read and
 * ignored.
 *
 * So this runs ONE branch, on the SAME workspace the real arm ran on, with the
 * same prompt + obligations + model, and reports the leading indicator. One
 * branch is ~1–3 minutes and a few cents.
 *
 * ── What it holds fixed, and what it does not ──────────────────────────────
 *
 * Fixed by replaying a preserved workspace: the checkout, the staged diff, the
 * seeded obligations (`obligations/<family>.md`) and their discharge contract.
 * Those are deterministic upstream artifacts — the plan records the seed as
 * byte-identical across runs — so replaying them removes the *upstream* half of
 * the variance and leaves the half under test.
 *
 * NOT fixed: the model's own sampling. Survey runs with extended thinking, so
 * temperature is pinned to 1 by the provider and cannot be lowered; `--repeats`
 * is therefore the only honest way to read a result here, exactly as at arm
 * level. Two repeats give a range, never an SD.
 *
 * **Skills are staged FRESH from core on every run** (never the frozen
 * `.lastlight-skills/` bundle inside the fixture), because iterating on
 * `skills/survey-pass/SKILL.md` is the point. `noSkills` is set so Pi's own
 * discovery is off: eval runs use `--sandbox none` on the host, and an operator's
 * personal `~/.agents/skills` catalogue otherwise reaches the agent and makes the
 * run unreproducible on another machine (an open item in the campaign notes).
 *
 * ── Reading the output ─────────────────────────────────────────────────────
 *
 * `needsProbe%` is the metric this was built for and the only deterministic
 * one. `reassurance-shaped` is a LEXICAL heuristic over the claim text — a
 * cheap tripwire, not a judge; it cannot tell a true "this is fine" from a
 * missed defect, and a prompt edit that merely teaches the model to avoid the
 * word "correctly" would move it while changing nothing. Read the dumped claims.
 *
 * The fixture's OWN hypotheses are reported beside the replay as `baseline`,
 * free: that is what the real arm produced from this identical input.
 *
 * Usage:
 *   npx tsx scripts/micro-survey.ts --fixture <dir> --family <f> [options]
 *
 *   --fixture <dir>    a preserved workspace (see `--keep-workspace`, copied out
 *                      of $TMPDIR — macOS purges /var/folders, and the campaign
 *                      already lost 216 of 237 preserved workspaces that way)
 *   --instances <p>    instances.json, for the PR fields the prompt renders
 *   --family <f>       contract | enforcement | security | state
 *   --model <m>        default: anthropic/claude-haiku-4-5-20251001
 *   --thinking <t>     pi thinking level (omit for the harness default)
 *   --repeats <n>      default 1; anything you intend to CONCLUDE from wants >1
 *   --label <s>        names the run in the JSON report
 *   --dry-run          render + resolve + price, spend nothing
 *
 * `spec` is deliberately unsupported: its obligations are built harness-side
 * from the PR description rather than seeded to `obligations/spec.md`, so there
 * is nothing on disk to replay and a silent empty block would read as a clean
 * family.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { type SurveyEvidence, deriveVerdict, hasEvidence, needsProbeOf, severityOf } from "lastlight-code-facts";
import { renderTemplate } from "lastlight-workflow-engine";

/** The four families whose obligations are seeded to disk by `lastlight-facts seed`.
 * `spec` is the fifth branch but its obligations are built HARNESS-side and
 * rendered straight into the prompt as `{{specObligations}}`, so there is no
 * `obligations/spec.md` to replay — see `--spec-from`. */
const FAMILIES = ["contract", "enforcement", "security", "state", "spec"] as const;
type Family = (typeof FAMILIES)[number];

/** Mirrors `BRANCH_CONTEXT_HEADING` in `apps/server/src/workflows/handlers/fanout.ts`.
 * Duplicated rather than imported because the evals barrel does not export it;
 * `assertHeadingInSync` below fails loudly if core ever changes it. */
const BRANCH_CONTEXT_HEADING = "## Attached: the file this pass was seeded with";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);

const dryRun = has("--dry-run");
const fixture = flag("--fixture");
const family = flag("--family") as Family | undefined;
const model = flag("--model") ?? "anthropic/claude-haiku-4-5-20251001";
const thinking = flag("--thinking");
const repeats = Number(flag("--repeats") ?? "1");
const label = flag("--label") ?? "micro";
const instancesPath = flag("--instances");
/** Mirrors `gate.timeoutSeconds` (config/default.yaml). Core always sets it; so must this. */
const gateTimeoutSeconds = Number(flag("--gate-timeout") ?? "900");
/** A preserved `NN-survey_branch_spec.jsonl`, to recover `{{specObligations}}`. */
const specFrom = flag("--spec-from");
/** Drop the workspace `AGENTS.md` — an ABLATION of the agent-context, not the default. */
const noAgentsMd = has("--no-agents-md");
/** Ambient skill discovery is OFF, which is what core now does on every backend
 * (`noSkills: true` — `apps/server/tests/sandbox/declared-skills-only.test.ts`).
 * A phase gets exactly the skills its YAML declares.
 *
 * `--ambient-skills` restores the PRE-FIX behaviour, and exists only to
 * reproduce an arm measured before it: every one of the 69 agent sessions in
 * arm `201815` recorded `"noSkills":false` and carried the operator's personal
 * `~/.agents/skills` catalogue, so any archived number was produced that way
 * and cannot be re-derived without it. */
const discoverSkills = has("--ambient-skills");
/** Run the branch with NO skill mapped at all — the ablation that asks whether a
 * separate skill file earns its keep, or whether the same words work better
 * inlined into the prompt. Pair it with `--prompt <p>` pointing at a prompt that
 * carries the shared half itself, or the branch loses those rules entirely. */
const noSkill = has("--no-skill");
/** Render a prompt from somewhere OTHER than core's `workflows/prompts/`, so a
 * candidate rewrite can be measured before it is committed. */
const promptOverride = flag("--prompt");

if (!fixture || !family) {
  console.error("usage: micro-survey.ts --fixture <dir> --family <contract|enforcement|security|state> [--instances p] [--model m] [--thinking t] [--repeats n] [--label s] [--dry-run]");
  process.exit(2);
}
if (!FAMILIES.includes(family)) {
  console.error(`--family must be one of ${FAMILIES.join(" | ")}`);
  process.exit(2);
}
if (family === "spec" && !specFrom) {
  console.error("--family spec needs --spec-from <NN-survey_branch_spec.jsonl>: its obligations are built harness-side\n" +
    "and rendered into the prompt, so they exist only inside a preserved transcript. Passing none would\n" +
    "render the prompt's `no obligations were attached` branch and measure a pass that never ran.");
  process.exit(2);
}

const coreRoot = resolve(process.env.LASTLIGHT_CORE_DIR ?? resolve(import.meta.dirname, "../../server"), ".");
const serverRoot = existsSync(join(coreRoot, "workflows")) ? coreRoot : join(coreRoot, "apps/server");

/** The fixture's checkout: `<fixture>/sandboxes/<taskId>/<repoName>`. */
function resolveCheckout(dir: string): { taskDir: string; repo: string; checkout: string } {
  const sandboxes = join(dir, "sandboxes");
  if (!existsSync(sandboxes)) throw new Error(`no sandboxes/ under ${dir} — is this a preserved workspace?`);
  const task = readdirSync(sandboxes)[0];
  const taskDir = join(sandboxes, task);
  const repo = readdirSync(taskDir).find((e) => existsSync(join(taskDir, e, ".git")));
  if (!repo) throw new Error(`no git checkout under ${taskDir}`);
  // The TASK dir, not the checkout: `AGENTS.md` (the composed agent-context) is
  // a SIBLING of the repo, and Pi auto-loads the first AGENTS.md walking UP from
  // cwd. Copying only the checkout silently drops the operational rules — the
  // agent then runs with no persona at all, which is not what the arm measured.
  return { taskDir, repo, checkout: join(taskDir, repo) };
}

/** Fail loudly if core renamed the heading this script duplicates. */
function assertHeadingInSync(): void {
  const p = join(serverRoot, "src/workflows/handlers/fanout.ts");
  if (!existsSync(p)) return;
  if (!readFileSync(p, "utf8").includes(BRANCH_CONTEXT_HEADING)) {
    throw new Error(`BRANCH_CONTEXT_HEADING drifted: ${p} no longer contains "${BRANCH_CONTEXT_HEADING}"`);
  }
}

interface Row { needsProbe?: boolean; claim?: string; severity?: string; id?: string; evidence?: SurveyEvidence }

/**
 * The derivation lives in `lastlight-code-facts` (`survey-verdict.ts`) and the
 * PIPELINE reads the same function.
 *
 * It used to be a second copy here, which is the bug class this whole
 * experiment is about: two authorities over one rule, free to disagree and
 * certain to. An eval that grades against its own private copy measures the
 * copy.
 */

function readRows(checkout: string, fam: Family): Row[] {
  const p = join(checkout, ".lastlight/pr-review/hypotheses", `${fam}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => { try { return [JSON.parse(l) as Row]; } catch { return []; } });
}

/** A LEXICAL tripwire, not a judge — see the header. Reassurance is a claim that
 * asserts the code is fine and asks for no probe. */
const REASSURANCE = /\b(correctly|properly|is enforced|are enforced|is validated|are validated|is handled|are handled|ensures|guarantees|no issue|as expected|is safe|is correct)\b/i;

/**
 * Severity counts, as the POSTER reads them.
 *
 * `unknown` mirrors the poster's own fallback: a missing or unrecognised
 * severity is read as `important` there (`rankOf`), so it does NOT drop out —
 * it lands mid-rank. Counting it separately is what makes that visible rather
 * than silently folded into the `Important` bucket.
 */
function severityCounts(rows: Row[]): Record<string, number> {
  const out: Record<string, number> = { critical: 0, important: 0, minor: 0, unknown: 0 };
  for (const r of rows) {
    const k = (severityOf(r) ?? "").trim().toLowerCase();
    if (k === "critical" || k === "important" || k === "minor") out[k]++;
    else out.unknown++;
  }
  return out;
}

/** Per-repeat compliance: of the rows that CARRY evidence, how many agree with
 * their own derivation? Reported as counts, never a bare rate — one repeat of
 * twelve rows is not a percentage worth trusting on its own. */
function complianceOf(rows: Row[]) {
  const withEvidence = rows.filter((r) => hasEvidence(r.evidence));
  let probeOk = 0, sevOk = 0, undeclared = 0;
  const violations: string[] = [];
  for (const r of withEvidence) {
    const want = deriveVerdict(r.evidence as SurveyEvidence);
    // Judged PER FIELD. A pass that declares neither is following the current
    // contract, not disagreeing with it — and one that declares only `needsProbe`
    // must not have its (correctly) absent `severity` graded as a mismatch.
    // Counting either as a violation measures the prompt we replaced.
    const declaredSev = typeof r.severity === "string" && r.severity.trim() !== "";
    const declaredProbe = typeof r.needsProbe === "boolean";
    if (!declaredSev && !declaredProbe) { undeclared++; continue; }
    const gotProbe = r.needsProbe === true;
    const gotSev = (r.severity ?? "").trim().toLowerCase();
    if (!declaredProbe || gotProbe === want.needsProbe) probeOk++;
    else violations.push(`${r.id ?? "?"} needsProbe=${gotProbe} want ${want.needsProbe} (${want.discharge}; site=${r.evidence?.control_site}; authority=${r.evidence?.authority}; cannot=${r.evidence?.cannot_distinguish})`);
    if (!declaredSev || gotSev === want.severity.toLowerCase()) sevOk++;
    else violations.push(`${r.id ?? "?"} severity=${r.severity ?? "(none)"} want ${want.severity} (consequence=${r.evidence?.consequence === null ? "null" : "set"}; trigger=${r.evidence?.trigger}; crosses=${r.evidence?.crosses_boundary})`);
  }
  const graded = withEvidence.length - undeclared;
  return { rows: rows.length, withEvidence: withEvidence.length, undeclared, graded, probeOk, sevOk, violations };
}

/**
 * Every metric here reads the DERIVED verdict, never what the row declared.
 *
 * The pass no longer writes `severity` or `needsProbe` — they are computed from
 * `evidence` (`lastlight-code-facts/survey-verdict.ts`), and the derived value
 * is what the pipeline acts on. Counting the declared field would now report
 * zero probes for a pass that is behaving exactly as instructed, which is a
 * property of the instrument rather than of the run.
 */
function summarise(rows: Row[]) {
  const needs = rows.filter((r) => needsProbeOf(r)).length;
  const reassurance = rows.filter((r) => !needsProbeOf(r) && REASSURANCE.test(r.claim ?? "")).length;
  return {
    rows: rows.length,
    needsProbe: needs,
    needsProbePct: rows.length ? (100 * needs) / rows.length : 0,
    reassuranceShaped: reassurance,
    severity: severityCounts(rows),
    compliance: complianceOf(rows),
  };
}

const { taskDir, repo: repoDirName, checkout } = resolveCheckout(fixture);
assertHeadingInSync();

const obligationsPath = join(checkout, ".lastlight/pr-review/obligations", `${family}.md`);
if (family !== "spec" && !existsSync(obligationsPath)) throw new Error(`no seeded obligations at ${obligationsPath}`);

// The prompt, rendered exactly as the fan-out renders it, then the obligations
// block appended under the same heading the harness uses.
const promptPath = promptOverride ? resolve(promptOverride) : join(serverRoot, "workflows/prompts", `survey-${family}.md`);
const instance = instancesPath
  ? (JSON.parse(readFileSync(instancesPath, "utf8")) as { instance_id: string; repo?: string; pr?: Record<string, unknown> }[])
      .find((i) => i.instance_id === basename(fixture))
  : undefined;
const pr = (instance?.pr ?? {}) as Record<string, string | number>;
const [owner, repoName] = (instance?.repo ?? "owner/repo").split("/");
const ctx = {
  owner,
  repo: repoName,
  prNumber: pr.number ?? 0,
  headSha: pr.head_commit ?? "HEAD",
  baseBranch: pr.base_ref ?? "main",
  prTitle: pr.title ?? "",
};
/**
 * Recover `{{specObligations}}` from a preserved branch transcript.
 *
 * The obligations for `spec` are built harness-side (`renderContext` →
 * `specObligations`) and rendered INTO the prompt, so unlike the other four
 * families there is no file on disk to replay. They are, however, sitting
 * verbatim inside the rendered prompt the branch was given — the first `user`
 * message of its session — so they can be sliced back out.
 *
 * The slice is anchored, not guessed: render the CURRENT template with a
 * sentinel in the placeholder, split on it, and take the recorded prompt
 * between the same two anchors. That means the surrounding prompt can still be
 * edited freely (which is the point — iterating on it is the experiment) while
 * the obligations stay byte-identical to the ones the arm actually discharged.
 * If either anchor fails to match, the template has moved too far from the
 * recorded run to splice safely and this REFUSES rather than silently
 * measuring a pass with no obligations.
 */
function recoverSpecObligations(template: string, transcriptPath: string): string {
  const SENTINEL = "__LL_SPEC_OBLIGATIONS__";
  const withSentinel = renderTemplate(template, { ...ctx, specObligations: SENTINEL } as never);
  const [pre, post] = withSentinel.split(SENTINEL);
  if (pre === undefined || post === undefined) throw new Error("the prompt template no longer renders {{specObligations}}");

  let recorded = "";
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: { type?: string; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "user") continue;
    const c = o.message?.content;
    recorded = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("") : "";
    break;
  }
  if (!recorded) throw new Error(`no first user message in ${transcriptPath}`);

  // Anchor on a generous tail/head of the static halves: enough to be unique,
  // short enough that an unrelated edit elsewhere in the prompt does not break it.
  const a = pre.trimEnd().slice(-160), b = post.trimStart().slice(0, 160);
  const i = recorded.indexOf(a), j = recorded.indexOf(b, i + a.length);
  if (i < 0 || j < 0) {
    throw new Error(
      "could not locate {{specObligations}} in the transcript — the template has diverged from the recorded run.\n" +
      "Splicing anyway would measure a different prompt than the one the arm ran.",
    );
  }
  return recorded.slice(i + a.length, j).trim();
}

if (family === "spec") {
  (ctx as Record<string, unknown>).specObligations = recoverSpecObligations(readFileSync(promptPath, "utf8"), specFrom!);
}
const rendered = renderTemplate(readFileSync(promptPath, "utf8"), ctx as never);
// `spec` carries its obligations INSIDE the rendered prompt; the other four get
// theirs appended under the heading the fan-out uses.
const prompt = family === "spec"
  ? rendered
  : [rendered, "", BRANCH_CONTEXT_HEADING, "", readFileSync(obligationsPath, "utf8")].join("\n");
if (/\{\{|\}\}/.test(rendered)) {
  console.warn("! unrendered {{marker}} left in the prompt — the template context is missing a key");
}

const baseline = summarise(readRows(checkout, family));

console.log(`fixture   ${fixture}`);
console.log(`checkout  ${checkout}`);
console.log(`family    ${family}   model ${model}${thinking ? `  thinking ${thinking}` : ""}   repeats ${repeats}`);
console.log(`prompt    ${promptPath} (${prompt.length} chars incl. obligations)${promptOverride ? "  [OVERRIDE]" : ""}`);
console.log(noSkill
  ? "skill     NONE — --no-skill ablation; the prompt must carry the shared half itself"
  : `skill     ${join(serverRoot, "skills/survey-pass/SKILL.md")} (staged fresh)`);
console.log(`context   AGENTS.md ${noAgentsMd ? "REMOVED (ablation)" : "present"}   ambient skill discovery ${discoverSkills ? "ON" : "off"}`);
console.log(`\nbaseline (what the preserved arm itself wrote for this family):`);
console.log(`  rows ${baseline.rows}  needsProbe ${baseline.needsProbe} (${baseline.needsProbePct.toFixed(1)}%)  reassurance-shaped ${baseline.reassuranceShaped}`);

if (dryRun) {
  console.log("\n--dry-run: resolved and rendered only, nothing spent.");
  process.exit(0);
}

const { run } = (await import("agentic-pi")) as { run: (o: Record<string, unknown>) => Promise<Record<string, never>> };

const results: ReturnType<typeof summarise>[] = [];
const claims: string[][] = [];

// The report is written after EVERY repeat, not once at the end, so a sweep is
// visible while it runs rather than appearing all at once ~25 minutes later.
// `live` + `heartbeat` mirror `scorecard.json`'s contract (`report.ts`): a live
// report whose heartbeat has gone stale was killed, which reads differently
// from one still working. The filename is fixed up front so every write lands
// on the same file.
const outDir = join(process.cwd(), "eval-results", "micro-survey");
mkdirSync(outDir, { recursive: true });
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}-${family}`;
const out = join(outDir, `${stamp}.json`);
/**
 * Every repeat's rows, kept.
 *
 * The scratch workspace is a `mkdtemp` that the next repeat overwrites and the
 * OS eventually purges, so until now the only trace of a run was the summary
 * plus a 110-char slice of each claim — which is enough to see THAT a pass
 * wrote a reassurance and never enough to see WHY. Grading a structured
 * prompt's derivation, re-reading a quote, or auditing a row against gold all
 * need the row itself. It is a few KB per repeat against a $0.25 repeat that
 * cannot be reproduced once the fixture ages out.
 */
const rowsDir = join(outDir, "rows", stamp);
mkdirSync(rowsDir, { recursive: true });

/**
 * `fireRate` is the headline for a bimodal metric. Measured on `enforcement`:
 * a run marks either ~5 rows `needsProbe` or none at all, almost nothing in
 * between — so a per-run PERCENTAGE is 3 Bernoulli trials wearing a continuous
 * disguise, and a mean over them is meaningless. The fraction of repeats in
 * which the family asked for ANY probe is the quantity that actually varies.
 */
const writeReport = (done: boolean) => {
  const fired = results.filter((r) => r.needsProbe > 0).length;
  writeFileSync(out, JSON.stringify({
    label, family, model, thinking, fixture,
    repeats, repeatsDone: results.length,
    live: !done,
    heartbeat: new Date().toISOString(),
    ambientSkills: discoverSkills,
    skill: !noSkill,
    promptPath,
    agentsMd: !noAgentsMd,
    baseline,
    fireRate: results.length ? fired / results.length : null,
    firedRepeats: fired,
    results, claims,
  }, null, 2));
};
writeReport(false);

// A repeat takes 2-5 MINUTES and `writeReport` only runs BETWEEN repeats, so a
// heartbeat refreshed per repeat goes stale mid-repeat and a perfectly healthy
// run reads as killed (the dashboard's staleness bar is 90 s — "silence is not
// progress", inverted). Tick it independently, as `run.ts` does for a live
// scorecard. `unref` so the timer never holds a finished script open.
const heartbeat = setInterval(() => writeReport(false), 15_000);
heartbeat.unref?.();
for (let i = 1; i <= repeats; i++) {
  // A scratch COPY per repeat: the branch writes into `.lastlight/pr-review/`
  // and the fixture must stay pristine for the next iteration.
  const scratch = mkdtempSync(join(tmpdir(), `micro-survey-${family}-`));
  const workspace = join(scratch, "ws");
  cpSync(taskDir, workspace, { recursive: true });
  const work = join(workspace, repoDirName);
  if (noAgentsMd) rmSync(join(workspace, "AGENTS.md"), { force: true });
  rmSync(join(work, ".lastlight/pr-review/hypotheses", `${family}.jsonl`), { force: true });

  const skillDir = join(scratch, "skills");
  if (!noSkill) {
    mkdirSync(skillDir, { recursive: true });
    cpSync(join(serverRoot, "skills/survey-pass"), join(skillDir, "survey-pass"), { recursive: true });
  }

  const started = Date.now();
  const r = (await run({
    model,
    prompt,
    cwd: work,
    ...(noSkill ? {} : { skillPaths: [join(skillDir, "survey-pass")] }),
    noSkills: !discoverSkills,
    sandbox: "none",
    // Core passes this on EVERY agent run, and agentic-pi arms its bash reaper
    // only when it is set (`gate-timeout.ts`: an absent timeout was "left
    // alone", which is how one probe ran unbounded for 7h29m). Not passing it
    // made this replay unfaithful in the one way that can cost hours.
    // Mirrors `gate.timeoutSeconds` in `config/default.yaml`.
    gateTimeoutSeconds,
    ...(thinking ? { thinking } : {}),
  })) as unknown as { ok?: boolean; stats?: { cost?: number; turns?: number; toolCalls?: number } };

  const rows = readRows(work, family);
  // Copy the raw file, not `JSON.stringify(rows)` — a row the parser dropped
  // (truncated line, pretty-printed JSON) is exactly the kind of failure this
  // needs to stay visible, and re-serialising would hide it.
  const rawRows = join(work, ".lastlight/pr-review/hypotheses", `${family}.jsonl`);
  if (existsSync(rawRows)) cpSync(rawRows, join(rowsDir, `repeat-${i}.jsonl`));
  const s = summarise(rows);
  results.push({ ...s, costUsd: r.stats?.cost ?? 0, durationSec: (Date.now() - started) / 1000, turns: r.stats?.turns ?? null, toolCalls: r.stats?.toolCalls ?? null } as never);
  // DERIVED, like every other number here. The pass no longer writes `severity`
  // or `needsProbe`, so reading the declared fields renders every row as
  // `. [?]` while the aggregate above correctly reports the derived rate — two
  // readings of different things, in one view, disagreeing.
  claims.push(rows.map((x) => `${needsProbeOf(x) ? "PROBE" : "  .  "} [${severityOf(x) ?? "?"}] ${(x.claim ?? "").slice(0, 110)}`));
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\nrepeat ${i}/${repeats}  ${secs}s  $${(r.stats?.cost ?? 0).toFixed(3)}  tools=${r.stats?.toolCalls ?? "?"}  ok=${r.ok !== false}`);
  console.log(`  rows ${s.rows}  needsProbe ${s.needsProbe} (${s.needsProbePct.toFixed(1)}%)  reassurance-shaped ${s.reassuranceShaped}`);
  console.log(`  severity  critical ${s.severity.critical}  important ${s.severity.important}  minor ${s.severity.minor}` + (s.severity.unknown ? `  unknown ${s.severity.unknown}` : ""));
  if (s.compliance.withEvidence > 0) {
    const c = s.compliance;
    if (c.withEvidence < c.rows) {
      console.log(`  derivation  ✗ ${c.rows - c.withEvidence}/${c.rows} rows carry NO evidence — those fall back to the pass's own guess`);
    }
    console.log(c.graded === 0
      ? `  derivation  evidence on ${c.withEvidence}/${c.rows} rows · verdict derived for all of them (the pass declared none, as asked)`
      : `  derivation  evidence on ${c.withEvidence}/${c.rows} rows · ${c.undeclared} left to the deriver · of ${c.graded} it still graded: needsProbe ${c.probeOk} agree · severity ${c.sevOk} agree`);
    for (const v of c.violations.slice(0, 6)) console.log(`    ✗ ${v}`);
    if (c.violations.length > 6) console.log(`    … ${c.violations.length - 6} more`);
  } else if (rows.length > 0) {
    // Loud, because this is the failure that hides. Every prompt asks for the
    // record now, so its absence means the pass ignored the contract and the
    // verdict fell back to whatever it felt like — measured once as ten of ten
    // rows `Critical` on a PR with nothing wrong, while every other number
    // looked ordinary.
    console.log(`  derivation  ✗✗ NO \`evidence\` ON ANY OF ${rows.length} ROWS — the pass ignored the record, so`);
    console.log("              severity/needsProbe fell back to its own guess. Treat this run as VOID.");
  }
  for (const c of claims[i - 1]) console.log(`    ${c}`);
  rmSync(scratch, { recursive: true, force: true });
  writeReport(false);
}
clearInterval(heartbeat);
writeReport(true);

const pct = results.map((r) => r.needsProbePct);
const fired = results.filter((r) => r.needsProbe > 0).length;
console.log(`\n== ${label} · ${family} · ${model}`);
console.log(`   baseline needsProbe ${baseline.needsProbePct.toFixed(1)}%   replay ${pct.map((p) => p.toFixed(1) + "%").join(" / ")}`);
console.log(`   FIRE RATE ${fired}/${results.length} repeats asked for at least one probe`);
for (const tier of ["critical", "important", "minor", "unknown"] as const) {
  const v = results.map((r) => (r as unknown as { severity: Record<string, number> }).severity[tier]);
  if (!v.some((n) => n > 0)) continue;
  const lo = Math.min(...v), hi = Math.max(...v);
  // Severity drives the posting rank on its own, so the SPREAD across identical
  // runs is the number that says whether the attention boundary is stable.
  console.log(`   severity ${tier.padEnd(9)} ${v.join(" / ")}${lo === hi ? "  (stable)" : `  (spread ${hi - lo})`}`);
}
if (results.length < 8) {
  console.log(`   (${results.length} repeats — this metric is BIMODAL, so treat it as ${results.length} coin flips; 8+ before ranking anything)`);
}
console.log(`   report → ${out}`);
