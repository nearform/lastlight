import { describe, it, expect, vi } from "vitest";
import {
  GitHubClient,
  actionsJobIdFromDetailsUrl,
  actionsRunIdFromDetailsUrl,
  extractErrorExcerpt,
  renderCiFailureReport,
} from "#src/engine/github/github.js";

/**
 * Unit coverage for `getCiFailureReport` + its `getFailedChecks` renderer,
 * `actionsJobIdFromDetailsUrl` / `actionsRunIdFromDetailsUrl`, and
 * `extractErrorExcerpt`.
 *
 * Swap pattern mirrors github-checks.test.ts.
 */

type CheckRun = {
  id: number;
  name: string;
  conclusion: string;
  details_url?: string | null;
  app?: { slug: string };
};

type Annotation = {
  annotation_level: string;
  path: string;
  start_line: number;
  message: string;
};

type JobStep = { name: string; conclusion: string };

/**
 * The Actions endpoints default to REJECTING, which is the shape of an install
 * without `Actions: read` — i.e. every install that followed our setup docs
 * before this permission was documented. A test opts into readable Actions by
 * passing `jobSteps` / `workflowPath`.
 */
function makeOctokit(opts: {
  checkRuns: CheckRun[];
  /** `Error` → the download rejects with it; anything else is the response body. */
  logData?: unknown;
  annotations?: Annotation[];
  jobSteps?: JobStep[] | Error;
  workflowPath?: string | Error;
}) {
  const downloadFn = vi.fn(async () => {
    if (opts.logData instanceof Error) throw opts.logData;
    return { data: opts.logData ?? "" };
  });
  const getJobFn = vi.fn(async () => {
    if (opts.jobSteps === undefined) throw forbidden();
    if (opts.jobSteps instanceof Error) throw opts.jobSteps;
    return { data: { steps: opts.jobSteps } };
  });
  const getRunFn = vi.fn(async () => {
    if (opts.workflowPath === undefined) throw forbidden();
    if (opts.workflowPath instanceof Error) throw opts.workflowPath;
    return { data: { path: opts.workflowPath } };
  });
  return {
    downloadFn,
    getJobFn,
    getRunFn,
    octokit: {
      rest: {
        checks: {
          listForRef: async () => ({ data: { check_runs: opts.checkRuns } }),
          listAnnotations: async () => ({
            data: opts.annotations ?? [],
          }),
        },
        actions: {
          downloadJobLogsForWorkflowRun: downloadFn,
          getJobForWorkflowRun: getJobFn,
          getWorkflowRun: getRunFn,
        },
      },
    },
  };
}

/** What octokit throws when the App lacks the permission for an endpoint. */
function forbidden(): Error {
  return Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
}

