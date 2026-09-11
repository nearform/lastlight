import { useCallback, useEffect, useMemo, useState } from "react";
import { AtSign, Clock, Code2, MessagesSquare, RefreshCw, X } from "lucide-react";
import clsx from "clsx";
import {
  api,
  phaseSkillNames,
  type WorkflowSummary,
  type WorkflowFullDefinition,
  type WorkflowFullPhase,
  type TriggerInfo,
  type TriggerKind,
} from "../api";
import { CodeBlock } from "./timeline/CodeBlock";
import {
  useUrlState,
  nullableStringParser,
  nullableStringSerializer,
  enumParser,
  enumSerializer,
} from "../hooks/useUrlState";
import { WorkflowDefinitionDiagram } from "./WorkflowDefinitionDiagram";
import { Split, SplitPane, SplitHandle } from "./Split";
import { Tabs, TabButton } from "./Tabs";
import { useIsNarrow } from "../hooks/useIsNarrow";

/**
 * The panes of this page, in tab order.
 *
 * Wide, they are columns: the workflow list, the diagram, what the selected
 * phase declares, and the YAML — which stays open beside the diagram rather
 * than hiding behind a tab, because the diagram is a rendering OF the YAML and
 * reading one against the other is the point of the page. Narrow, they are
 * tabs in one strip.
 *
 * `wfview` predates this and carried `diagram | yaml`; both are still members,
 * so existing deep links keep working.
 */
const DEF_PANES = ["workflows", "diagram", "phase", "content", "yaml"] as const;
type DefPane = (typeof DEF_PANES)[number];
const DEF_PANE_LABEL: Record<DefPane, string> = {
  workflows: "Workflows",
  diagram: "Diagram",
  phase: "Phase",
  content: "Content",
  yaml: "YAML",
};

/**
 * Workflow Definitions browser. Lists every YAML workflow definition under
 * `workflows/` and shows the selected one as either a React Flow diagram or
 * raw syntax-highlighted YAML. Clicking a phase node reveals its declared
 * fields, with the linked skill (`SKILL.md`) or prompt template rendered
 * inline below.
 */
