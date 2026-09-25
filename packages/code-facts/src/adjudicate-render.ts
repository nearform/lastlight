/**
 * The adjudication dossier — every record `adjudicate` needs, joined from code.
 *
 * **Emitted from code, not from a prompt template**, for the reason
 * `seed-render.ts` states at length: the instruction and the mechanism it
 * governs must not be separable. This is that lesson applied one phase later.
 *
 * ── What it replaces ───────────────────────────────────────────────────────
 *
 * Measured on `1587-r2` ([#399](https://github.com/nearform/lastlight/issues/399)):
 * `adjudicate` ran 35 assistant turns, **30 of them `bash`**, and exactly one
 * `write` — about a third of the case's cost and ten minutes of its wall clock.
 * Across the 8-case arm: **137 bash calls over 8 adjudications**, mean 17.
 * Every one of them was clerical:
 *
 *   - `cat` each `hypotheses/*.jsonl` in full — {@link readHypothesisSet} has
 *     already parsed those, with canonical ids assigned and collisions resolved;
 *   - `cat` each `probes/*.txt` and `probes/verdicts.jsonl` —
 *     {@link readProbeAnswers} has already resolved each verdict to its
 *     hypothesis and located its transcript on disk;
 *   - `lastlight-facts findings --ledger`, twice — {@link buildFindingsLedger}
 *     is that ledger;
 *   - dozens of `sed -n '<N>p'` re-reading source lines to check quotes it was
 *     handed — which is this module's {@link locateExcerpt}, done once, for
 *     every quote, deterministically.
 *
 * The precedent for the fix is in this same pipeline: `seed` renders its family
 * briefs from code and attaches them with `context_file`, because a prompt that
 * says "go and read X" measured 27 of 133 first-turn reads resolving against the
 * wrong root and hitting ENOENT. Hand the agent the artifact; do not ask it to
 * assemble one.
 *
 * ── What it deliberately does NOT carry ────────────────────────────────────
 *
 * `adjudicate` runs `fresh_context: true` on purpose: agents shown the reasoning
 * that produced a false report fail to reject it 96% of the time. A dossier that
 * pre-digested the earlier passes' arguments would hand back exactly what that
 * setting exists to withhold. So this carries **evidence and records** and
 * nothing else:
 *
 *   - a probe verdict's `reason` — the falsify pass arguing for its own verdict
 *     — is **omitted**. The verdict, the command and the transcript stay: those
 *     are what happened, and the transcript is checkable.
 *   - `confidence`, on a hypothesis or a finding, is **omitted**. It measured
 *     **AUROC 0.228** over 516 findings — a strong signal pointing the wrong
 *     way, because the claims the model is surest of are the ones where nothing
 *     is wrong. Re-presenting it at the moment of judgement is the one place it
 *     can still do damage.
 *
 * ── The ledger's objection, answered ───────────────────────────────────────
 *
 * `buildFindingsLedger` says in its own doc comment that it carries the fields
 * that let a claim be disposed of "and not the evidence, quotes or transcripts.
 * Those stay in the `.jsonl`, because the adjudicator has to read the record to
 * judge it and a ledger that inlined everything would be the six files again
 * with extra steps."
 *
 * That is right about the ledger and is not an argument against this. The
 * ledger is a **checklist** — it answers "what is still outstanding", is
 * re-read at the end of the phase, and inlining evidence into it would bloat
 * the thing whose job is to be scannable. The dossier is the **record set** —
 * read once, at the start, in place of thirty shell calls. Two artifacts, two
 * jobs; the ledger is embedded here as a section rather than duplicated.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildFindingsLedger, type FindingsLedger } from "./findings.js";
import { readHypothesisSet, type HypothesisRecord } from "./hypotheses.js";
import { readJevClassifyDocument, type JevResult } from "./jev-classify-io.js";
import { hypothesisSeverity } from "./finding-severity.js";
import { isReadOnlyCommand, probeStrength, readProbeAnswers, type ProbeAnswer, type ProbeStrength } from "./probes.js";
import { isBehaviouralClaim } from "./survey-verdict.js";

export interface DossierOptions {
  /** The `.lastlight/pr-review` directory. */
  dir: string;
  /** Repo root, for resolving quotes and transcripts. Defaults to the cwd. */
  repo?: string;
  /**
   * Cap on an inlined probe transcript, in characters. A transcript may be a
   * whole test-suite log; the cap keeps one runaway probe from crowding out the
   * other twenty records. Truncation is always ANNOUNCED with the path, so the
   * full text is one `cat` away when it matters — the one shell call this
   * design is happy to leave on the table.
   */
  transcriptChars?: number;
}