/** Any octokit HTTP failure — the shape `httpStatus()` reads. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function clientWith(octokit: unknown): GitHubClient {
  const c = GitHubClient.withToken("t", "http://mock");
  (c as unknown as { octokit: unknown }).octokit = octokit;
  return c;
}

// ---------------------------------------------------------------------------
// actionsJobIdFromDetailsUrl — pure unit tests
// ---------------------------------------------------------------------------

describe("actionsJobIdFromDetailsUrl", () => {
  it("extracts the job id from a standard Actions details_url", () => {
    expect(
      actionsJobIdFromDetailsUrl(
        "https://github.com/nearform/repo/actions/runs/12345/job/456"
      )
    ).toBe(456);
  });

  it("returns null for a URL without /job/", () => {
    expect(actionsJobIdFromDetailsUrl("https://circleci.com/gh/org/repo/789")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(actionsJobIdFromDetailsUrl(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(actionsJobIdFromDetailsUrl(undefined)).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(actionsJobIdFromDetailsUrl("not-a-url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// actionsRunIdFromDetailsUrl — pure unit tests
// ---------------------------------------------------------------------------

describe("actionsRunIdFromDetailsUrl", () => {
  it("extracts the run id from a standard Actions details_url", () => {
    expect(
      actionsRunIdFromDetailsUrl(
        "https://github.com/nearform/repo/actions/runs/12345/job/456"
      )
    ).toBe(12345);
  });

  it("does not confuse the job id for the run id", () => {
    const url = "https://github.com/nearform/repo/actions/runs/12345/job/456";
    expect(actionsRunIdFromDetailsUrl(url)).not.toBe(actionsJobIdFromDetailsUrl(url));
  });

  it("returns null for a non-Actions URL", () => {
    expect(actionsRunIdFromDetailsUrl("https://circleci.com/gh/org/repo/789")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(actionsRunIdFromDetailsUrl(null)).toBeNull();
    expect(actionsRunIdFromDetailsUrl(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractErrorExcerpt — pure unit tests
// ---------------------------------------------------------------------------

describe("extractErrorExcerpt", () => {
  it("strips leading ISO-8601 timestamps", () => {
    const log = "2026-07-24T06:04:28.1234567Z error: something went wrong\n";
    const result = extractErrorExcerpt(log);
    expect(result).toContain("error: something went wrong");
    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("returns context lines around a real error line", () => {
    const lines = [
      "2026-07-24T06:04:00.000Z info: start",
      "2026-07-24T06:04:01.000Z info: running build",
      "2026-07-24T06:04:02.000Z error: Cannot find module 'postcss-import'",
      "2026-07-24T06:04:03.000Z info: done",
    ];
    const result = extractErrorExcerpt(lines.join("\n"));
    expect(result).toContain("Cannot find module 'postcss-import'");
    expect(result).toContain("info: start");
  });

  it("does not anchor on pure noise lines", () => {
    const lines = [
      "2026-07-24T06:04:01.000Z error: real failure here",
      "2026-07-24T06:04:02.000Z Process completed with exit code 1",
    ];
    const result = extractErrorExcerpt(lines.join("\n"));
    // Must contain the real error, not be dominated by the noise line
    expect(result).toContain("real failure here");
  });

  it("surfaces noise-only logs rather than returning empty", () => {
    const log = "2026-07-24T06:04:02.000Z Process completed with exit code 1\n";
    const result = extractErrorExcerpt(log);
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it("falls back to tail lines when no error lines found", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `2026-01-01T00:00:00.000Z info: line ${i}`);
    const result = extractErrorExcerpt(lines.join("\n"));
    expect(result.trim().length).toBeGreaterThan(0);
    // Should not contain timestamps
    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// getFailedChecks — integration-style tests with fake octokit
// ---------------------------------------------------------------------------

describe("GitHubClient.getFailedChecks", () => {
  it("returns sentinel when there are no failed checks", async () => {
    const { octokit } = makeOctokit({ checkRuns: [] });
    const c = clientWith(octokit);
    expect(await c.getFailedChecks("o", "r", "sha")).toBe("No failed checks found.");
  });

  it("uses the job id from details_url, not run.id", async () => {
    const LOG = [
      "2026-07-24T06:04:00.000Z ##[group]Run npm run build",
      "2026-07-24T06:04:01.000Z > vite build",
      "2026-07-24T06:04:02.000Z error [postcss]: Cannot find module 'postcss-import'",
      "2026-07-24T06:04:03.000Z Process completed with exit code 1",
    ].join("\n");

    const { octokit, downloadFn } = makeOctokit({
      checkRuns: [
        {
          id: 999, // run.id — must NOT be used as job_id
          name: "CI / build",
          conclusion: "failure",
          details_url:
            "https://github.com/nearform/repo/actions/runs/12345/job/456",
        },
      ],
      logData: LOG,
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    // Must have called download with the correct job id (456), not run.id (999)
    expect(downloadFn).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 456 })
    );

    // The excerpt must surface the real PostCSS error, not just "Process completed"
    expect(result).toContain("postcss-import");
    expect(result).not.toBe("Process completed with exit code 1");

    // Timestamps must be stripped
    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);

    // Section header must be present
    expect(result).toContain("### CI / build: failure");
  });

  it("falls back to annotations when log download rejects", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [
        {
          id: 10,
          name: "CI / test",
          conclusion: "failure",
          details_url:
            "https://github.com/nearform/repo/actions/runs/1/job/2",
        },
      ],
      logData: new Error("404 Not Found"),
      annotations: [
        {
          annotation_level: "failure",
          path: "src/index.ts",
          start_line: 42,
          message: "Unexpected token",
        },
      ],
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    expect(result).toContain("### CI / test: failure");
    expect(result).toContain("src/index.ts:42");
    expect(result).toContain("Unexpected token");
  });

  it("skips log download when details_url is null (non-Actions check)", async () => {
    const { octokit, downloadFn } = makeOctokit({
      checkRuns: [
        {
          id: 20,
          name: "CircleCI",
          conclusion: "failure",
          details_url: null,
        },
      ],
      annotations: [
        {
          annotation_level: "failure",
          path: ".github/ci.yml",
          start_line: 77,
          message: "Process completed with exit code 1",
        },
      ],
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    // Log download must never have been attempted
    expect(downloadFn).not.toHaveBeenCalled();

    // Should still show the annotation
    expect(result).toContain("### CircleCI: failure");
    expect(result).toContain(".github/ci.yml:77");
  });

  it("skips log download when details_url has no /job/ segment", async () => {
    const { octokit, downloadFn } = makeOctokit({
      checkRuns: [
        {
          id: 30,
          name: "External",
          conclusion: "failure",
          details_url: "https://circleci.com/gh/org/repo/999",
        },
      ],
      annotations: [],
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    expect(downloadFn).not.toHaveBeenCalled();
    expect(result).toContain("### External: failure");
  });

  it("surfaces noise-only log rather than an empty excerpt", async () => {
    const LOG = "2026-07-24T06:04:02.000Z Process completed with exit code 1\n";

    const { octokit } = makeOctokit({
      checkRuns: [
        {
          id: 40,
          name: "CI / lint",
          conclusion: "failure",
          details_url:
            "https://github.com/nearform/repo/actions/runs/1/job/2",
        },
      ],
      logData: LOG,
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    expect(result).toContain("### CI / lint: failure");
    // Should have SOME content (not just "No log details available.")
    const body = result.split("\n").slice(1).join("\n").trim();
    expect(body.length).toBeGreaterThan(0);
  });

  it("falls back to warning-level annotations when no failure-level ones exist", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [
        {
          id: 50,
          name: "CI / typecheck",
          conclusion: "failure",
          details_url: null,
        },
      ],
      annotations: [
        {
          annotation_level: "warning",
          path: "src/foo.ts",
          start_line: 5,
          message: "Unused variable",
        },
      ],
    });

    const c = clientWith(octokit);
    const result = await c.getFailedChecks("o", "r", "sha");

    expect(result).toContain("### CI / typecheck: failure");
    expect(result).toContain("src/foo.ts:5");
    expect(result).toContain("Unused variable");
  });
});

// ---------------------------------------------------------------------------
// getCiFailureReport — the structured report behind getFailedChecks
// ---------------------------------------------------------------------------

const ACTIONS_URL = "https://github.com/nearform/repo/actions/runs/12345/job/456";

const REAL_LOG = [
  "2026-07-24T06:04:00.000Z ##[group]Run npm test",
  "2026-07-24T06:04:02.000Z error: Cannot find module 'postcss-import'",
  "2026-07-24T06:04:03.000Z Process completed with exit code 1",
].join("\n");

describe("GitHubClient.getCiFailureReport", () => {
  it("returns an empty, logs-unavailable report when nothing failed", async () => {
    const { octokit } = makeOctokit({ checkRuns: [] });
    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");
    expect(report).toEqual({ jobs: [], logsAvailable: false });
  });

  it("reports real job logs, the workflow path and the failing step", async () => {
    const { octokit, getRunFn, getJobFn } = makeOctokit({
      checkRuns: [
        { id: 1, name: "CI / build", conclusion: "failure", details_url: ACTIONS_URL },
      ],
      logData: REAL_LOG,
      jobSteps: [
        { name: "Checkout", conclusion: "success" },
        { name: "Run npm test", conclusion: "failure" },
      ],
      workflowPath: ".github/workflows/ci.yml",
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.logsAvailable).toBe(true);
    expect(report.jobs).toHaveLength(1);
    const [job] = report.jobs;
    expect(job).toMatchObject({
      name: "CI / build",
      conclusion: "failure",
      workflowPath: ".github/workflows/ci.yml",
      failingStep: "Run npm test",
      jobUrl: ACTIONS_URL,
      logsAvailable: true,
    });
    expect(job.logExcerpt).toContain("postcss-import");

    // The run id comes from the URL, so resolving workflowPath costs no extra
    // lookup to discover it — and the job lookup uses the JOB id, not the run's.
    expect(getRunFn).toHaveBeenCalledWith(expect.objectContaining({ run_id: 12345 }));
    expect(getJobFn).toHaveBeenCalledWith(expect.objectContaining({ job_id: 456 }));
  });

  it("degrades to annotations with logsAvailable false when Actions 403s", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [
        { id: 2, name: "CI / test", conclusion: "failure", details_url: ACTIONS_URL },
      ],
      logData: Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
      annotations: [
        {
          annotation_level: "failure",
          path: "src/index.ts",
          start_line: 42,
          message: "Unexpected token",
        },
      ],
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.logsAvailable).toBe(false);
    expect(report.jobs[0].logsAvailable).toBe(false);
    expect(report.jobs[0].logExcerpt).toContain("src/index.ts:42");
    // The Actions-only locators must be absent, not guessed at.
    expect(report.jobs[0].workflowPath).toBeUndefined();
    expect(report.jobs[0].failingStep).toBeUndefined();
  });

  it("keeps the log when only the metadata reads are denied", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [
        { id: 3, name: "CI / build", conclusion: "failure", details_url: ACTIONS_URL },
      ],
      logData: REAL_LOG,
      // jobSteps + workflowPath omitted → both endpoints 403.
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.logsAvailable).toBe(true);
    expect(report.jobs[0].workflowPath).toBeUndefined();
    expect(report.jobs[0].failingStep).toBeUndefined();
  });

  it("resolves the workflow path once for a whole failing matrix", async () => {
    const { octokit, getRunFn } = makeOctokit({
      checkRuns: [
        { id: 4, name: "CI / test (20)", conclusion: "failure", details_url: ACTIONS_URL },
        {
          id: 5,
          name: "CI / test (22)",
          conclusion: "failure",
          details_url: "https://github.com/nearform/repo/actions/runs/12345/job/457",
        },
      ],
      logData: REAL_LOG,
      workflowPath: ".github/workflows/ci.yml",
      jobSteps: [{ name: "Run npm test", conclusion: "failure" }],
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.jobs.map((j) => j.workflowPath)).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/ci.yml",
    ]);
    expect(getRunFn).toHaveBeenCalledTimes(1);
  });

  it("throws when the check-run listing itself fails", async () => {
    const octokit = {
      rest: {
        checks: {
          listForRef: async () => {
            throw new Error("502 Bad Gateway");
          },
        },
      },
    };
    await expect(clientWith(octokit).getCiFailureReport("o", "r", "sha")).rejects.toThrow(
      "502 Bad Gateway"
    );
    // …and getFailedChecks absorbs it, because a prompt can't handle a throw.
    expect(await clientWith(octokit).getFailedChecks("o", "r", "sha")).toBe(
      "Could not fetch check runs: 502 Bad Gateway"
    );
  });
});

// ---------------------------------------------------------------------------
// renderCiFailureReport — the "degrade loudly" contract (issue #251, Finding 1)
// ---------------------------------------------------------------------------

describe("renderCiFailureReport", () => {
  const actionsJob = {
    name: "CI / build",
    conclusion: "failure",
    logExcerpt: "src/index.ts:42 — Unexpected token",
    jobUrl: ACTIONS_URL,
    logsAvailable: false,
  };

  it("prefixes the missing-permission note when a 403 said the permission is missing", () => {
    const out = renderCiFailureReport({
      jobs: [{ ...actionsJob, logUnavailableCause: "forbidden" }],
      logsAvailable: false,
      logUnavailableCause: "forbidden",
    });
    expect(out).toContain("NOTE: GitHub Actions job logs are unavailable");
    expect(out).toContain("the App lacks `Actions: read`");
    expect(out).toContain("Grant Actions: read for full CI output.");
    // The note must lead — it qualifies everything under it.
    expect(out.startsWith("NOTE:")).toBe(true);
    expect(out).toContain("### CI / build: failure");
  });

  it("omits the note when real logs came through", () => {
    const out = renderCiFailureReport({
      jobs: [{ ...actionsJob, logsAvailable: true }],
      logsAvailable: true,
    });
    expect(out).not.toContain("NOTE:");
  });

  it("omits the note when no failed check was a GitHub Actions job", () => {
    // A CircleCI-only repo has no Actions logs to be missing; telling its
    // operator to grant Actions: read would be wrong.
    const out = renderCiFailureReport({
      jobs: [
        {
          name: "ci/circleci: build",
          conclusion: "failure",
          logExcerpt: "boom",
          jobUrl: "https://circleci.com/gh/org/repo/999",
          logsAvailable: false,
        },
      ],
      logsAvailable: false,
    });
    expect(out).not.toContain("NOTE:");
  });

  it("renders the Actions locators when they resolved", () => {
    const out = renderCiFailureReport({
      jobs: [
        {
          ...actionsJob,
          logsAvailable: true,
          workflowPath: ".github/workflows/ci.yml",
          failingStep: "Run npm test",
        },
      ],
      logsAvailable: true,
    });
    expect(out).toContain("(workflow: .github/workflows/ci.yml — failing step: Run npm test)");
  });

  it("keeps the sentinel dispatchWorkflow tests for", () => {
    expect(renderCiFailureReport({ jobs: [], logsAvailable: false })).toBe(
      "No failed checks found."
    );
  });

  // Every one of these used to render the 403 banner, because the banner named
  // a cause nobody had checked. An operator told to grant a permission they
  // already granted stops reading — the same "degradation that looks like
  // normal operation" issue #251 is about.
  it("blames retention, not the permission, when the logs expired (410)", () => {
    const out = renderCiFailureReport({
      jobs: [{ ...actionsJob, logUnavailableCause: "expired" }],
      logsAvailable: false,
      logUnavailableCause: "expired",
    });
    expect(out.startsWith("NOTE:")).toBe(true);
    expect(out).toContain("410 Gone");
    expect(out).not.toContain("Actions: read");
    expect(out).toContain("### CI / build: failure");
  });

  it("blames the fetch, not the permission, when it merely failed", () => {
    const out = renderCiFailureReport({
      jobs: [{ ...actionsJob, logUnavailableCause: "unavailable" }],
      logsAvailable: false,
      logUnavailableCause: "unavailable",
    });
    expect(out).toContain("could not be fetched");
    expect(out).not.toContain("Actions: read");
  });

  it("says the log was empty when that is what happened", () => {
    const out = renderCiFailureReport({
      jobs: [{ ...actionsJob, logUnavailableCause: "empty" }],
      logsAvailable: false,
      logUnavailableCause: "empty",
    });
    expect(out).toContain("EMPTY job log");
    expect(out).not.toContain("Actions: read");
  });

  it("claims least when no cause was recorded", () => {
    // An unclassified failure is not evidence of a missing permission — that
    // would be a claim about a status code we never saw.
    const out = renderCiFailureReport({ jobs: [actionsJob], logsAvailable: false });
    expect(out).toContain("could not be fetched");
    expect(out).not.toContain("Actions: read");
  });
});

// ---------------------------------------------------------------------------
// getCiFailureReport — WHY the logs are missing (issue #251, Finding 1)
//
// The report is the only thing that knows the status code, so classifying at
// the point of failure is the only place the banner can get it right.
// ---------------------------------------------------------------------------

describe("GitHubClient.getCiFailureReport — log-unavailable cause", () => {
  const failingCheck = (id = 1): CheckRun => ({
    id,
    name: "CI / build",
    conclusion: "failure",
    details_url: ACTIONS_URL,
  });

  it("classifies a 403 as the missing permission", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [failingCheck()],
      logData: forbidden(),
    });
    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");
    expect(report.logUnavailableCause).toBe("forbidden");
    expect(renderCiFailureReport(report)).toContain("the App lacks `Actions: read`");
  });

  it("classifies a 410 as expired retention, and never blames the permission", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [failingCheck()],
      logData: httpError(410, "Gone"),
      annotations: [
        { annotation_level: "failure", path: "src/a.ts", start_line: 1, message: "boom" },
      ],
    });
    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.logsAvailable).toBe(false);
    expect(report.logUnavailableCause).toBe("expired");
    expect(report.jobs[0].logUnavailableCause).toBe("expired");
    // The annotation fallback still runs — the cause changes the banner, not
    // the evidence we can still get.
    expect(report.jobs[0].logExcerpt).toContain("src/a.ts:1");
    expect(renderCiFailureReport(report)).not.toContain("Actions: read");
  });

  it("classifies a 429 secondary rate limit as a fetch failure, not a permission", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [failingCheck()],
      logData: httpError(429, "You have exceeded a secondary rate limit"),
    });
    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.logUnavailableCause).toBe("unavailable");
    expect(renderCiFailureReport(report)).not.toContain("Actions: read");
  });

  it("classifies a 500 as a fetch failure too", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [failingCheck()],
      logData: httpError(500, "Internal Server Error"),
    });
    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");
    expect(report.logUnavailableCause).toBe("unavailable");
  });

  it("classifies a whitespace-only log as empty, not as a failed fetch", async () => {
    const { octokit } = makeOctokit({ checkRuns: [failingCheck()], logData: "   \n\n  \n" });
    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.logsAvailable).toBe(false);
    expect(report.logUnavailableCause).toBe("empty");
    expect(renderCiFailureReport(report)).toContain("EMPTY job log");
  });

  it("lets the actionable 403 win over another job's expiry", async () => {
    // A 403 is App-wide, so one job reporting it settles the question — and it
    // is the only cause with an action attached.
    const downloads = [httpError(410, "Gone"), forbidden()];
    let n = 0;
    const octokit = {
      rest: {
        checks: {
          listForRef: async () => ({
            data: {
              check_runs: [
                failingCheck(1),
                { ...failingCheck(2), details_url: `${ACTIONS_URL.slice(0, -3)}457` },
              ],
            },
          }),
          listAnnotations: async () => ({ data: [] }),
        },
        actions: {
          downloadJobLogsForWorkflowRun: async () => {
            throw downloads[n++];
          },
          getJobForWorkflowRun: async () => {
            throw forbidden();
          },
          getWorkflowRun: async () => {
            throw forbidden();
          },
        },
      },
    };
    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");
    expect(report.logUnavailableCause).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// getCiFailureReport — bounds
//
// This runs synchronously on the dispatch path, before any disposition is
// taken, on a host with a 2 GB agent cap and no swap.
// ---------------------------------------------------------------------------

describe("GitHubClient.getCiFailureReport — bounds", () => {
  it("caps a single-line log in BYTES, not just lines", async () => {
    // The line bounds (50 context lines / a 30-line tail) are no bound at all
    // on a minified bundle or a base64 blob: the whole failure is ONE line.
    const huge = `error: ${"x".repeat(5_000_000)}`;
    const { octokit } = makeOctokit({
      checkRuns: [
        { id: 1, name: "CI / build", conclusion: "failure", details_url: ACTIONS_URL },
      ],
      logData: huge,
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.logsAvailable).toBe(true);
    expect(Buffer.byteLength(report.jobs[0].logExcerpt, "utf8")).toBeLessThan(20_000);
    // …and it says it was cut, rather than reading like a complete excerpt.
    expect(report.jobs[0].logExcerpt).toContain("[truncated");
  });

  it("caps a many-line log in bytes as well", async () => {
    const log = Array.from({ length: 4000 }, (_, i) => `error: line ${i} ${"y".repeat(200)}`).join(
      "\n",
    );
    const { octokit } = makeOctokit({
      checkRuns: [
        { id: 1, name: "CI / build", conclusion: "failure", details_url: ACTIONS_URL },
      ],
      logData: log,
    });
    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");
    expect(Buffer.byteLength(report.jobs[0].logExcerpt, "utf8")).toBeLessThan(20_000);
  });

  it("never runs more than a handful of job-log downloads at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const checkRuns: CheckRun[] = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `CI / shard ${i}`,
      conclusion: "failure",
      details_url: `https://github.com/nearform/repo/actions/runs/12345/job/${1000 + i}`,
    }));
    const octokit = {
      rest: {
        checks: {
          listForRef: async () => ({ data: { check_runs: checkRuns } }),
          listAnnotations: async () => ({ data: [] }),
        },
        actions: {
          downloadJobLogsForWorkflowRun: async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 1));
            inFlight--;
            return { data: REAL_LOG };
          },
          getJobForWorkflowRun: async () => ({ data: { steps: [] } }),
          getWorkflowRun: async () => ({ data: { path: ".github/workflows/ci.yml" } }),
        },
      },
    };

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.jobs).toHaveLength(30);
    expect(peak).toBeLessThanOrEqual(4);
    // Order still follows the check-run listing however the waves interleaved.
    expect(report.jobs.map((j) => j.name)).toEqual(checkRuns.map((r) => r.name));
  });

  it("passes an abort signal to every Actions read", async () => {
    const { octokit, downloadFn, getJobFn, getRunFn } = makeOctokit({
      checkRuns: [
        { id: 1, name: "CI / build", conclusion: "failure", details_url: ACTIONS_URL },
      ],
      logData: REAL_LOG,
      jobSteps: [],
      workflowPath: ".github/workflows/ci.yml",
    });

    await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    for (const fn of [downloadFn, getJobFn, getRunFn]) {
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ signal: expect.any(AbortSignal) }),
        }),
      );
    }
  });

  it("decodes an ArrayBuffer body instead of stringifying it", async () => {
    // Octokit only returns a string for a text/* or utf-8 response; the Actions
    // log 302s to blob storage, whose content type we do not control. The old
    // `String(data)` made that "[object ArrayBuffer]" — non-empty, so it passed
    // for a real log and suppressed both the annotation fallback and the banner.
    const bytes = Buffer.from(REAL_LOG, "utf8");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const { octokit } = makeOctokit({
      checkRuns: [
        { id: 1, name: "CI / build", conclusion: "failure", details_url: ACTIONS_URL },
      ],
      logData: buffer,
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.logsAvailable).toBe(true);
    expect(report.jobs[0].logExcerpt).toContain("postcss-import");
    expect(report.jobs[0].logExcerpt).not.toContain("[object");
  });

  it("refuses to treat an undecodable body as a log", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [
        { id: 1, name: "CI / build", conclusion: "failure", details_url: ACTIONS_URL },
      ],
      logData: { some: "json" },
      annotations: [
        { annotation_level: "failure", path: "src/a.ts", start_line: 7, message: "boom" },
      ],
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.logsAvailable).toBe(false);
    expect(report.logUnavailableCause).toBe("unavailable");
    // The annotation fallback must still run — that is what it is for.
    expect(report.jobs[0].logExcerpt).toContain("src/a.ts:7");
  });
});

// ---------------------------------------------------------------------------
// getCiFailureReport — excludeApp
//
// `concludeReviewCheck` sets conclusion: "failure" for a CHANGES_REQUESTED
// review (../review-check.ts), so without this the fix agent is handed its own
// reviewer's verdict as CI evidence to fix. Every sibling read on the dispatch
// path already passes `excludeApp` (pr-state.ts) — this was the one that didn't.
// ---------------------------------------------------------------------------

describe("GitHubClient.getCiFailureReport — excludeApp", () => {
  const ourReviewCheck: CheckRun = {
    id: 1,
    name: "last-light/review",
    conclusion: "failure",
    details_url: "https://lastlight.dev/runs/1",
    app: { slug: "last-light" },
  };
  const realCi: CheckRun = {
    id: 2,
    name: "CI / build",
    conclusion: "failure",
    details_url: ACTIONS_URL,
    app: { slug: "github-actions" },
  };

  it("drops our own failing check run when the option is passed", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [ourReviewCheck, realCi],
      logData: REAL_LOG,
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha", {
      excludeApp: "last-light",
    });

    expect(report.jobs.map((j) => j.name)).toEqual(["CI / build"]);
  });

  it("keeps every check when no app is excluded", async () => {
    const { octokit } = makeOctokit({
      checkRuns: [ourReviewCheck, realCi],
      logData: REAL_LOG,
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha");

    expect(report.jobs.map((j) => j.name)).toEqual(["last-light/review", "CI / build"]);
  });

  it("reports nothing failing when our own check was the only red one", async () => {
    const { octokit, downloadFn } = makeOctokit({
      checkRuns: [ourReviewCheck],
      logData: REAL_LOG,
    });

    const report = await clientWith(octokit).getCiFailureReport("o", "r", "sha", {
      excludeApp: "last-light",
    });

    expect(report).toEqual({ jobs: [], logsAvailable: false });
    // …and no Actions read was paid for a report with nothing in it.
    expect(downloadFn).not.toHaveBeenCalled();
  });

  it("forwards the option through getFailedChecks", async () => {
    const { octokit } = makeOctokit({ checkRuns: [ourReviewCheck], logData: REAL_LOG });
    const out = await clientWith(octokit).getFailedChecks("o", "r", "sha", {
      excludeApp: "last-light",
    });
    expect(out).toBe("No failed checks found.");
  });
});