export function WorkflowDefinitions() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedName, setSelectedName] = useUrlState<string | null>(
    "wf",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );
  const narrow = useIsNarrow();
  // Two independent selections when there is room for two content columns: the
  // centre shows the workflow (diagram or YAML) and the right shows the phase
  // (its fields or its rendered prompt). Narrow, `pane` alone drives the single
  // strip and this is unused.
  const [phaseTab, setPhaseTab] = useState<"phase" | "content">("phase");
  const [pane, setPane] = useUrlState<DefPane>(
    "wfview",
    "diagram",
    enumParser(DEF_PANES, "diagram"),
    enumSerializer<DefPane>("diagram"),
  );

  const [definition, setDefinition] = useState<WorkflowFullDefinition | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [yamlText, setYamlText] = useState<string | null>(null);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [triggers, setTriggers] = useState<TriggerInfo[]>([]);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [toggleBusy, setToggleBusy] = useState(false);

  const [selectedPhaseName, setSelectedPhaseName] = useState<string | null>(null);

  // Load the workflow list.
  useEffect(() => {
    let cancelled = false;
    api
      .workflows()
      .then((res) => {
        if (cancelled) return;
        setWorkflows(res.workflows);
        setListError(null);
        if (!selectedName && res.workflows.length > 0) {
          setSelectedName(res.workflows[0]!.name);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setListError(err instanceof Error ? err.message : "Failed to load workflows");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the selected workflow's full structured definition + raw YAML.
  useEffect(() => {
    if (!selectedName) {
      setDefinition(null);
      setYamlText(null);
      setSelectedPhaseName(null);
      return;
    }
    let cancelled = false;
    setDefinition(null);
    setDefinitionError(null);
    setYamlText(null);
    setYamlError(null);
    setTriggers([]);
    setEnabled(true);
    setSelectedPhaseName(null);

    api
      .workflowFull(selectedName)
      .then((res) => {
        if (cancelled) return;
        setDefinition(res.workflow);
        setTriggers(res.triggers ?? []);
        setEnabled(res.enabled ?? true);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDefinitionError(err instanceof Error ? err.message : "Failed to load definition");
        }
      });
    api
      .workflowYaml(selectedName)
      .then((text) => {
        if (!cancelled) setYamlText(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setYamlError(err instanceof Error ? err.message : "Failed to load YAML");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedName]);

  const selectedPhase = useMemo<WorkflowFullPhase | null>(() => {
    if (!definition || !selectedPhaseName) return null;
    return definition.phases.find((p) => p.name === selectedPhaseName) ?? null;
  }, [definition, selectedPhaseName]);

  const handleToggle = useCallback(async () => {
    if (!selectedName || toggleBusy) return;
    setToggleBusy(true);
    try {
      const res = await api.toggleWorkflow(selectedName);
      setEnabled(res.enabled);
      // Mirror into the sidebar so the badge updates without a refetch.
      setWorkflows((prev) =>
        prev.map((wf) => (wf.name === res.name ? { ...wf, enabled: res.enabled } : wf)),
      );
    } catch (err) {
      console.error("[workflows] toggle failed", err);
    } finally {
      setToggleBusy(false);
    }
  }, [selectedName, toggleBusy]);

  const listPane = (
    <div className="h-full bg-base-200/40 overflow-y-auto flex flex-col">
      {listError && (
        <div className="px-3 py-2 text-2xs text-error border-b border-hairline">{listError}</div>
      )}
      <ul className="flex-1">
        {workflows.map((wf) => {
          const active = wf.name === selectedName;
          return (
            <li key={wf.name} className="border-b border-hairline">
              <button
                onClick={() => setSelectedName(wf.name)}
                className={clsx(
                  "w-full flex flex-col items-start gap-0.5 py-2 px-3 text-left transition-colors",
                  active
                    ? "bg-primary/15 border-l-2 border-l-primary -ml-px pl-[10px]"
                    : "hover:bg-base-300/40 border-l-2 border-l-transparent -ml-px pl-[10px]",
                )}
              >
                <div className="flex items-center gap-2 w-full">
                  <span
                    className={clsx(
                      "text-sm font-mono truncate",
                      wf.enabled === false ? "text-faint line-through" : "text-strong",
                    )}
                  >
                    {wf.name}
                  </span>
                  {wf.enabled === false && (
                    <span className="ll-status badge text-error badge-xs font-mono">disabled</span>
                  )}
                  <span className="ml-auto badge badge-ghost badge-xs font-mono">{wf.kind}</span>
                </div>
                {wf.description && (
                  <span className="text-2xs text-muted line-clamp-2">{wf.description}</span>
                )}
                <div className="flex gap-2 items-center text-2xs text-faint font-mono">
                  <span>{wf.phaseCount} phases</span>
                  {wf.hasDag && <span className="text-info">dag</span>}
                  {wf.triggerKinds.length > 0 && (
                    <span className="ml-auto flex items-center gap-1">
                      {wf.triggerKinds.map((k) => (
                        <TriggerKindIcon key={k} kind={k} />
                      ))}
                    </span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
        {workflows.length === 0 && !listError && (
          <li className="p-6 text-center text-faint text-xs">no workflows</li>
        )}
      </ul>
    </div>
  );

  const diagramPane = (
    <div className="h-full min-h-0 flex flex-col">
      {definitionError ? (
        <div className="p-4 text-sm text-error border border-error/40 bg-error/5 rounded">
          {definitionError}
        </div>
      ) : (
        definition && (
          <WorkflowDefinitionDiagram
            definition={definition}
            selectedPhase={selectedPhaseName}
            onPhaseClick={(name) => {
              setSelectedPhaseName(name);
              // On a phone the diagram is covering everything else, and
              // clicking a phase is a request to read about it.
              if (narrow) setPane("phase");
            }}
            height="100%"
          />
        )
      )}
    </div>
  );

  /** The YAML the rest of this page is a rendering of. */
  const yamlPane = (
    <div className="h-full min-h-0 overflow-auto">
      {yamlError ? (
        <div className="p-4 text-sm text-error border border-error/40 bg-error/5 rounded">
          {yamlError}
        </div>
      ) : yamlText !== null ? (
        <CodeBlock code={yamlText} language="yaml" />
      ) : (
        <div className="p-4 text-xs text-faint">loading…</div>
      )}
    </div>
  );

  const phaseBox = selectedPhase ? (
    <PhaseDetailBox phase={selectedPhase} onClose={() => setSelectedPhaseName(null)} />
  ) : (
    <div className="h-full flex items-center justify-center text-faint text-xs p-6 text-center">
      click a phase to inspect it
    </div>
  );

  const contentBox = selectedPhase ? (
    <div className="h-full min-h-0 overflow-hidden flex flex-col">
      <PhaseContentView phase={selectedPhase} workflowName={selectedName ?? ""} />
    </div>
  ) : (
    <div className="h-full flex items-center justify-center text-faint text-xs p-6 text-center">
      click a phase to read its prompt or skill
    </div>
  );

  // Header — name & description on the left, triggers on the right so they
  // share vertical space instead of stacking.
  const detailHeader = (
          <div className="shrink-0 flex items-start gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-semibold text-base-content text-lg">{selectedName}</span>
                {definition && (
                  <span className="badge badge-ghost badge-sm font-mono">{definition.kind}</span>
                )}
                <label
                  className="ml-auto sm:ml-0 cursor-pointer flex items-center gap-2"
                  title={
                    enabled
                      ? "Disable this workflow — every trigger source (cron, webhooks, mentions, Slack) will be blocked. Persists across restarts."
                      : "Re-enable this workflow."
                  }
                >
                  <input
                    type="checkbox"
                    className="toggle toggle-sm toggle-success"
                    checked={enabled}
                    disabled={toggleBusy}
                    onChange={handleToggle}
                  />
                  <span
                    className={clsx(
                      "text-xs font-medium",
                      enabled ? "text-success" : "text-error",
                    )}
                  >
                    {enabled ? "enabled" : "disabled"}
                  </span>
                </label>
              </div>
              {definition?.description && (
                <p className="text-sm text-muted mt-1">{definition.description}</p>
              )}
              {!enabled && (
                <p className="text-2xs text-error/80 mt-1">
                  All triggers blocked. In-flight runs continue; new dispatches are skipped.
                </p>
              )}
            </div>
            {triggers.length > 0 && (
              <div className="shrink-0 max-w-[55%]">
                <TriggerList triggers={triggers} />
              </div>
            )}
          </div>
  );

  if (narrow) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <Tabs className="px-2 bg-base-200/40">
          {DEF_PANES.map((p) => (
            <TabButton key={p} active={pane === p} onClick={() => setPane(p)}>
              {DEF_PANE_LABEL[p]}
            </TabButton>
          ))}
        </Tabs>
        {pane === "workflows" ? (
          <div className="flex-1 min-h-0">{listPane}</div>
        ) : !selectedName ? (
          <div className="flex-1 flex items-center justify-center text-faint text-sm">
            select a workflow
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col p-3 gap-3">
            {detailHeader}
            <div className="flex-1 min-h-0">
              {pane === "diagram"
                ? diagramPane
                : pane === "phase"
                  ? phaseBox
                  : pane === "content"
                    ? contentBox
                    : yamlPane}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    // The wrapper, not the Split, is what `flex-1` sizes: the group sets its
    // own `height: 100%`, which only means anything against a parent whose
    // height is already resolved.
    <div className="flex-1 min-h-0">
    <Split id="ll-wf-defs" panelIds={["workflows", "detail"]}>
      <SplitPane
        id="workflows"
        defaultSize="18%"
        minSize="10%"
        className="border-r border-hairline"
      >
        {listPane}
      </SplitPane>
      <SplitHandle />
      <SplitPane id="detail" minSize="40%">
        {selectedName ? (
          <div className="h-full overflow-hidden flex flex-col p-4 gap-3 min-h-0 min-w-0">
            {detailHeader}
            {/* Two content columns, both tabbed. The centre is the workflow —
                the diagram and the YAML it renders — and the right is the
                phase you picked. Three columns of content was one too many to
                scan, so the source sits behind the picture rather than beside
                it. */}
            <div className="flex-1 min-h-0">
            <Split id="ll-wf-def-body" panelIds={["workflow", "phase"]}>
              <SplitPane id="workflow" defaultSize="55%" minSize="20%">
                <div className="flex flex-col h-full min-h-0 border border-hairline rounded bg-base-100 overflow-hidden">
                  <Tabs className="px-2">
                    <TabButton active={pane !== "yaml"} onClick={() => setPane("diagram")}>
                      Diagram
                    </TabButton>
                    <TabButton active={pane === "yaml"} onClick={() => setPane("yaml")}>
                      YAML
                    </TabButton>
                  </Tabs>
                  <div className="flex-1 min-h-0">
                    {pane === "yaml" ? yamlPane : diagramPane}
                  </div>
                </div>
              </SplitPane>
              {selectedPhase && (
                <>
                  <SplitHandle />
                  {/* ONE pane for the phase: its fields and its rendered
                      prompt are two readings of the same thing, so they are
                      tabs rather than another divider. */}
                  <SplitPane id="phase" defaultSize="45%" minSize="20%">
                    <div className="flex flex-col h-full min-h-0 border border-hairline rounded bg-base-100 overflow-hidden">
                      <Tabs className="px-2">
                        <TabButton active={phaseTab === "phase"} onClick={() => setPhaseTab("phase")}>
                          Phase
                        </TabButton>
                        <TabButton active={phaseTab === "content"} onClick={() => setPhaseTab("content")}>
                          Content
                        </TabButton>
                      </Tabs>
                      <div className="flex-1 min-h-0">
                        {phaseTab === "content" ? contentBox : phaseBox}
                      </div>
                    </div>
                  </SplitPane>
                </>
              )}
            </Split>
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-faint text-sm">
            select a workflow
          </div>
        )}
      </SplitPane>
    </Split>
    </div>
  );
}

// ── Phase metadata box ─────────────────────────────────────────────────

interface PhaseDetailBoxProps {
  phase: WorkflowFullPhase;
  onClose: () => void;
}

/**
 * Render a single field row inside a `dl` grid. Long values wrap; multi-line
 * strings (templates with `{{…}}`) keep their newlines.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="wrap-break-word whitespace-pre-wrap min-w-0">{children}</dd>
    </>
  );
}

/**
 * Sub-grid used for nested objects (loop, generic_loop, messages, on_output
 * rules). Same column structure as the outer grid but slightly dimmed.
 */
function SubGrid({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 pl-2 border-l border-hairline ml-1 mt-0.5">
      {children}
    </dl>
  );
}

function PhaseDetailBox({ phase, onClose }: PhaseDetailBoxProps) {
  const messageEntries = phase.messages ? Object.entries(phase.messages) : [];
  const loopMessageEntries = phase.loop?.messages ? Object.entries(phase.loop.messages) : [];

  return (
    <div className="bg-base-100 p-3 text-xs h-full overflow-auto">
      <div className="flex items-center gap-2 mb-2 sticky top-0 bg-base-100 pb-1 z-10">
        <span className="font-semibold text-sm">{phase.label ?? phase.name}</span>
        {phase.label && phase.label !== phase.name && (
          <span className="text-2xs text-muted font-mono">{phase.name}</span>
        )}
        <span className="badge badge-ghost badge-xs ml-auto">{phase.type}</span>
        <button className="btn btn-xs btn-ghost btn-square" onClick={onClose} title="close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-2xs">
        <Field label="name">{phase.name}</Field>
        {phase.label && <Field label="label">{phase.label}</Field>}
        <Field label="type">{phase.type}</Field>
        {phaseSkillNames(phase).length > 0 && (
          <Field label={phaseSkillNames(phase).length > 1 ? "skills" : "skill"}>
            {phaseSkillNames(phase).join(", ")}
          </Field>
        )}
        {phase.prompt && <Field label="prompt">{phase.prompt}</Field>}
        {phase.command && <Field label="command">{phase.command}</Field>}
        {phase.runtime && <Field label="runtime">{phase.runtime}</Field>}
        {phase.script && (
          <Field label="script">
            <pre className="whitespace-pre-wrap break-all">{phase.script}</pre>
          </Field>
        )}
        {phase.timeout_seconds !== undefined && (
          <Field label="timeout_seconds">{phase.timeout_seconds}</Field>
        )}
        {phase.model && <Field label="model">{phase.model}</Field>}
        {phase.approval_gate && <Field label="approval_gate">{phase.approval_gate}</Field>}
        {phase.approval_gate_message && (
          <Field label="approval_gate_message">{phase.approval_gate_message}</Field>
        )}
        {phase.depends_on && phase.depends_on.length > 0 && (
          <Field label="depends_on">{phase.depends_on.join(", ")}</Field>
        )}
        {phase.trigger_rule && <Field label="trigger_rule">{phase.trigger_rule}</Field>}
        {phase.output_var && <Field label="output_var">{phase.output_var}</Field>}
        {phase.on_success?.set_phase && (
          <Field label="on_success.set_phase">{phase.on_success.set_phase}</Field>
        )}

        {messageEntries.length > 0 && (
          <Field label="messages">
            <SubGrid>
              {messageEntries.map(([k, v]) => (
                <Field key={k} label={k}>
                  {v}
                </Field>
              ))}
            </SubGrid>
          </Field>
        )}

        {phase.loop && (
          <Field label="loop">
            <SubGrid>
              <Field label="max_cycles">{phase.loop.max_cycles}</Field>
              <Field label="fix_prompt">{phase.loop.on_request_changes.fix_prompt}</Field>
              {phase.loop.on_request_changes.fix_model && (
                <Field label="fix_model">{phase.loop.on_request_changes.fix_model}</Field>
              )}
              <Field label="re_review_prompt">{phase.loop.on_request_changes.re_review_prompt}</Field>
              {phase.loop.approval_gate && (
                <Field label="approval_gate">{phase.loop.approval_gate}</Field>
              )}
              {loopMessageEntries.length > 0 && (
                <Field label="messages">
                  <SubGrid>
                    {loopMessageEntries.map(([k, v]) => (
                      <Field key={k} label={k}>
                        {v}
                      </Field>
                    ))}
                  </SubGrid>
                </Field>
              )}
            </SubGrid>
          </Field>
        )}

        {phase.generic_loop && (
          <Field label="generic_loop">
            <SubGrid>
              <Field label="max_iterations">{phase.generic_loop.max_iterations}</Field>
              {phase.generic_loop.until && <Field label="until">{phase.generic_loop.until}</Field>}
              {phase.generic_loop.until_bash && (
                <Field label="until_bash">{phase.generic_loop.until_bash}</Field>
              )}
              {phase.generic_loop.interactive !== undefined && (
                <Field label="interactive">{String(phase.generic_loop.interactive)}</Field>
              )}
              {phase.generic_loop.gate_kind && (
                <Field label="gate_kind">{phase.generic_loop.gate_kind}</Field>
              )}
              {phase.generic_loop.gate_message && (
                <Field label="gate_message">{phase.generic_loop.gate_message}</Field>
              )}
              {phase.generic_loop.scratch_key && (
                <Field label="scratch_key">{phase.generic_loop.scratch_key}</Field>
              )}
              {phase.generic_loop.fresh_context !== undefined && (
                <Field label="fresh_context">{String(phase.generic_loop.fresh_context)}</Field>
              )}
            </SubGrid>
          </Field>
        )}

        {phase.on_output && (
          <Field label="on_output">
            <SubGrid>
              {(["contains_BLOCKED", "contains_READY"] as const).map((k) => {
                const rule = phase.on_output?.[k];
                if (!rule) return null;
                return (
                  <Field key={k} label={k}>
                    <SubGrid>
                      <Field label="action">{rule.action}</Field>
                      {rule.message && <Field label="message">{rule.message}</Field>}
                      {rule.unless_label && (
                        <Field label="unless_label">{rule.unless_label}</Field>
                      )}
                      {rule.unless_title_matches && (
                        <Field label="unless_title_matches">{rule.unless_title_matches}</Field>
                      )}
                      {rule.bypass_message && (
                        <Field label="bypass_message">{rule.bypass_message}</Field>
                      )}
                    </SubGrid>
                  </Field>
                );
              })}
            </SubGrid>
          </Field>
        )}
      </dl>
    </div>
  );
}

// ── Phase content view (rendered markdown) ────────────────────────────

interface ContentSource {
  key: string;
  label: string;
  kind: "skill" | "prompt";
  /** For skills, the skill name. For prompts, the prompt path relative to workflowDir. */
  ref: string;
}

interface PhaseContentViewProps {
  phase: WorkflowFullPhase;
  workflowName: string;
}

/**
 * Lists every prompt/skill referenced by the selected phase, fetches the
 * current selection's content, and renders it as formatted markdown. Loop
 * phases reference up to three prompts (primary reviewer + fix + re-review)
 * and surface as small tabs above the rendered body.
 */
function PhaseContentView({ phase, workflowName }: PhaseContentViewProps) {
  const sources = useMemo<ContentSource[]>(() => {
    const out: ContentSource[] = [];
    for (const skill of phaseSkillNames(phase)) {
      out.push({ key: `skill:${skill}`, label: `skill: ${skill}`, kind: "skill", ref: skill });
    }
    if (phase.prompt) {
      out.push({ key: `prompt:${phase.prompt}`, label: phase.prompt, kind: "prompt", ref: phase.prompt });
    }
    if (phase.loop?.on_request_changes.fix_prompt) {
      const p = phase.loop.on_request_changes.fix_prompt;
      out.push({ key: `prompt:${p}`, label: `fix: ${p}`, kind: "prompt", ref: p });
    }
    if (phase.loop?.on_request_changes.re_review_prompt) {
      const p = phase.loop.on_request_changes.re_review_prompt;
      out.push({ key: `prompt:${p}`, label: `re-review: ${p}`, kind: "prompt", ref: p });
    }
    return out;
  }, [phase]);

  const [activeKey, setActiveKey] = useState<string | null>(sources[0]?.key ?? null);
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Reset to the first source whenever the phase changes.
  useEffect(() => {
    setActiveKey(sources[0]?.key ?? null);
  }, [sources]);

  const active = sources.find((s) => s.key === activeKey) ?? null;

  // Fetch the content for the active source.
  useEffect(() => {
    if (!active) {
      setBody(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setBody(null);
    setError(null);
    setLoading(true);
    const promise =
      active.kind === "skill"
        ? api.skill(active.ref)
        : api.workflowPrompt(workflowName, active.ref);
    promise
      .then((text) => {
        if (cancelled) return;
        setBody(text);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load content");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, workflowName]);

  if (sources.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-2xs text-faint border border-hairline rounded bg-base-200/30">
        this phase has no skill or prompt
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 border border-hairline rounded bg-base-100 overflow-hidden">
      {/* Source tabs (only when there's more than one) */}
      {sources.length > 1 && (
        <div className="flex gap-1 border-b border-hairline px-2 shrink-0">
          {sources.map((s) => (
            <button
              key={s.key}
              onClick={() => setActiveKey(s.key)}
              className={clsx(
                "px-2 py-1 text-2xs font-mono border-b-2 -mb-px transition-colors",
                s.key === activeKey
                  ? "border-primary text-primary"
                  : "border-transparent text-muted hover:text-base-content",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0">
        {loading && <div className="text-faint text-sm p-3">loading…</div>}
        {error && (
          <div className="m-3 text-sm text-error border border-error/40 bg-error/5 rounded p-3">
            {error}
          </div>
        )}
        {body !== null && <CodeBlock code={body} language="markdown" />}
      </div>
    </div>
  );
}

// ── Trigger surfaces ───────────────────────────────────────────────────

const TRIGGER_KIND_META: Record<
  TriggerKind,
  { label: string; Icon: typeof Clock; tone: string; sigil: string }
> = {
  cron: { label: "cron", Icon: Clock, tone: "text-info", sigil: "⏰" },
  github: { label: "GitHub event", Icon: Code2, tone: "text-success", sigil: "🪝" },
  mention: { label: "@mention", Icon: AtSign, tone: "text-warning", sigil: "@" },
  slack: {
    label: "Slack command",
    Icon: MessagesSquare,
    tone: "text-secondary",
    sigil: "/",
  },
  internal: { label: "internal chain", Icon: RefreshCw, tone: "text-muted", sigil: "↻" },
};

/** Tiny icon used in the workflow list to summarise trigger types at a glance. */
function TriggerKindIcon({ kind }: { kind: TriggerKind }) {
  const meta = TRIGGER_KIND_META[kind];
  return (
    <span title={meta.label} className={clsx("inline-flex items-center", meta.tone)}>
      <meta.Icon className="w-3 h-3" />
    </span>
  );
}

/**
 * Full trigger list shown under the workflow header. Cron rows include the
 * schedule; GitHub/Slack rows include the event/command identifier.
 */
function TriggerList({ triggers }: { triggers: TriggerInfo[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs font-semibold uppercase tracking-wider text-muted">
        Triggered by
      </span>
      <ul className="flex flex-col gap-0.5 text-2xs">
        {triggers.map((t, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className="mt-0.5">
              <TriggerKindIcon kind={t.kind} />
            </span>
            <TriggerLine trigger={t} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TriggerLine({ trigger }: { trigger: TriggerInfo }) {
  switch (trigger.kind) {
    case "cron":
      return (
        <span>
          <span className="font-mono text-info">{trigger.schedule}</span>{" "}
          <span className="text-muted">— cron `{trigger.name}`</span>
        </span>
      );
    case "github":
      return (
        <span>
          <span className="font-mono text-success">{trigger.event}</span>{" "}
          <span className="text-muted">— {trigger.description}</span>
        </span>
      );
    case "slack":
      return (
        <span>
          <span className="font-mono text-secondary">/{trigger.command}</span>{" "}
          <span className="text-muted">— {trigger.description}</span>
        </span>
      );
    case "mention":
    case "internal":
      return <span className="text-strong">{trigger.description}</span>;
  }
}