const DEFAULT_TRANSCRIPT_CHARS = 4_000;

/** How a quoted excerpt fared against the file it names. */
export type ExcerptLocation =
  | { kind: "resolved"; line: number }
  | { kind: "not-found" }
  | { kind: "no-file" }
  | { kind: "no-path" }
  | { kind: "no-excerpt" };

/**
 * Where a verbatim excerpt sits in the file it names, if it does at all.
 *
 * Deliberately **not** a copy of `review-poster.ts`'s anchor cascade. That
 * cascade decides whether a finding can hang an inline comment on the diff —
 * hunks, ±3 context lines, relocation, the lot — and a replica of it here would
 * drift silently, which is the trap `anchor-forensics.ts` exists to document.
 * This answers a strictly smaller question, the only one the adjudicator was
 * shelling out to answer: **is this quote actually in that file, and on which
 * line?**
 *
 * Matching normalises leading/trailing whitespace per line, exactly as
 * `needleOf`/`norm` do, so re-indentation does not read as a fabricated quote.
 * Internal whitespace stays significant, as it is there.
 *
 * Why it earns its place: 26 of 54 off-diff demotions in the archive had an
 * `existingCode` matching nothing in the file it named — 22 of them from one
 * case whose excerpts held prose rather than code. Today that surfaces as a
 * `log.warn` at posting time, long after the adjudicator could have done
 * anything about it. Here it is in front of the model at the moment it is
 * choosing what to anchor.
 */
export function locateExcerpt(repoRoot: string, path: string | null, excerpt: string | null): ExcerptLocation {
  if (!path) return { kind: "no-path" };
  if (!excerpt || !excerpt.trim()) return { kind: "no-excerpt" };
  const abs = resolve(repoRoot, path);
  if (!existsSync(abs)) return { kind: "no-file" };
  let haystack: string[];
  try {
    haystack = readFileSync(abs, "utf8").split("\n");
  } catch {
    return { kind: "no-file" };
  }
  const needle = excerpt.split("\n").map((l) => l.trim());
  // A trailing blank line on the excerpt is formatting, not content.
  while (needle.length > 1 && needle[needle.length - 1] === "") needle.pop();
  while (needle.length > 1 && needle[0] === "") needle.shift();
  if (!needle.length) return { kind: "no-excerpt" };
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j]!.trim() !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return { kind: "resolved", line: i + 1 };
  }
  return { kind: "not-found" };
}

/** One quote a hypothesis offered, and whether the tree agrees with it. */
export interface DossierQuote {
  path: string | null;
  /** The line the survey claimed. */
  claimedLine: number | null;
  text: string;
  located: ExcerptLocation;
}

