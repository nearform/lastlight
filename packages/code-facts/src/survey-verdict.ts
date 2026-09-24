/**
 * The survey's verdict, DERIVED from evidence rather than asked for.
 *
 * ── Why this is code and not prompt text ──────────────────────────────────
 *
 * A survey pass writes two fields that decide what happens to its row: whether
 * a probe runs against it (`needsProbe`), and where it sits in the only
 * ranking the poster applies (`severity`). Both were asked of the model as a
 * judgement, and both were measured unstable — identical inputs producing
 * different rankings run to run, and clean discharges over changed code
 * declining the one verification that could contradict them.
 *
 * Asking for a judgement makes the answer depend on the adjectives a prompt
 * happens to use, which is why rewriting the prose moved the numbers in both
 * directions without ever settling them. So the pass is asked instead for
 * FACTS it can be held to — was there a controlling line, does it bind where it
 * runs, does it run in time, what can it not tell apart, what reaches past it,
 * what goes wrong and what makes that happen — and the verdict is computed
 * here. Given identical evidence the verdict is now identical, which is a
 * property no prompt can offer.
 *
 * ── One vocabulary for every family ───────────────────────────────────────
 *
 * The six survey families ask different questions but share one shape: a
 * mechanism with two ends, and a line that either closes it or does not. A
 * comparison closes a value's boundary; a sanitiser closes a tainted path; an
 * invalidation closes a cache's lifetime; an assertion closes an untested line;
 * an implementation closes an acceptance criterion. The fields below are named
 * for that shape rather than for any one family, so a row means the same thing
 * whichever pass wrote it and the funnel stays comparable across them.
 *
 * Pure: no I/O, no logging, no family table. Every branch is a function of its
 * argument, which is what lets the rules be exercised directly.
 */

/** What a pass records about the mechanism it was asked to close. */
export interface SurveyEvidence {
  /** The symbol, path, behaviour or criterion this row is about. */
  subject?: unknown;
  /**
   * `path:line` of the line that CLOSES the mechanism, or `none`.
   *
   * "Closes" is per family: compares the value, sanitises the input,
   * invalidates the entry, asserts the behaviour, implements the criterion.
   * A line that merely MENTIONS the subject, or passes it onward, closes
   * nothing.
   */
  control_site?: unknown;
  /** That line, verbatim. Unquotable means there is no control. */
  control_text?: unknown;
  /**
   * Does the control sit where it can bind?
   *
   * `binding` — on the side that stays correct if the other side is hostile,
   * buggy or simply older. `advisory` — the side the other party controls, or
   * a check nothing consults: a caller-side guard, a test with no assertion,
   * a comment stating an invariant.
   */
  authority?: unknown;
  /** Does the control run before the thing it governs? */
  order_ok?: unknown;
  /** Two DIFFERENT situations the control treats identically, or `nothing`. */
  cannot_distinguish?: unknown;
  /** A concrete path reaching the governed operation without the control, or `none found`. */
  bypass?: unknown;
  /** Does this PR touch the subject, the control, or a site that uses either? */
  in_changed_hunk?: unknown;
  /** What goes wrong, and what it does then. `null` when nothing is wrong. */
  consequence?: unknown;
  /**
   * What makes {@link consequence} happen.
   *
   * `input` / `state` — something reachable at head: a request, a stored
   * value, a timing. `code_change` — it happens only once somebody edits the
   * source.
   */
  trigger?: unknown;
  /** Does the consequence cross a trust boundary, lose data, or break a caller? */
  crosses_boundary?: unknown;
  /** Something the supplier does NOT already hold without this defect. */
  capability_gained?: unknown;
}

/**
 * A `consequence` phrased as a conditional on somebody EDITING the source.
 *
 * "if `X` is changed, the duplicated copy goes stale" describes a maintenance
 * hazard, not a defect at head: nothing is wrong until an edit happens, and
 * whoever makes that edit already holds every capability the finding would
 * grant. That is the same bar {@link SurveyEvidence.capability_gained} applies
 * to identity, applied to time.
 *
 * The pass is told this, and a pass was measured writing exactly this phrasing
 * while still marking `trigger: "input"` — which derived a `Critical` out of a
 * navigation timeout. So it is NORMALISED here rather than asked for: the tell
 * is in the text the pass itself wrote, and reading it costs nothing.
 *
 * **The direction is deliberately one-way.** This can only ever move a trigger
 * TO `code_change`, i.e. only ever demote. It cannot promote anything, so a
 * false positive loses a `Critical` that was probably wrong anyway, while a
 * false negative leaves the pass's own answer standing. Anchored on the
 * edit verbs specifically, so "if a caller passes null" — a live input
 * condition — does not match.
 */
const EDIT_CONDITIONAL =
  /\bif\b[^.;]{0,120}?\b(?:is|are|was|were|ever|gets?|get)\s+(?:later\s+|ever\s+)?(?:changed|updated|modified|renamed|removed|edited|altered|replaced)\b/i;

export type Discharge = "QUOTE" | "PARTIAL" | "ABSENT";
export type Severity = "Critical" | "Important" | "Minor";

