/**
 * `patterns` — the cheap scanners, and the tier that has to degrade honestly.
 *
 * Neither scanner is installable from npm: the `opengrep` npm name is a
 * 145-byte empty stub held by Aikido, and the `gitleaks` npm name is an
 * unrelated third-party package. Both are really release binaries. So this is
 * §D2's SECOND TIER — probed on `PATH`, and when absent the document carries
 * `coverage: "degraded"` with a populated `degraded[]` rather than an empty
 * finding list.
 *
 * That distinction is the whole point. On an eval arm without the binaries the
 * `security` family is measured with its `patterns` half missing, and
 * per-family attribution must label that **"not measured"**, never "did not
 * convert" (§D2). A document that said `findings: []` would make those two
 * indistinguishable.
 *
 * Two more rules, both deliberate:
 *
 *  - **Opengrep, not Semgrep** (locked decision 7), and never against the
 *    Semgrep registry — its rules moved to a licence that plausibly excludes a
 *    review product. The default ruleset is the small local one in `rules/`,
 *    overridable with `--rules`.
 *  - **Never `--config auto .` over the whole tree.** The scan is scoped to the
 *    changed files; over a whole repo the noise drowns the signal.
 *
 * These are EVIDENCE, NOT FINDINGS. They seed the survey and are never posted
 * directly — a static-analyser hit rewritten prettily by an LLM and posted is
 * the anti-pattern.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DegradedEntry, PatternsPayload, ScannerFinding } from "./schema.js";
import { packageRoot, resolveToolBin } from "./toolchain.js";
import { showFile } from "./git.js";

/** The ruleset shipped with this package. Local, ours, no registry fetch. */
export function defaultRulesPath(): string {
  return join(packageRoot(), "rules", "review.yaml");
}

/**
 * `sha1(tool + ":" + rule + ":" + file + ":" + 3-line-context)`, lowercase hex
 * — the recipe `skills/security-review/SKILL.md` §4 already defines. Reused
 * rather than reinvented, so a finding keeps one identity across both surfaces.
 */
export function fingerprint(tool: string, rule: string, file: string, context: string): string {
  return createHash("sha1").update(`${tool}:${rule}:${file}:${context}`).digest("hex");
}

/** The line and its two neighbours, as the fingerprint's context term. */
export function threeLineContext(source: string | null, line: number): string {
  if (!source) return "";
  const lines = source.split("\n");
  return lines
    .slice(Math.max(0, line - 2), line + 1)
    .join("\n")
    .trim();
}

const OPENGREP_SEVERITY: Record<string, ScannerFinding["severity"]> = {
  ERROR: "p1-high",
  WARNING: "p2-medium",
  INFO: "p3-low",
};

interface OpengrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  extra?: { message?: string; severity?: string };
}

interface OpengrepOutput {
  results?: OpengrepResult[];
  errors?: { message?: string; type?: string }[];
}

export function normaliseOpengrep(
  raw: string,
  contextFor: (file: string, line: number) => string,
): { findings: ScannerFinding[]; errors: string[] } {
  let parsed: OpengrepOutput;
  try {
    parsed = JSON.parse(raw) as OpengrepOutput;
  } catch {
    // A scanner whose output we cannot parse has told us NOTHING. Reporting
    // zero findings here is the dependency-cruiser failure mode exactly.
    return { findings: [], errors: ["opengrep produced output that is not JSON"] };
  }
  const findings: ScannerFinding[] = [];
  for (const result of parsed.results ?? []) {
    const file = result.path ?? "";
    const line = result.start?.line ?? 0;
    const rule = result.check_id ?? "unknown";
    findings.push({
      fingerprint: fingerprint("opengrep", rule, file, contextFor(file, line)),
      severity: OPENGREP_SEVERITY[(result.extra?.severity ?? "").toUpperCase()] ?? "p3-low",
      tool: "opengrep",
      rule,
      file,
      line,
      title: (result.extra?.message ?? rule).split("\n")[0].slice(0, 200),
    });
  }
  const errors = (parsed.errors ?? [])
    .map((error) => error.message ?? error.type ?? "unknown opengrep error")
    .filter(Boolean);
  return { findings, errors };
}

interface GitleaksResult {
  RuleID?: string;
  File?: string;
  StartLine?: number;
  Description?: string;
}

export function normaliseGitleaks(
  raw: string,
  contextFor: (file: string, line: number) => string,
): { findings: ScannerFinding[]; errors: string[] } {
  const trimmed = raw.trim();
  if (!trimmed) return { findings: [], errors: [] };
  let parsed: GitleaksResult[];
  try {
    parsed = JSON.parse(trimmed) as GitleaksResult[];
  } catch {
    return { findings: [], errors: ["gitleaks produced output that is not JSON"] };
  }
  if (!Array.isArray(parsed)) return { findings: [], errors: ["gitleaks report was not an array"] };
  return {
    // Every gitleaks hit maps to p1-high, per security-review's mapping table.
    findings: parsed.map((result) => {
      const file = result.File ?? "";
      const line = result.StartLine ?? 0;
      const rule = result.RuleID ?? "unknown";
      return {
        fingerprint: fingerprint("gitleaks", rule, file, contextFor(file, line)),
        severity: "p1-high" as const,
        tool: "gitleaks" as const,
        rule,
        file,
        line,
        // Never the matched secret itself — the report is written to disk and
        // read into a prompt.
        title: (result.Description ?? rule).split("\n")[0].slice(0, 200),
      };
    }),
    errors: [],
  };
}

