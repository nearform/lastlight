/**
 * The two fix-family marker grammars, parsed.
 *
 * `skills/fixing/SKILL.md` asks the agent to end the `diagnose` and `fix`
 * phases with exactly one machine-readable line:
 *
 * ```
 * DIAGNOSIS_COMPLETE: pr=<N> attempt=<K> class=<…> cause=<one line> ci_vs_local=<one line> unreproducible=<a,b>
 * CI_FIX_COMPLETE:    pr=<N> attempt=<K> outcome=<pushed|no-change|gave-up> tried=<one line> gate=<green|red|skipped>
 * ```
 *
 * Those lines are the ONLY thing that survives a run boundary:
 * `{{phaseOutputs}}` is empty across runs and the per-PR workspace is
 * `reset --hard`-ed between them, so cross-attempt memory has to be small and
 * persisted (04-retry.md §4.2). One parsed line per attempt is replayed into
 * every later attempt's prompt, and the `class=` token decides whether an
 * attempt was spent at all (09-state-machine.md §S1).
 *
 * Three properties this module is written for, in priority order:
 *
 * 1. **It can never throw.** A malformed marker is agent output, which is to
 *    say untrusted text produced under time pressure by a language model. It
 *    must degrade to "we learned nothing from this run", never to a crashed
 *    harvest that fails the run that produced it.
 * 2. **Values are free text, not tokens.** `cause=` is a sentence and may
 *    contain `=` and spaces, so the fields are split on the NEXT KNOWN KEY
 *    rather than on whitespace. Naive whitespace splitting truncates every
 *    cause to its first word.
 * 3. **An unrecognised enum value is `null`, never coerced.** `class=probably-flaky`
 *    must not silently become `flaky` and defer the PR forever; it is an
 *    unknown class, which the deferral counter treats as "not flaky".
 *
 * Pure: no I/O, no clock, no DB. `./fix-harvest.ts` is the impure half.
 */

/** The five diagnosis classes (09 → S1, `skills/fixing/SKILL.md`). */
export const DIAGNOSIS_CLASSES = [
  "reproducible",
  "env-mismatch",
  "flaky",
  "infra-dependent",
  "upstream-broken",
] as const;

export type DiagnosisClass = (typeof DIAGNOSIS_CLASSES)[number];

/**
 * The two classes that cost NO attempt, per 09-state-machine.md §S1's class
 * table.
 *
 * - `flaky` — by its own definition there is nothing to fix, so it never
 *   reaches the `fix` phase. It is bounded by `fix.maxFlakyDeferrals` instead,
 *   and that cap only exists BECAUSE it does not spend an attempt; if it did,
 *   `maxAttempts` would already bound it and the counter would be dead code.
 * - `upstream-broken` — not this PR's fault. It self-heals the moment the base
 *   goes green, and charging the PR for its base branch being red would leave
 *   it with no attempts left at the moment it becomes fixable.
 *
 * `infra-dependent` is deliberately NOT here: it costs an attempt and escalates
 * immediately, which is the whole point of not spending the other two on it.
 */
export const ATTEMPT_FREE_CLASSES: ReadonlySet<DiagnosisClass> = new Set<DiagnosisClass>([
  "flaky",
  "upstream-broken",
]);

/** What the `fix` phase did with the diagnosis. */
export const FIX_OUTCOMES = ["pushed", "no-change", "gave-up"] as const;

export type FixOutcome = (typeof FIX_OUTCOMES)[number];

/**
 * The local gate's verdict. `skipped` means no gate ran — which 09 → S1 is
 * explicit never authorises a push, so it is a distinct value rather than
 * being folded into `red`.
 */
export const GATE_RESULTS = ["green", "red", "skipped"] as const;

export type GateResult = (typeof GATE_RESULTS)[number];

/** A parsed `DIAGNOSIS_COMPLETE` line. Every field degrades independently. */
export interface DiagnosisMarker {
  /** PR number the agent believed it was working on, or null when unparseable. */
  pr: number | null;
  /** Attempt number the agent was told it was on. Advisory — ours is authoritative. */
  attempt: number | null;
  /** One of {@link DIAGNOSIS_CLASSES}, or null when absent OR unrecognised. */
  class: DiagnosisClass | null;
  /** The raw `class=` token as written, so an unknown value stays inspectable. */
  rawClass: string | null;
  /** Why CI failed. Free text, clamped. */
  cause: string;
  /** What differs between CI and the sandbox. Free text, clamped. */
  ciVsLocal: string;
  /** Check names the agent could not reproduce here. */
  unreproducible: string[];
}

/** A parsed `CI_FIX_COMPLETE` line. */
export interface FixOutcomeMarker {
  pr: number | null;
  attempt: number | null;
  /** One of {@link FIX_OUTCOMES}, or null when absent OR unrecognised. */
  outcome: FixOutcome | null;
  rawOutcome: string | null;
  /** What the agent tried. Free text, clamped. */
  tried: string;
  /** One of {@link GATE_RESULTS}, or null when absent OR unrecognised. */
  gate: GateResult | null;
  rawGate: string | null;
}