export interface SurveyVerdict {
  discharge: Discharge;
  needsProbe: boolean;
  severity: Severity;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Present and not an empty/null-ish placeholder. */
function stated(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const s = str(v);
  return s !== "" && s !== "null" && s !== "none" && s !== "n/a" && s !== "-";
}

/**
 * Is there any evidence to derive from?
 *
 * A row written by a prompt that never asked for evidence is not a violation
 * and must not be scored as one — the distinction between *we looked and it is
 * clean* and *we could not look* holds here as everywhere else.
 */
export function hasEvidence(e: SurveyEvidence | undefined | null): boolean {
  return !!e && typeof e === "object" && Object.keys(e).length > 0;
}

/**
 * Derive the verdict.
 *
 * Three rules, each with the reason it survives:
 *
 * **`discharge`** — a control that does not bind, does not run in time, or can
 * be walked around is a `PARTIAL`, however real the quoted line is. A line that
 * names a constraint is not a line that applies it, and that gap is where the
 * findings live.
 *
 * **`needsProbe`** — a probe is a short script that can CONTRADICT the row, so
 * it is worth asking for wherever something is left to settle. The last clause
 * is the load-bearing one: a CLEAN discharge over code the PR touched is a
 * reassurance, and a reassurance is the one kind of row nothing downstream can
 * reopen — a later phase can delete a risk that was recorded, never resurrect
 * one that was graded away. It is also the only trigger here that does not
 * depend on the pass already suspecting something, which matters because a
 * reassurance is by definition written by a pass that suspects nothing.
 * Absence of a control is deliberately NOT a trigger on its own: a subject that
 * nothing checks and that harms nothing is a note, and probing it spends a
 * sandbox on a question with no stake.
 *
 * **`severity`** — `trigger` is what keeps `Critical` honest. A consequence
 * reachable only through a future edit cannot be critical however bad it would
 * be, because whoever makes that edit already holds every capability it would
 * grant; that is the same bar as {@link SurveyEvidence.capability_gained},
 * applied to time instead of to identity.
 */
export function deriveVerdict(e: SurveyEvidence): SurveyVerdict {
  const site = str(e.control_site);
  const authority = str(e.authority);
  const order = typeof e.order_ok === "boolean" ? e.order_ok : str(e.order_ok);
  const cannot = str(e.cannot_distinguish);
  const bypass = str(e.bypass);
  // Read the pass's own words before its label: a consequence that only bites
  // after an edit is a `code_change` whatever the label says.
  const declaredTrigger = str(e.trigger);
  const trigger =
    typeof e.consequence === "string" && EDIT_CONDITIONAL.test(e.consequence)
      ? "code_change"
      : declaredTrigger;

  const discharge: Discharge =
    site === "" || site === "none"
      ? "ABSENT"
      : authority !== "binding" || order !== true || bypass !== "none found"
        ? "PARTIAL"
        : "QUOTE";

  const harmful = stated(e.consequence);

  const needsProbe =
    discharge === "ABSENT"
      ? harmful
      : harmful ||
        cannot !== "nothing" ||
        order === "unknown" ||
        authority === "unknown" ||
        (discharge === "QUOTE" && e.in_changed_hunk === true);

  const liveTrigger = trigger === "input" || trigger === "state";
  const severity: Severity = !harmful
    ? "Minor"
    : e.crosses_boundary === true && stated(e.capability_gained) && liveTrigger
      ? "Critical"
      : "Important";

  return { discharge, needsProbe, severity };
}

/**
 * The severity a consumer should read, derived where possible.
 *
 * Every call site that used to read `row.severity` goes through here, so
 * "derived wins, declared is the fallback" is decided once rather than five
 * times. A row from a prompt that predates the evidence record still resolves
 * to what it wrote, so nothing regresses on the way in.
 */
export function severityOf(row: { severity?: unknown; evidence?: unknown }): string | null {
  const e = row.evidence as SurveyEvidence | undefined;
  if (hasEvidence(e)) return deriveVerdict(e as SurveyEvidence).severity;
  return typeof row.severity === "string" && row.severity.trim() !== "" ? row.severity : null;
}

/** {@link severityOf}'s counterpart for the probe flag. */
/**
 * WHY a row asks for a probe — the same branches as {@link deriveVerdict},
 * named, for display and for measurement. Nothing in the pipeline reads it; it
 * lives here, beside the rule, so the eval never keeps a second copy.
 *
 *   `verify`  the pass QUOTED a binding control and found nothing it cannot
 *             tell apart — a clean discharge, probed only because it sits over
 *             a changed hunk (the reassurance-verification clause). A
 *             consequence written on such a row is hypothetical ("if the
 *             constant changed…"): the pass has said the mechanism holds.
 *   `risk`    a consequence is stated and the control is not clean.
 *   `gap`     there is something the control cannot tell apart.
 *   `unknown` order or authority could not be established.
 */
export type ProbeReason = "verify" | "risk" | "gap" | "unknown";

/** A clean discharge: a binding, correctly-ordered, unbypassed control that the
 * pass says separates every case it was asked about. Structural — read off the
 * evidence, never off the claim's wording. */
export function isReassurance(e: SurveyEvidence): boolean {
  return deriveVerdict(e).discharge === "QUOTE" && str(e.cannot_distinguish) === "nothing";
}

export function probeReasonOf(e: SurveyEvidence): ProbeReason | null {
  const v = deriveVerdict(e);
  if (!v.needsProbe) return null;
  if (isReassurance(e)) return "verify";
  if (stated(e.consequence)) return "risk";
  if (str(e.cannot_distinguish) !== "nothing") return "gap";
  return "unknown";
}

export function needsProbeOf(row: { needsProbe?: unknown; evidence?: unknown }): boolean {
  const e = row.evidence as SurveyEvidence | undefined;
  if (hasEvidence(e)) return deriveVerdict(e as SurveyEvidence).needsProbe;
  return row.needsProbe === true;
}