export interface ExtractPatternsOptions {
  repo: string;
  base: string;
  head: string;
  changedPaths: string[];
  rulesPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ExtractPatternsResult {
  payload: PatternsPayload;
  degraded: DegradedEntry[];
  /** Which manifest binaries this run needed, for the toolchain stamp. */
  tools: string[];
}

export function extractPatterns(options: ExtractPatternsOptions): ExtractPatternsResult {
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? 180_000;
  const degraded: DegradedEntry[] = [];
  const findings: ScannerFinding[] = [];

  const sourceCache = new Map<string, string | null>();
  const contextFor = (file: string, line: number): string => {
    if (!sourceCache.has(file)) sourceCache.set(file, showFile(options.repo, options.head, file));
    return threeLineContext(sourceCache.get(file) ?? null, line);
  };

  // ── opengrep ───────────────────────────────────────────────────────────────
  const opengrep = resolveToolBin("opengrep", env);
  const scannable = options.changedPaths.filter((path) => existsSync(join(options.repo, path)));
  if (!opengrep) {
    degraded.push({
      extractor: "patterns",
      reason:
        "opengrep is not on PATH (and LASTLIGHT_OPENGREP_BIN is unset) — the pattern half of the security family was NOT MEASURED, which is not the same as clean",
    });
  } else if (scannable.length === 0) {
    degraded.push({
      extractor: "patterns",
      reason: "no changed file exists at head to scan — opengrep was not run",
    });
  } else {
    const rules = options.rulesPath ?? defaultRulesPath();
    if (!existsSync(rules)) {
      degraded.push({
        extractor: "patterns",
        reason: `the opengrep ruleset ${rules} does not exist — the Semgrep registry is deliberately not used (locked decision 7), so pass --rules`,
      });
    } else {
      const result = spawnSync(
        opengrep,
        ["scan", "--json", "--quiet", "--config", rules, "--", ...scannable],
        { cwd: options.repo, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 },
      );
      // opengrep exits 1 when it FINDS something — that is success, not failure.
      if (result.error || (result.status !== 0 && result.status !== 1)) {
        degraded.push({
          extractor: "patterns",
          reason: `opengrep exited ${result.status ?? "with an error"}: ${(result.stderr || result.error?.message || "no stderr").trim().split("\n").slice(-1)[0]}`,
        });
      } else {
        const normalised = normaliseOpengrep(result.stdout ?? "", contextFor);
        findings.push(...normalised.findings);
        for (const error of normalised.errors) {
          degraded.push({ extractor: "patterns", reason: `opengrep: ${error}` });
        }
      }
    }
  }

  // ── gitleaks ───────────────────────────────────────────────────────────────
  const gitleaks = resolveToolBin("gitleaks", env);
  if (!gitleaks) {
    degraded.push({
      extractor: "patterns",
      reason:
        "gitleaks is not on PATH (and LASTLIGHT_GITLEAKS_BIN is unset) — the commit range was NOT scanned for secrets",
    });
  } else {
    const scratch = mkdtempSync(join(tmpdir(), "lastlight-facts-gitleaks-"));
    const report = join(scratch, "report.json");
    try {
      const result = runGitleaks(gitleaks, options, report, timeout);
      if (result.failed) {
        degraded.push({ extractor: "patterns", reason: result.failed });
      } else {
        const raw = existsSync(report) ? readFileSync(report, "utf8") : "";
        const normalised = normaliseGitleaks(raw, contextFor);
        findings.push(...normalised.findings);
        for (const error of normalised.errors) {
          degraded.push({ extractor: "patterns", reason: `gitleaks: ${error}` });
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
  return { payload: { findings }, degraded, tools: ["opengrep", "gitleaks"] };
}

/**
 * gitleaks renamed `detect` to `git` in 8.19 and kept both for a while. The
 * manifest pins 8.21.2, where `detect` works — but a bump that silently changed
 * the subcommand would otherwise present as "no secrets found", so the fallback
 * is here and the failure is reported rather than swallowed.
 */
function runGitleaks(
  bin: string,
  options: ExtractPatternsOptions,
  report: string,
  timeout: number,
): { failed?: string } {
  const args = (subcommand: string): string[] => [
    subcommand,
    "--source",
    options.repo,
    "--log-opts",
    `${options.base}..${options.head}`,
    "--report-format",
    "json",
    "--report-path",
    report,
    "--no-banner",
    "--redact",
    "--exit-code",
    "0",
  ];
  let result = spawnSync(bin, args("detect"), { encoding: "utf8", timeout });
  if (result.status !== 0 || result.error) {
    result = spawnSync(bin, args("git"), { encoding: "utf8", timeout });
  }
  if (result.error || result.status !== 0) {
    return {
      failed: `gitleaks exited ${result.status ?? "with an error"}: ${(result.stderr || result.error?.message || "no stderr").trim().split("\n").slice(-1)[0]}`,
    };
  }
  return {};
}