/** One row of the dossier, before it is rendered. Exported for tests. */
export interface DossierEntry {
  record: HypothesisRecord;
  probe: ProbeAnswer | null;
  /**
   * What the probe actually counts for, read off the record (`probeStrength`)
   * rather than off the verdict's label — a `reproduced` that is only a grep
   * against a behavioural claim counts as `corroborated` (issue #405).
   */
  strength: ProbeStrength;
  /** The transcript's text, capped; `null` when there is none to show. */
  transcript: string | null;
  /** True when {@link transcript} was cut and the reader must be told. */
  transcriptTruncated: boolean;
  /** The file this hypothesis is about, resolved by {@link pathOfRow}. */
  path: string | null;
  /** Where `existingCode` sits in {@link path}, if anywhere. */
  excerpt: ExcerptLocation;
  quotes: DossierQuote[];
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The file a hypothesis is about.
 *
 * Read off `quotes[0].path` before the row's own `path`, because that is what
 * the surveys actually write: over the 267 hypotheses in the 8-case probes arm,
 * **229 carry `quotes[]` and only 61 carry a top-level `path`.** Keying on
 * `path` alone reported "no path on this hypothesis — nothing to verify
 * against" for three quarters of the corpus, which reads as a pipeline that
 * emits unanchored claims rather than as a reader looking in the wrong place.
 * `file` is the third spelling seen in the wild (5 rows).
 */
export function pathOfRow(row: Record<string, unknown>): string | null {
  const quotes = Array.isArray(row.quotes) ? row.quotes : [];
  for (const q of quotes) {
    const path = asString((q as Record<string, unknown>)?.path);
    if (path) return path;
  }
  return asString(row.path) ?? asString(row.file);
}

function fence(body: string, lang = ""): string[] {
  // A body containing ``` would close the fence early and silently swallow the
  // rest of the dossier into "code". Longer fences nest.
  const ticks = "`".repeat(Math.max(3, ...[...body.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
  return [`${ticks}${lang}`, body, ticks];
}

/** One dossier's worth of per-hypothesis rows, before rendering to Markdown. */
export interface DossierEntries {
  entries: DossierEntry[];
  families: string[];
  malformed: number;
}

/**
 * Read the excerpt's file once per (path, excerpt) pair.
 *
 * Exported so a consumer that wants the STRUCTURED rows — not the rendered
 * Markdown `renderAdjudicationDossier` produces — can read the exact same
 * evidence the real dossier does, rather than re-parsing `.jsonl` a second
 * time. The System-1-per-hypothesis probe (#399 idea 2) is the first such
 * consumer: it needs `DossierEntry.excerpt`/`quotes`/`probe`, keyed by
 * `record.id`, not a document meant for an LLM to read top to bottom.
 */
export function buildEntries(options: DossierOptions): DossierEntries {
  const repoRoot = options.repo ?? process.cwd();
  const cap = options.transcriptChars ?? DEFAULT_TRANSCRIPT_CHARS;
  const set = readHypothesisSet(options.dir);
  const { answers, malformed: badVerdicts } = readProbeAnswers({ dir: options.dir, repo: options.repo }, set);
  // Both JSONL readers, pooled. Counting only the verdicts would report a clean
  // document while a hypothesis line was silently unparseable — which is the
  // one shape this package refuses everywhere else.
  const malformed = set.malformed + badVerdicts;

  const entries = set.records.map((record): DossierEntry => {
    const probe = answers.get(record.id) ?? null;
    let transcript: string | null = null;
    let truncated = false;
    if (probe?.transcriptPath) {
      try {
        const text = readFileSync(probe.transcriptPath, "utf8");
        truncated = text.length > cap;
        transcript = truncated ? text.slice(0, cap) : text;
      } catch {
        // A transcript that `checkProbes` located and this cannot read is a
        // disk problem, not a pipeline one. Say nothing false: leave it null,
        // and the rendered row reports "not readable".
        transcript = null;
      }
    }
    const row = record.row as Record<string, unknown>;
    const path = pathOfRow(row);
    const quotes: DossierQuote[] = (Array.isArray(row.quotes) ? row.quotes : []).flatMap((raw) => {
      const q = raw as Record<string, unknown>;
      const text = asString(q?.text);
      if (!text) return [];
      const qPath = asString(q?.path) ?? path;
      return [{ path: qPath, claimedLine: asNumber(q?.line), text, located: locateExcerpt(repoRoot, qPath, text) }];
    });
    return {
      record,
      probe,
      strength: probeStrength(probe, row),
      transcript,
      transcriptTruncated: truncated,
      path,
      excerpt: locateExcerpt(repoRoot, path, asString(row.existingCode)),
      quotes,
    };
  });
  return { entries, families: set.families, malformed };
}

function renderExcerptStatus(loc: ExcerptLocation, path: string | null): string {
  switch (loc.kind) {
    case "resolved":
      return `quote VERIFIED — ${path}:${loc.line}`;
    case "not-found":
      return `quote NOT FOUND in ${path} — this excerpt matches nothing in the file it names, so a finding built on it cannot be anchored inline. Re-quote from the file or drop the claim.`;
    case "no-file":
      return `file NOT IN THE TREE — ${path}`;
    case "no-path":
      return "no path on this hypothesis — nothing to verify against";
    case "no-excerpt":
      return "no excerpt on this hypothesis — there is no quote to carry forward";
  }
}

/**
 * The fenced body for an anchor or quote. A `resolved` excerpt IS the
 * evidence and is shown in full. Anything else is already known unusable —
 * `locateExcerpt` said so on the status line above this — so the full wrong
 * text buys nothing beyond a preview: it cannot anchor an inline comment
 * either way, and re-reading it will not change that.
 *
 * Measured 2026-09-22 across the 8-case dossier arm: a `NOT FOUND` block
 * averaged **3x** a `VERIFIED` one's size (426 vs 146 bytes) and was **20.2%
 * of every byte in every dossier** — the single biggest lever found, bigger
 * than the static prompt template. A one-line preview keeps the "roughly what
 * this claim is about" context a fresh reader still benefits from without
 * paying for a guess that is already known wrong.
 */
function renderExcerptBody(loc: ExcerptLocation, text: string): string[] {
  if (loc.kind === "resolved") return fence(text);
  const lines = text.split("\n");
  const preview = (lines[0] ?? "").slice(0, 120);
  const truncated = (lines[0] ?? "").length > preview.length;
  const short =
    `${preview}${truncated ? "…" : ""}` +
    `\n[…${lines.length} line(s), ${text.length} char(s) total, not shown — this excerpt does not resolve against the tree]`;
  // The note has its own overhead. For a short single-line guess — the common
  // case, measured — trimming it would COST bytes, not save them; only take
  // the short form when it is actually shorter.
  return fence(short.length < text.length ? short : text);
}

/** The closest competing category to jev's own pick, for the one-number
 * calibration line — see the call site's comment for why not the whole
 * vector. */
function jevRunnerUp(probabilities: Record<string, number> | null, top: string | null): { category: string; probability: number } | null {
  if (!probabilities || !top) return null;
  let best: { category: string; probability: number } | null = null;
  for (const [category, probability] of Object.entries(probabilities)) {
    if (category === top) continue;
    if (!best || probability > best.probability) best = { category, probability };
  }
  return best;
}

/**
 * Is this hypothesis confidently boring — safe to compact its CORROBORATING
 * quotes down to a count, rather than fencing every one in full?
 *
 * Three independent signals must all point the same way before anything is
 * compacted: jev calls it `verification` (no defect) at high confidence, the
 * deterministic probe cross-check found no contradiction, and the falsify
 * pass's own EXECUTED probe (when one ran) didn't reproduce it either. The
 * ANCHOR quote is never touched by this — only the corroborating `quotes[]`
 * list, which is what carries the per-hypothesis cost that scales with
 * consumer-site count (up to 8–9 quotes seen on one hypothesis in the
 * measured arm). Nothing is deleted: the quotes still exist in
 * `hypotheses/*.jsonl` on disk, and the count + verified-count told here is
 * enough to ask for one by path:line if the reader disagrees with the read.
 */
function isConfidentlyBoring(jev: JevResult | null | undefined, probe: ProbeAnswer | null): boolean {
  if (!jev || jev.error || jev.category !== "verification") return false;
  if ((jev.confidence ?? 0) < 0.75) return false;
  if (jev.probeContradiction) return false;
  if (probe?.verdict === "reproduced") return false;
  return true;
}

/**
 * Where should the adjudicator's judgement land on this hypothesis FIRST —
 * a reading-order hint, not a disposition. #399's own idea 2 was "annotate,
 * never decide"; this is that same rule applied to STRUCTURE rather than to
 * content. The dossier used to hand over N hypotheses in file order with no
 * signal about which ones are worth the model's attention — exactly the
 * "adjudicate is the last and most expensive read" problem #399 opened with,
 * one level up from bash calls.
 *
 * - `flagged` — jev disagrees with an EXECUTED probe (the deterministic
 *   cross-check), or the probe itself reproduced something, or jev's own call
 *   is `defect`/`correctness-risk`. The candidates for inline/body.
 * - `boring` — {@link isConfidentlyBoring}: three independent signals agree
 *   there is nothing here. Corroborating quotes are compacted for these.
 * - `uncertain` — jev ran but neither of the above: a low-confidence or
 *   `maintainability`/`nit` call with nothing contradicting it either.
 * - `unclassified` — no jev annotation for this id (`legacy`/`dossier` mode,
 *   or a placeholder row jev never saw). Reads exactly as it always has.
 */
function triagePriority(entry: DossierEntry, jev: JevResult | null | undefined): "flagged" | "boring" | "uncertain" | "unclassified" {
  if (!jev || jev.error) return "unclassified";
  if (jev.probeContradiction) return "flagged";
  if (entry.probe?.verdict === "reproduced") return "flagged";
  if (jev.category === "defect" || jev.category === "correctness-risk") return "flagged";
  if (isConfidentlyBoring(jev, entry.probe)) return "boring";
  return "uncertain";
}

function renderEntry(entry: DossierEntry, jev?: JevResult | null): string[] {
  const { record, probe } = entry;
  const row = record.row;
  const out: string[] = [];
  // The POSTING severity, derived from the evidence record and what the probe
  // counts for (`finding-severity.ts`) — the value reconcile will stamp on any
  // finding built from this hypothesis, whatever the adjudicator writes.
  const severity = hypothesisSeverity(row, entry.strength) ?? "(no severity)";
  const obligation = record.obligation ?? record.declaredObligation ?? "(no obligation cited)";
  out.push(`### ${record.id} · ${obligation} · ${severity}`);
  out.push("");
  out.push(`**Claim.** ${asString(row.claim) ?? "(none written — the row carried no claim)"}`);

  // #399 idea 2 — advisory, not a decision. Measured 2026-09-22: 83.6%
  // agreement with Sonnet's own category call on this same evidence, weakest
  // on `defect`/`correctness-risk` (the ones that matter most). You may agree
  // or disagree; neither is confirmed or refuted by this line alone.
  //
  // ONE extra number, not the whole probability vector. A first version
  // fenced the full 5-entry distribution as JSON and measured a real cost —
  // +19% on the dossier of the first live run this shipped in (31,000 →
  // 36,897 bytes on one case) — for calibration signal a single runner-up
  // margin already carries: a 0.35-vs-0.30 call and a 0.91-vs-0.02 call still
  // must not render identically, but five raw numbers per hypothesis is more
  // than that question needs.
  if (jev) {
    out.push("");
    if (jev.error) {
      out.push(`**System-1 pre-read (advisory).** unavailable for this hypothesis: ${jev.error}`);
    } else {
      const runnerUp = jevRunnerUp(jev.probabilities, jev.category);
      const margin = runnerUp ? ` (next: ${runnerUp.category} ${runnerUp.probability.toFixed(2)})` : "";
      out.push(`**System-1 pre-read (advisory).** ${jev.category} (p=${jev.confidence?.toFixed(2) ?? "?"})${margin}`);
      // A DETERMINISTIC cross-check against the falsify pass's own EXECUTED
      // probe — computed once at classify time (`jev-classify.ts`), not a
      // second model call. See `JevResult.probeContradiction`'s doc.
      if (jev.probeContradiction) out.push("", `**⚠ CONTRADICTS THE PROBE.** ${jev.probeContradiction}`);
    }
  }

  const ends = row.bothEnds as { introducedAt?: unknown; enforcedAt?: unknown } | undefined;
  const introduced = asString(ends?.introducedAt);
  const enforced = asString(ends?.enforcedAt);
  out.push("");
  // LD3: an obligation names both ends of the mechanism or it is not emitted.
  // A hypothesis that lost an end on the way through is worth seeing as such.
  out.push(
    introduced && enforced
      ? `**Mechanism.** introduced \`${introduced}\` → enforced \`${enforced}\``
      : `**Mechanism.** INCOMPLETE — introduced ${introduced ? `\`${introduced}\`` : "(unnamed)"}, enforced ${enforced ? `\`${enforced}\`` : "(unnamed)"}`,
  );

  const path = entry.path;
  const excerpt = asString(row.existingCode);
  out.push("");
  out.push(`**Anchor.** ${renderExcerptStatus(entry.excerpt, path)}`);
  if (excerpt) out.push("", ...renderExcerptBody(entry.excerpt, excerpt));

  if (entry.quotes.length && isConfidentlyBoring(jev, probe)) {
    // Compacted, not omitted: the quotes still exist in `hypotheses/*.jsonl`
    // on disk, this hypothesis's disposition is still required, and nothing
    // here overrides that. Only the corroborating-quote LISTING — the part
    // that scales with consumer-site count, up to 8-9 seen on one hypothesis
    // in the measured arm — is collapsed to a count, because three
    // independent signals (jev, the probe cross-check, and the executed
    // probe itself) already agree there is nothing here worth the tokens.
    const verified = entry.quotes.filter((q) => q.located.kind === "resolved").length;
    out.push(
      "",
      `**Quotes.** ${entry.quotes.length} corroborating quote(s), ${verified} verified — not shown. ` +
        `System-1 read this as \`verification\` (p=${jev!.confidence?.toFixed(2)}) with no contradicting probe. ` +
        `Ask for a specific \`path:line\` if you want to check one.`,
    );
  } else {
    for (const q of entry.quotes) {
      out.push("");
      // The claimed line vs the found line is the `sed -n '<N>p'` the adjudicator
      // was running by hand, resolved once. A quote that is real but N lines off
      // is a usable anchor; the disagreement is worth stating rather than
      // silently correcting, because the survey's line number is also evidence.
      const drift =
        q.located.kind === "resolved" && q.claimedLine !== null && q.claimedLine !== q.located.line
          ? ` (the survey said :${q.claimedLine})`
          : "";
      out.push(`**Quote.** ${renderExcerptStatus(q.located, q.path)}${drift}`);
      out.push(...renderExcerptBody(q.located, q.text));
    }
  }

  out.push("");
  if (!probe) {
    out.push(`**Probe.** none — no verdict was written for this hypothesis.`);
  } else {
    const cmd = probe.command ? `\`${probe.command}\`` : "no command recorded";
    out.push(`**Probe.** \`${probe.verdict}\` · ${cmd}`);
    // Issue #405: what the verdict COUNTS for, said beside it. A read is weaker
    // evidence than an execution, and a label that overstates it is corrected
    // here rather than silently believed.
    if (probe.verdict === "corroborated" && entry.strength === "corroborated") {
      out.push("", "A READ (search, file view or facts query) that supports the claim — weaker than `reproduced`: it shows the code reads the way the claim says, not that the consequence happens.");
    } else if (probe.verdict === "reproduced" && entry.strength === "corroborated") {
      out.push("", "Labelled `reproduced`, but every command only READS code and this hypothesis claims a behaviour — it counts as `corroborated`, not as a reproduction.");
    } else if (
      probe.verdict === "reproduced" &&
      entry.strength === "executed" &&
      isReadOnlyCommand(probe.command ?? "") &&
      !isBehaviouralClaim(row)
    ) {
      out.push("", "A read against a STRUCTURAL claim — the kind of claim a search settles.");
    }
    if (probe.borrowedFrom) {
      out.push(
        "",
        `This transcript was written for \`${probe.borrowedFrom}\`. It counts for ${record.id} only if it shows ${record.id}'s own scenario — read it for that, not for ${probe.borrowedFrom}'s.`,
      );
    }
    if (probe.transcript && !probe.transcriptPath)
      out.push("", `Transcript \`${probe.transcript}\` is NOT ON DISK. A verdict with nothing to show for it is an argument, not evidence.`);
    else if (entry.transcript !== null) {
      out.push("", `Transcript \`${probe.transcript}\`:`);
      out.push(...fence(entry.transcript));
      if (entry.transcriptTruncated)
        out.push(`(truncated — the full transcript is at \`${probe.transcript}\`)`);
    } else if (probe.transcriptPath) {
      out.push("", `Transcript \`${probe.transcript}\` could not be read.`);
    }
  }
  return out;
}

/** The review phase's own findings, which `adjudicate` rewrites in full. */
function renderPriorFindings(dir: string, repoRoot: string): string[] {
  const path = join(dir, "findings.json");
  if (!existsSync(path)) {
    return [
      "## What the review pass wrote",
      "",
      "`findings.json` does not exist yet. You are writing it from nothing; every disposition below must still be accounted for.",
    ];
  }
  let doc: { findings?: unknown[] };
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as { findings?: unknown[] };
  } catch (err) {
    // Loud, not silent: an unreadable findings.json is exactly the state the
    // loose schema in `schema.ts` exists to avoid, and it changes what the
    // phase has to do.
    return [
      "## What the review pass wrote",
      "",
      `\`findings.json\` is present and NOT VALID JSON (${(err as Error).message}). You own this file; rewrite it in full.`,
    ];
  }
  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  const out = ["## What the review pass wrote", "", `${findings.length} finding(s) in \`findings.json\`. You own this file now and rewrite it in full.`];
  findings.forEach((raw, i) => {
    const f = raw as Record<string, unknown>;
    const path = asString(f.path);
    const loc = locateExcerpt(repoRoot, path, asString(f.existingCode));
    out.push("");
    out.push(`### review-${String(i + 1).padStart(3, "0")} · ${asString(f.severity) ?? "(no severity)"} · ${path ?? "(no path)"}`);
    out.push("");
    out.push(`**${asString(f.title) ?? "(untitled)"}**`);
    const body = asString(f.body);
    if (body) out.push("", body);
    out.push("", `**Anchor.** ${renderExcerptStatus(loc, path)}`);
    const hyps = Array.isArray(f.hypotheses) ? f.hypotheses.filter((h) => typeof h === "string") : [];
    out.push(`**Cites.** ${hyps.length ? hyps.join(", ") : "nothing — this finding has no provenance"}`);
  });
  return out;
}

function renderLedgerSection(ledger: FindingsLedger): string[] {
  const out = ["## Conservation — what must be accounted for", ""];
  if (ledger.documentError) out.push(`\`findings.json\` could not be read as a document: ${ledger.documentError}`, "");
  out.push(
    `${ledger.entries.length} hypothesis/hypotheses exist. ${ledger.entries.filter((e) => e.accounted).length} are accounted for; ` +
      `**${ledger.uncovered.length} are not.** Every id must end with exactly one disposition — a finding, or an entry in \`internal\`, or a \`dropped\` row backed by a probe transcript.`,
  );
  if (ledger.uncovered.length) {
    out.push("", "OUTSTANDING:");
    // Uncapped on purpose, exactly as `renderFindingsLedger` is: a checklist
    // that elided entries would reproduce the omission it exists to prevent.
    out.push(...fence(ledger.uncovered.map((e) => `${e.id}  ${e.title}`).join("\n")));
  }
  for (const d of ledger.duplicates) out.push(`- DUPLICATE ${d.hypothesis}: ${d.detail}`);
  for (const f of ledger.fabricated) out.push(`- FABRICATED ${f.hypothesis}: ${f.detail}`);
  for (const u of ledger.unbackedDrops) out.push(`- UNBACKED DROP ${u.hypothesis}: ${u.detail}`);
  return out;
}

/**
 * The whole dossier, as Markdown.
 *
 * Never empty and never quietly thin: a run with no hypotheses at all renders
 * an explicit block saying so, for the same reason `renderFamilyBlock` does —
 * an absent section and a clean one must not read alike.
 */
export function renderAdjudicationDossier(options: DossierOptions): string {
  const repoRoot = options.repo ?? process.cwd();
  const { entries, families, malformed } = buildEntries(options);
  const ledger = buildFindingsLedger({ dir: options.dir, repo: options.repo });
  // #399 idea 2. Absent (no file) under `legacy`/`dossier` — nothing below
  // changes for either. Present under `jev`: one advisory line per
  // hypothesis, keyed by id, never a decision.
  const jevDoc = readJevClassifyDocument(options.dir);
  const jevById = new Map((jevDoc?.results ?? []).map((r) => [r.id, r]));

  const lines: string[] = [
    "# Adjudication dossier",
    "",
    "Every record this pass needs, joined and verified by `lastlight-facts dossier`. It is generated from",
    "`.lastlight/pr-review/` — the hypotheses the surveys wrote, the probe verdicts and their transcripts, the",
    "conservation ledger, and the findings the review pass produced. **You do not need to `cat` any of those files.**",
    "",
    "Two things are deliberately absent, and their absence is not an oversight:",
    "",
    "- **the earlier passes' reasoning.** A probe's verdict, command and transcript are here; the argument the",
    "  falsify pass wrote for its own verdict is not. Judge the transcript, not the case someone made from it.",
    "- **`confidence`.** It was measured at AUROC 0.228 over 516 findings — inverted, because the claims the",
    "  pipeline is surest of are the ones where nothing is wrong. Do not reintroduce it.",
    "",
    "Quotes have already been checked against the tree. `quote VERIFIED` means the excerpt is in the file it names,",
    "at the line given; `quote NOT FOUND` means it is not, and no amount of re-reading the file will change that.",
    "You do not need to verify a quote this document has verified.",
    "",
    "The severity on each hypothesis heading is DERIVED from its evidence record and what its probe counts for, and",
    "it is the severity any finding built from it will carry — it is stamped after you finish, over whatever you write.",
    "Probe verdicts, strongest first: `reproduced` (the scenario was executed) · `corroborated` (a read — search, file",
    "view, facts query — that supports the claim without executing it) · `refuted` · `unprobed`.",
    "",
  ];

  if (jevDoc) {
    lines.push(
      jevDoc.error
        ? `A System-1 pre-read was requested but is unavailable for this run: ${jevDoc.error}. No hypothesis below carries one.`
        : "Some hypotheses below carry a **System-1 pre-read** — one line, `category (p=confidence)`, from an independent " +
            "cheap classifier over the same evidence. It is ADVISORY: measured 83.6% agreement with an adjudicator's own " +
            "category call on identical evidence, weakest on `defect`/`correctness-risk` — the categories that matter most. " +
            "You may agree or disagree; neither is confirmed or refuted by that line alone. Decide from the evidence, as always.",
      "",
    );
  }

  if (malformed) lines.push(`${malformed} line(s) in the pipeline's JSONL could not be parsed and are NOT represented below.`, "");

  lines.push(...renderLedgerSection(ledger), "");

  // A READING ORDER, not a disposition — every id still needs its own entry
  // below and this map may be wrong about any one of them. Without it the
  // dossier hands over N hypotheses in file order with no signal about which
  // ones are worth spending judgement on, which is the same "most expensive
  // read, least structured" shape #399 opened with, one level up.
  if (jevDoc && !jevDoc.error && entries.length) {
    const buckets: Record<"flagged" | "uncertain" | "boring", string[]> = { flagged: [], uncertain: [], boring: [] };
    for (const e of entries) {
      const bucket = triagePriority(e, jevById.get(e.record.id));
      if (bucket !== "unclassified") buckets[bucket].push(e.record.id);
    }
    if (buckets.flagged.length || buckets.uncertain.length || buckets.boring.length) {
      lines.push(
        "## Triage map — a reading order, not a disposition",
        "",
        `**${buckets.flagged.length} FLAGGED** — jev contradicts an executed probe, the probe itself reproduced something, or jev's own call is \`defect\`/\`correctness-risk\`. Read these first: ${buckets.flagged.join(", ") || "none"}`,
        "",
        `**${buckets.uncertain.length} UNCERTAIN** — jev ran but neither flagged nor confidently clean: ${buckets.uncertain.join(", ") || "none"}`,
        "",
        `**${buckets.boring.length} CONFIDENTLY BORING** — jev: \`verification\`, high confidence, nothing contradicts it. Their corroborating quotes are compacted below (counts only): ${buckets.boring.join(", ") || "none"}`,
        "",
        "This is a suggestion for where to spend attention, not an answer — every id above still gets its own full entry below, and you may disagree with any bucket.",
        "",
      );
    }
  }

  if (!entries.length) {
    lines.push(
      "## Hypotheses",
      "",
      "**NONE.** No survey pass wrote a hypothesis. That is not a clean bill of health — it is an absence of",
      "evidence, and the review pass's own findings below are the only input this adjudication has.",
      "",
    );
  } else {
    const probed = entries.filter((e) => e.probe).length;
    const unresolvedQuotes = entries.filter((e) => e.excerpt.kind === "not-found").length;
    lines.push(
      `## Hypotheses — ${entries.length} across ${families.length} family/families`,
      "",
      `${probed} carry a probe verdict. ${unresolvedQuotes} carry an excerpt that matches nothing in the file it names.`,
      "",
    );
    for (const family of families) {
      const inFamily = entries.filter((e) => e.record.family === family);
      if (!inFamily.length) continue;
      lines.push(`## ${family} — ${inFamily.length}`, "");
      for (const entry of inFamily) lines.push(...renderEntry(entry, jevById.get(entry.record.id)), "");
    }
  }

  lines.push(...renderPriorFindings(options.dir, repoRoot), "");
  return lines.join("\n");
}
