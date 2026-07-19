import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  api,
  type WorkflowApproval,
  type WorkflowDefinition,
  type WorkflowPhaseDefinition,
  type WorkflowRun,
  type WorkflowRunExecution,
} from "../api";
import { GhLink } from "./GhLink";
import { repoUrl, issueUrl } from "../lib/githubLinks";

/**
 * In-SPA navigation to the artifact editor for a specific doc — the Repos tab's
 * Assets sub-tab, which now hosts the viewer. Pushes the deep-link params and
 * fires a synthetic popstate so every `useUrlState` hook (App's `tab`,
 * ReposPage's `repo`/`rtab`, ArtifactsPage's key/doc) re-reads — no full reload,
 * no callback threading through the run-detail component tree.
 */
function openArtifact(repo: string, key: string, doc: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", "repos");
  url.searchParams.set("rtab", "assets");
  url.searchParams.set("repo", repo);
  url.searchParams.set("key", key);
  url.searchParams.set("doc", doc);
  window.history.pushState(null, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** In-SPA navigation to the focused approval view (`?approval=<id>`). */
function openFocusedApproval(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("approval", id);
  window.history.pushState(null, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

interface Props {
  phaseName: string;
  run: WorkflowRun;
  definition: WorkflowDefinition | null;
  /** Most recent execution for this phase, if one exists. */
  execution: WorkflowRunExecution | null;
  /**
   * Number of executions recorded for this phase. Surfaced so the user knows
   * a loop phase had multiple iterations even though we only show the latest.
   */
  totalExecutions: number;
  /**
   * Run-scoped approvals (all statuses). When the selected node is an approval
   * gate (`phaseName === "approval:<id>"`) the panel shows that record's
   * read-only history instead of execution metrics.
   */
  approvals?: WorkflowApproval[];
}

function fmtDuration(ms?: number): string {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m${r}s`;
}

function fmtCost(usd?: number): string {
  if (usd === undefined || usd === null) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n?: number): string {
  if (n === undefined || n === null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString();
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function fmtExtension(v: {
  status: string;
  mode?: string;
  provider?: string;
  toolCount?: number;
  reason?: string;
}): string {
  const parts: string[] = [v.status];
  if (v.mode) parts.push(v.mode);
  if (v.provider) parts.push(v.provider);
  if (typeof v.toolCount === "number") {
    parts.push(`${v.toolCount} tool${v.toolCount === 1 ? "" : "s"}`);
  }
  if (v.status !== "configured" && v.reason) parts.push(v.reason);
  return parts.join(" · ");
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs font-semibold uppercase tracking-wider text-base-content/40">
        {label}
      </span>
      <span className="text-xs text-base-content/80 font-mono break-words">{children}</span>
    </div>
  );
}

export function PhaseDetailPanel({
  phaseName,
  run,
  definition,
  execution,
  totalExecutions,
  approvals,
}: Props) {
  // Approval-gate nodes carry id `approval:<id>` and have no execution row —
  // resolve the clicked gate back to its record so we can show its history.
  const selectedApproval = phaseName.startsWith("approval:")
    ? approvals?.find((a) => `approval:${a.id}` === phaseName) ?? null
    : null;
  // Look up the phase in the workflow definition (may be missing for dynamic
  // phases like reviewer_recheck_1 / reviewer_fix_1 — we still show what we know).
  const phaseDef: WorkflowPhaseDefinition | undefined = definition?.phases.find(
    (p) => p.name === phaseName,
  );

  // Find this phase's history entry — used for status colour when no execution row exists.
  const historyEntry = run.phaseHistory.find((h) => h.phase === phaseName);

  const statusLabel = execution
    ? execution.success === true
      ? "succeeded"
      : execution.success === false
        ? // Cascade-skipped phases are stored success=0 with stopReason="skipped";
          // they never ran, so label them "skipped" rather than "failed".
          execution.stopReason === "skipped"
          ? "skipped"
          : "failed"
        : "running"
    : historyEntry
      ? historyEntry.success
        ? "succeeded"
        : "failed"
      : phaseName === run.currentPhase
        ? run.status === "paused"
          ? "paused"
          : "active"
        : "pending";

  const statusClass = clsx("badge badge-xs font-mono", {
    "badge-success": statusLabel === "succeeded",
    "badge-error": statusLabel === "failed",
    "badge-info": statusLabel === "active" || statusLabel === "running",
    "badge-warning": statusLabel === "paused",
    "badge-ghost": statusLabel === "pending" || statusLabel === "skipped",
  });

  // Second tab groups "what got loaded" for this run — agentic-pi extensions
  // (tool loading) and skills (skill loading). The count drives the tab badge.
  const extensionCount = execution?.extensions ? Object.keys(execution.extensions).length : 0;
  const skillCount = execution?.skills?.skills.length ?? 0;
  const loadedCount = extensionCount + skillCount;

  // Build-asset ("Artifacts") handoff docs live per-run under
  // <owner>/<repo>/<issueKey>/, keyed by the run's issueDir (server mode only;
  // empty in repo mode). `run.repo` is the bare repo name; the owner lives in
  // context. Some runs may store "owner/repo" in repo — handle both.
  const ctxOwner = typeof run.context?.owner === "string" ? run.context.owner : "";
  const rawRepo = run.repo ?? "";
  const fullRepo = rawRepo.includes("/")
    ? rawRepo
    : ctxOwner
      ? `${ctxOwner}/${rawRepo}`
      : rawRepo;
  const [owner, repoName] = fullRepo.split("/", 2);
  const issueDir = typeof run.context?.issueDir === "string" ? run.context.issueDir : "";
  const issueKey = issueDir.replace(/^\.lastlight\//, "");

  const [artifacts, setArtifacts] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!owner || !repoName || !issueKey) {
      setArtifacts([]);
      return;
    }
    api.listArtifactFiles(owner, repoName, issueKey)
      .then((res) => { if (!cancelled) setArtifacts(res.files); })
      .catch(() => { if (!cancelled) setArtifacts([]); });
    return () => { cancelled = true; };
  }, [owner, repoName, issueKey]);

  const [tab, setTab] = useState<"details" | "loaded" | "artifacts">("details");

  // Approval gate selected → show its read-only history instead of execution
  // metrics. (Hooks above run unconditionally; this branch is after them.)
  if (selectedApproval) {
    return <ApprovalDetail approval={selectedApproval} run={run} fullRepo={fullRepo} />;
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div>
        <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-1">
          Phase
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-base-content text-sm">
            {phaseDef?.label ?? phaseName}
          </span>
          <span className={statusClass}>{statusLabel}</span>
        </div>
        {phaseDef?.label && phaseDef.label !== phaseName && (
          <div className="text-2xs text-base-content/40 font-mono mt-0.5">{phaseName}</div>
        )}
      </div>

      {/* Tabs — Details (execution/usage/session) vs Loaded (extensions/skills) */}
      <div className="flex gap-1 border-b border-base-300 -mx-3 px-3">
        <TabButton active={tab === "details"} onClick={() => setTab("details")}>
          Details
        </TabButton>
        <TabButton active={tab === "loaded"} onClick={() => setTab("loaded")}>
          Loaded{loadedCount > 0 ? ` (${loadedCount})` : ""}
        </TabButton>
        {artifacts.length > 0 && (
          <TabButton active={tab === "artifacts"} onClick={() => setTab("artifacts")}>
            Artifacts ({artifacts.length})
          </TabButton>
        )}
      </div>

      {tab === "details" && (
        <div className="flex flex-col gap-4">
          {phaseDef && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">{phaseDef.type}</Field>
              {phaseDef.hasLoop && <Field label="Loop">yes</Field>}
              {phaseDef.approvalGate && (
                <Field label="Approval Gate">{phaseDef.approvalGate}</Field>
              )}
            </div>
          )}

          {!phaseDef && (
            <div className="text-2xs text-base-content/50 italic">
              Dynamic phase (not declared in the workflow YAML — likely a loop iteration).
            </div>
          )}

          {!execution && (
            <div className="text-xs text-base-content/50 border border-base-300/40 bg-base-200/30 rounded px-3 py-2">
              No execution recorded yet.
            </div>
          )}

          {execution && (
            <>
              <div>
                <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
                  Execution
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Started">{fmtTime(execution.startedAt)}</Field>
                  <Field label="Finished">{fmtTime(execution.finishedAt)}</Field>
                  <Field label="Duration">{fmtDuration(execution.durationMs)}</Field>
                  <Field label="API Time">{fmtDuration(execution.apiDurationMs)}</Field>
                  <Field label="Turns">{execution.turns ?? "—"}</Field>
                  <Field label="Stop Reason">{execution.stopReason ?? "—"}</Field>
                </div>
              </div>

              <div>
                <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
                  Usage
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Cost">{fmtCost(execution.costUsd)}</Field>
                  <Field label="Output Tokens">{fmtTokens(execution.outputTokens)}</Field>
                  <Field label="Input Tokens">{fmtTokens(execution.inputTokens)}</Field>
                  <Field label="Cache Read">{fmtTokens(execution.cacheReadInputTokens)}</Field>
                  <Field label="Cache Create">{fmtTokens(execution.cacheCreationInputTokens)}</Field>
                </div>
              </div>

              {execution.error && (
                <div>
                  <div className="text-2xs font-semibold uppercase tracking-wider text-error/80 mb-1">
                    Error
                  </div>
                  <div className="text-2xs text-error/80 font-mono break-words border border-error/30 bg-error/5 rounded px-2 py-1">
                    {execution.error}
                  </div>
                </div>
              )}

              <div>
                <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-1">
                  Session
                </div>
                {execution.sessionId ? (
                  <div className="text-2xs font-mono text-base-content/70 break-all">
                    {execution.sessionId}
                  </div>
                ) : (
                  <div className="text-2xs text-base-content/50 italic">
                    Session not captured for this run.
                  </div>
                )}
              </div>

              {totalExecutions > 1 && (
                <div className="text-2xs text-base-content/40 italic">
                  {totalExecutions} executions recorded for this phase — showing the most recent.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "loaded" && (
        <div className="flex flex-col gap-4">
          {!execution && (
            <div className="text-xs text-base-content/50 border border-base-300/40 bg-base-200/30 rounded px-3 py-2">
              No execution recorded yet.
            </div>
          )}

          {execution && loadedCount === 0 && (
            <div className="text-2xs text-base-content/40 italic">
              No extensions or skills were loaded for this run.
            </div>
          )}

          {extensionCount > 0 && (
            <div>
              <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
                Extensions
              </div>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(execution!.extensions!).map(([name, v]) => (
                  <Field key={name} label={name}>
                    {fmtExtension(v)}
                  </Field>
                ))}
              </div>
            </div>
          )}

          {execution?.skills && <SkillsSection skills={execution.skills} />}
        </div>
      )}

      {tab === "artifacts" && (
        <div className="flex flex-col gap-2">
          <div className="text-2xs text-base-content/40">
            Handoff docs for this run — click to open in the editor.
          </div>
          <ul className="flex flex-col gap-1">
            {artifacts.map((f) => (
              <li key={f}>
                <button
                  onClick={() => openArtifact(fullRepo, issueKey, f)}
                  className="w-full text-left px-2 py-1 rounded text-xs font-mono text-primary hover:bg-base-300/50 truncate"
                >
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Read-only approval-gate history shown when the user clicks a gate node in the
 * pipeline. Surfaces who requested it, who responded, when, and any comment.
 * The actionable approve/reject lives in the ApprovalBanner + focused review.
 */
function ApprovalDetail({
  approval,
  run,
  fullRepo,
}: {
  approval: WorkflowApproval;
  run: WorkflowRun;
  fullRepo: string;
}) {
  const statusClass = clsx("badge badge-xs font-mono", {
    "badge-success": approval.status === "approved",
    "badge-error": approval.status === "rejected",
    "badge-warning": approval.status === "pending",
  });
  const decisionVerb =
    approval.status === "approved"
      ? "Approved by"
      : approval.status === "rejected"
        ? "Rejected by"
        : "Awaiting response";

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div>
        <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-1">
          Approval Gate
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-base-content text-sm font-mono">{approval.gate}</span>
          <span className={statusClass}>{approval.status}</span>
        </div>
        {approval.summary && (
          <div className="text-2xs text-base-content/60 mt-1">{approval.summary}</div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Kind">{approval.kind ?? "approve"}</Field>
        <Field label="Requested by">{approval.requestedBy ?? "—"}</Field>
        <Field label={decisionVerb}>
          {approval.status === "pending" ? "—" : approval.respondedBy ?? "—"}
        </Field>
        <Field label="Responded at">{fmtDateTime(approval.respondedAt)}</Field>
        <Field label="Created">{fmtDateTime(approval.createdAt)}</Field>
        {approval.artifact && <Field label="Artifact">{approval.artifact}</Field>}
      </div>

      {approval.response && (
        <div>
          <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-1">
            {approval.kind === "reply" ? "Reply" : "Comment"}
          </div>
          <div className="text-xs text-base-content/80 whitespace-pre-wrap break-words border border-base-300/40 bg-base-200/30 rounded px-2 py-1.5">
            {approval.response}
          </div>
        </div>
      )}

      {approval.artifact && (
        <button
          className="btn btn-xs btn-ghost text-primary self-start"
          onClick={() => openFocusedApproval(approval.id)}
          title={`Review ${approval.artifact}`}
        >
          Open focused review →
        </button>
      )}

      <div className="text-2xs text-base-content/30 font-mono break-all">
        {(() => {
          const rHref = repoUrl(fullRepo);
          const iHref = issueUrl(fullRepo, run.issueNumber, run.workflowName);
          return (
            <>
              {rHref ? (
                <GhLink href={rHref} title={`Open ${fullRepo} on GitHub`}>
                  {fullRepo}
                </GhLink>
              ) : (
                fullRepo
              )}
              {run.issueNumber ? (
                iHref ? (
                  <GhLink href={iHref} title={`Open #${run.issueNumber} on GitHub`}>
                    #{run.issueNumber}
                  </GhLink>
                ) : (
                  `#${run.issueNumber}`
                )
              ) : (
                ""
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "px-2 py-1 text-2xs font-mono border-b-2 -mb-px transition-colors",
        active
          ? "border-primary text-primary"
          : "border-transparent text-base-content/60 hover:text-base-content",
      )}
    >
      {children}
    </button>
  );
}

/** Skill-loading detail — the counterpart to the Extensions grid. */
function SkillsSection({
  skills,
}: {
  skills: NonNullable<WorkflowRunExecution["skills"]>;
}) {
  const summary = [
    skills.status,
    `${skills.discovered} discovered`,
    ...(skills.noSkills ? ["default discovery off"] : []),
  ].join(" · ");
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-1">
        Skills
      </div>
      <div className="text-2xs text-base-content/50 font-mono mb-1.5">{summary}</div>
      {skills.skills.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {skills.skills.map((s) => (
            <li key={s.source} className="flex items-center gap-1.5">
              <span className="text-xs font-mono text-base-content/80 break-all">{s.name}</span>
              {!s.modelInvocable && <span className="badge badge-ghost badge-xs">manual</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-2xs text-base-content/40 italic">No skills discovered.</div>
      )}
    </div>
  );
}