/** The pair of markers one attempt can produce. */
export interface AttemptMarkers {
  diagnosis?: DiagnosisMarker | null;
  fix?: FixOutcomeMarker | null;
}

export const DIAGNOSIS_MARKER = "DIAGNOSIS_COMPLETE";
export const CI_FIX_MARKER = "CI_FIX_COMPLETE";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------
//
// Every bound here exists because the rendered line is replayed into EVERY
// later attempt's prompt. 09 → S1 is explicit that this memory "must not
// grow": an agent that writes a three-paragraph `cause=` would otherwise buy
// itself a larger prompt on attempt 2 and a larger one still on attempt 3.

/** Longest free-text field value kept from a marker. */
const MAX_FIELD_CHARS = 160;
/** Longest whole rendered attempt line. */
export const MAX_ATTEMPT_LINE_CHARS = 200;
/** Longest `cause=` clause inside a rendered attempt line. */
const MAX_RENDERED_CAUSE_CHARS = 110;
/** How many `unreproducible=` check names are kept. */
const MAX_UNREPRODUCIBLE = 6;
/** How many rendered attempt lines {@link boundAttemptLines} keeps. */
export const MAX_PRIOR_ATTEMPT_LINES = 6;

/** Clamp free text to `max` characters, marking the truncation. */
function clamp(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The LAST line of `output` that carries `<tag>:`, with everything up to and
 * including the tag stripped.
 *
 * The skill says the marker is the last line, and this deliberately does not
 * insist on it. Two real shapes break a strict last-line read: an agent that
 * fences the marker in backticks or prefixes it with a bullet, and a
 * `generic_loop` iteration whose `{{previousOutput}}` replays the PREVIOUS
 * iteration's marker earlier in the same text. Scanning backwards and taking
 * the last hit handles both — the genuine final marker always wins.
 */
export function lastMarkerLine(output: string, tag: string): string | null {
  if (typeof output !== "string" || !output) return null;
  const needle = `${tag}:`;
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(needle);
    if (idx < 0) continue;
    // Strip a trailing code fence / emphasis run so a fenced marker parses.
    return lines[i].slice(idx + needle.length).replace(/[`*_\s]+$/, "").trim();
  }
  return null;
}

/**
 * Split a marker body into `key → value`, where each value runs to the start
 * of the NEXT KNOWN KEY rather than to the next space.
 *
 * This is the whole reason the parser is not two lines of `split(" ")`:
 * `cause=the lockfile is stale vs package.json` is one value containing three
 * spaces, and `ci_vs_local=CI runs node 22, sandbox node 20` contains a comma
 * and a digit. Only a key from `keys`, at a word boundary, ends a value.
 *
 * First occurrence wins — a key repeated later in the line (an agent echoing
 * itself) cannot overwrite the first, well-formed one.
 */
function parseFields(body: string, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  // `(?:^|\s)` anchors the key to a token start, so `expr=` does not match
  // `pr=` and a `cause=` value mentioning `foo_class=bar` does not end it.
  const re = new RegExp(`(?:^|\\s)(${keys.join("|")})=`, "g");
  const hits: Array<{ key: string; keyStart: number; valueStart: number }> = [];
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    // `m.index` points at the leading whitespace (or 0); the key itself starts
    // `m[0].length - m[1].length - 1` characters later.
    hits.push({
      key: m[1],
      keyStart: m.index + (m[0].length - m[1].length - 1),
      valueStart: m.index + m[0].length,
    });
  }
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].key in out) continue;
    const end = i + 1 < hits.length ? hits[i + 1].keyStart : body.length;
    out[hits[i].key] = clamp(body.slice(hits[i].valueStart, end), MAX_FIELD_CHARS);
  }
  return out;
}

/** A positive integer, or null. */
function parseCount(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\d+/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** `value` if it is one of `allowed`, else null — never coerced. */
function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  if (!value) return null;
  const token = value.trim().toLowerCase().split(/\s/)[0];
  return (allowed as readonly string[]).includes(token) ? (token as T) : null;
}

const DIAGNOSIS_KEYS = ["pr", "attempt", "class", "cause", "ci_vs_local", "unreproducible"] as const;
const FIX_KEYS = ["pr", "attempt", "outcome", "tried", "gate"] as const;

/**
 * Parse the last `DIAGNOSIS_COMPLETE` line out of a phase's full output.
 *
 * Returns null when there is no marker at all — which is a MEANINGFUL answer,
 * not an error: a run with no `DIAGNOSIS_COMPLETE` spent no attempt (09 → S1,
 * "a crashed run must not consume budget").
 */
export function parseDiagnosisMarker(output: string): DiagnosisMarker | null {
  try {
    const body = lastMarkerLine(output, DIAGNOSIS_MARKER);
    if (body === null) return null;
    const f = parseFields(body, DIAGNOSIS_KEYS);
    const rawClass = f.class ? f.class.trim().split(/\s/)[0] : null;
    return {
      pr: parseCount(f.pr),
      attempt: parseCount(f.attempt),
      class: parseEnum(f.class, DIAGNOSIS_CLASSES),
      rawClass: rawClass || null,
      cause: f.cause ?? "",
      ciVsLocal: f.ci_vs_local ?? "",
      unreproducible: parseList(f.unreproducible),
    };
  } catch {
    // Unreachable by construction, but the harvest runs inside a phase
    // callback: a throw here would surface as a failed phase on a run that
    // otherwise succeeded. Never worth it for a parse.
    return null;
  }
}

/** Parse the last `CI_FIX_COMPLETE` line out of a phase's full output. */
export function parseFixOutcomeMarker(output: string): FixOutcomeMarker | null {
  try {
    const body = lastMarkerLine(output, CI_FIX_MARKER);
    if (body === null) return null;
    const f = parseFields(body, FIX_KEYS);
    const rawOutcome = f.outcome ? f.outcome.trim().split(/\s/)[0] : null;
    const rawGate = f.gate ? f.gate.trim().split(/\s/)[0] : null;
    return {
      pr: parseCount(f.pr),
      attempt: parseCount(f.attempt),
      outcome: parseEnum(f.outcome, FIX_OUTCOMES),
      rawOutcome: rawOutcome || null,
      tried: f.tried ?? "",
      gate: parseEnum(f.gate, GATE_RESULTS),
      rawGate: rawGate || null,
    };
  } catch {
    return null;
  }
}

/** `a, b, c` → `["a","b","c"]`, with the `none` sentinel treated as empty. */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== "none");
  return items.slice(0, MAX_UNREPRODUCIBLE);
}

/** Parse both markers out of one phase output. Either half may be null. */
export function parseAttemptMarkers(output: string): AttemptMarkers {
  return {
    diagnosis: parseDiagnosisMarker(output),
    fix: parseFixOutcomeMarker(output),
  };
}

// ---------------------------------------------------------------------------
// Rendering — the one bounded line per attempt (04-retry.md §4.2)
// ---------------------------------------------------------------------------

/**
 * The single line attempt N leaves behind for attempts N+1, N+2, …
 *
 * ```
 * attempt 2: class=env-mismatch cause=CI runs node 22, sandbox node 20 | outcome=pushed gate=green
 * ```
 *
 * One line per attempt, not a transcript — attempt 3 needs to know what was
 * tried and what was ruled out, not to re-read two agent sessions. `tried=` is
 * deliberately NOT rendered: `cause=` plus `outcome=` already answer "what was
 * wrong and did the fix land", and the whole line is replayed into every later
 * prompt, so each extra clause is paid for on every subsequent attempt.
 *
 * Returns null when the attempt produced no marker at all — a crashed run
 * leaves no line, exactly as it consumes no attempt.
 */
export function renderAttemptLine(attempt: number, markers: AttemptMarkers | null): string | null {
  const diagnosis = markers?.diagnosis ?? null;
  const fix = markers?.fix ?? null;
  if (!diagnosis && !fix) return null;

  const parts: string[] = [];
  if (diagnosis) {
    // An unrecognised class renders as `unknown` rather than as the raw token:
    // the line is read by a language model on the next attempt, and echoing an
    // invented class back at it teaches it the invention.
    parts.push(`class=${diagnosis.class ?? "unknown"}`);
    if (diagnosis.cause) parts.push(`cause=${clamp(diagnosis.cause, MAX_RENDERED_CAUSE_CHARS)}`);
  }
  const tail: string[] = [];
  if (fix) {
    tail.push(`outcome=${fix.outcome ?? "unknown"}`);
    tail.push(`gate=${fix.gate ?? "unknown"}`);
  }

  const head = `attempt ${attempt}: ${parts.join(" ")}`.trimEnd();
  const line = tail.length > 0 ? `${head} | ${tail.join(" ")}` : head;
  return clamp(line, MAX_ATTEMPT_LINE_CHARS);
}

/**
 * Keep the journal bounded: at most {@link MAX_PRIOR_ATTEMPT_LINES} lines,
 * newest kept, oldest dropped, order preserved.
 *
 * A PR can accumulate more RUNS than `fix.maxAttempts` — a `flaky` deferral
 * spends no attempt, and the daily `fix-red-dependency-prs` cron re-picks the
 * PR up every day — so the array needs its own bound rather than inheriting
 * the attempt cap's.
 */
export function boundAttemptLines(lines: string[]): string[] {
  const clean = lines.filter((l): l is string => typeof l === "string" && l.length > 0);
  return clean.length <= MAX_PRIOR_ATTEMPT_LINES
    ? clean
    : clean.slice(clean.length - MAX_PRIOR_ATTEMPT_LINES);
}
