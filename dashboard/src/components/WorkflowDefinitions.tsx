import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { XMarkIcon } from "@heroicons/react/24/outline";
import {
  api,
  type WorkflowSummary,
  type WorkflowFullDefinition,
  type WorkflowFullPhase,
  type TriggerInfo,
  type TriggerKind,
} from "../api";
import {
  ClockIcon,
  CodeBracketIcon,
  AtSymbolIcon,
  ChatBubbleLeftRightIcon,
  ArrowPathIcon,
  NoSymbolIcon,
} from "@heroicons/react/24/outline";
import { CodeBlock } from "./timeline/CodeBlock";
import {
  useUrlState,
  nullableStringParser,
  nullableStringSerializer,
  enumParser,
  enumSerializer,
} from "../hooks/useUrlState";
import { WorkflowDefinitionDiagram } from "./WorkflowDefinitionDiagram";

type ViewTab = "diagram" | "yaml";
const VIEW_TABS = ["diagram", "yaml"] as const;

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
  const [view, setView] = useUrlState<ViewTab>(
    "wfview",
    "diagram",
    enumParser(VIEW_TABS, "diagram"),
    enumSerializer<ViewTab>("diagram"),
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

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* List panel */}
      <aside className="w-72 shrink-0 border-r border-base-300 bg-base-200/40 overflow-y-auto flex flex-col">
        {listError && (
          <div className="px-3 py-2 text-2xs text-error border-b border-base-300">{listError}</div>
        )}
        <ul className="flex-1">
          {workflows.map((wf) => {
            const active = wf.name === selectedName;
            return (
              <li key={wf.name} className="border-b border-base-300/40">
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
                        wf.enabled === false ? "text-base-content/40 line-through" : "text-base-content/90",
                      )}
                    >
                      {wf.name}
                    </span>
                    {wf.enabled === false && (
                      <span className="badge badge-error badge-xs font-mono">disabled</span>
                    )}
                    <span className="ml-auto badge badge-ghost badge-xs font-mono">{wf.kind}</span>
                  </div>
                  {wf.description && (
                    <span className="text-2xs text-base-content/50 line-clamp-2">{wf.description}</span>
                  )}
                  <div className="flex gap-2 items-center text-2xs text-base-content/40 font-mono">
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
            <li className="p-6 text-center text-base-content/40 text-xs">no workflows</li>
          )}
        </ul>
      </aside>

      {/* Detail panel */}
      {selectedName ? (
        <div className="flex-1 overflow-hidden flex flex-col p-4 gap-3 min-h-0">
          {/* Header — name & description on the left, triggers on the right
              so they share vertical space instead of stacking. */}
          <div className="shrink-0 flex items-start gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-semibold text-base-content text-lg">{selectedName}</span>
                {definition && (
                  <span className="badge badge-ghost badge-sm font-mono">{definition.kind}</span>
                )}
                {!enabled && (
                  <span className="badge badge-error badge-sm gap-1">
                    <NoSymbolIcon className="w-3 h-3" />
                    disabled
                  </span>
                )}
                <button
                  onClick={handleToggle}
                  disabled={toggleBusy}
                  className={clsx(
                    "btn btn-xs",
                    enabled ? "btn-outline btn-error" : "btn-success",
                  )}
                  title={
                    enabled
                      ? "Disable this workflow — every trigger source (cron, webhooks, mentions, Slack) will be blocked. Persists across restarts."
                      : "Re-enable this workflow."
                  }
                >
                  {enabled ? "Disable" : "Enable"}
                </button>
              </div>
              {definition?.description && (
                <p className="text-sm text-base-content/60 mt-1">{definition.description}</p>
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

          {/* View tabs */}
          <div className="flex gap-1 border-b border-base-300 shrink-0">
            {VIEW_TABS.map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={clsx(
                  "px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors",
                  view === v
                    ? "border-primary text-primary"
                    : "border-transparent text-base-content/60 hover:text-base-content",
                )}
              >
                {v === "diagram" ? "Diagram" : "YAML"}
              </button>
            ))}
          </div>

          {/* View body */}
          <div className="flex-1 overflow-hidden min-h-0">
            {view === "diagram" && definitionError && (
              <div className="p-4 text-sm text-error border border-error/40 bg-error/5 rounded">
                {definitionError}
              </div>
            )}
            {view === "diagram" && definition && (
              <DiagramView
                definition={definition}
                workflowName={selectedName}
                selectedPhaseName={selectedPhaseName}
                onPhaseClick={setSelectedPhaseName}
                onClearPhase={() => setSelectedPhaseName(null)}
                selectedPhase={selectedPhase}
              />
            )}
            {view === "yaml" && yamlError && (
              <div className="p-4 text-sm text-error border border-error/40 bg-error/5 rounded">
                {yamlError}
              </div>
            )}
            {view === "yaml" && yamlText !== null && (
              <div className="h-full overflow-auto">
                <CodeBlock code={yamlText} language="yaml" />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-base-content/30 text-sm">
          select a workflow
        </div>
      )}
    </div>
  );
}

// ── Resizable diagram view (3 vertical sections) ───────────────────────

interface DiagramViewProps {
  definition: WorkflowFullDefinition;
  workflowName: string;
  selectedPhaseName: string | null;
  selectedPhase: WorkflowFullPhase | null;
  onPhaseClick: (name: string) => void;
  onClearPhase: () => void;
}

const MIN_SECTION_HEIGHT = 80;
const DIVIDER_HEIGHT = 8;

/**
 * Default split — small diagram (typically one row of nodes), same-size phase
 * info, larger markdown section since prompts/skills are usually multi-page.
 */
const DEFAULT_RATIOS: [number, number, number] = [0.2, 0.2, 0.6];
const RATIOS_STORAGE_KEY = "lastlight-wf-def-ratios";

/** Read the persisted ratios, falling back to the default if anything is off. */
function loadRatios(): [number, number, number] {
  if (typeof window === "undefined") return DEFAULT_RATIOS;
  try {
    const raw = window.localStorage.getItem(RATIOS_STORAGE_KEY);
    if (!raw) return DEFAULT_RATIOS;
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((v) => typeof v === "number" && v > 0 && v < 1)
    ) {
      const sum = (parsed[0] as number) + (parsed[1] as number) + (parsed[2] as number);
      if (Math.abs(sum - 1) < 0.05) {
        return [parsed[0] as number, parsed[1] as number, parsed[2] as number];
      }
    }
  } catch {
    /* ignore — fall through to default */
  }
  return DEFAULT_RATIOS;
}

function saveRatios(ratios: [number, number, number]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RATIOS_STORAGE_KEY, JSON.stringify(ratios));
  } catch {
    /* localStorage may be disabled — ignore */
  }
}

/**
 * Diagram + (when a phase is selected) phase details + rendered prompt/skill,
 * stacked vertically with two draggable horizontal dividers between them.
 *
 * Heights are stored as ratios (sum = 1) of the available section space (the
 * container height minus divider heights). Storing ratios — instead of px —
 * keeps the layout sensible across window resizes without needing a
 * ResizeObserver.
 */
function DiagramView({
  definition,
  workflowName,
  selectedPhaseName,
  selectedPhase,
  onPhaseClick,
  onClearPhase,
}: DiagramViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState(0);

  // Persisted across reloads: the user's last divider positions feel personal
  // (like the message-feed sort order), so we store and restore them.
  const [ratios, setRatios] = useState<[number, number, number]>(loadRatios);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const showPhaseSections = !!selectedPhase;
  const dividerCount = showPhaseSections ? 2 : 0;
  const usableH = Math.max(0, containerH - dividerCount * DIVIDER_HEIGHT);

  const heights = useMemo<[number, number, number]>(() => {
    if (!showPhaseSections) return [usableH, 0, 0];
    return [
      Math.max(MIN_SECTION_HEIGHT, ratios[0] * usableH),
      Math.max(MIN_SECTION_HEIGHT, ratios[1] * usableH),
      Math.max(MIN_SECTION_HEIGHT, ratios[2] * usableH),
    ];
  }, [showPhaseSections, ratios, usableH]);

  // Drag handler for either divider. `which` is 0 for the divider between
  // section 0 and 1, and 1 for the one between 1 and 2.
  const onDragStart = useCallback(
    (which: 0 | 1) => (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatios: [number, number, number] = [ratios[0], ratios[1], ratios[2]];
      const total = usableH;
      if (total <= 0) return;

      let lastRatios = startRatios;
      const onMove = (ev: MouseEvent) => {
        const deltaPx = ev.clientY - startY;
        const deltaR = deltaPx / total;
        // Clamp so neither neighbour drops below the minimum ratio.
        const minR = MIN_SECTION_HEIGHT / total;
        let r0 = startRatios[0];
        let r1 = startRatios[1];
        let r2 = startRatios[2];
        if (which === 0) {
          r0 = Math.max(minR, Math.min(startRatios[0] + startRatios[1] - minR, startRatios[0] + deltaR));
          r1 = startRatios[0] + startRatios[1] - r0;
        } else {
          r1 = Math.max(minR, Math.min(startRatios[1] + startRatios[2] - minR, startRatios[1] + deltaR));
          r2 = startRatios[1] + startRatios[2] - r1;
        }
        lastRatios = [r0, r1, r2];
        setRatios(lastRatios);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // Persist only on drag end — saving on every mousemove would write to
        // localStorage at frame rate.
        saveRatios(lastRatios);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [ratios, usableH],
  );

  return (
    <div ref={containerRef} className="flex flex-col h-full min-h-0">
      {/* Section 1: diagram */}
      <div
        className="overflow-hidden"
        style={{ height: showPhaseSections ? heights[0] : "100%" }}
      >
        <WorkflowDefinitionDiagram
          definition={definition}
          selectedPhase={selectedPhaseName}
          onPhaseClick={onPhaseClick}
          height="100%"
        />
      </div>

      {showPhaseSections && (
        <>
          <ResizeDivider onMouseDown={onDragStart(0)} />

          {/* Section 2: phase metadata. The PhaseDetailBox owns its own
              scroll so the sticky header binds to that scroll container —
              don't add a second overflow here, otherwise sticky misbinds. */}
          <div style={{ height: heights[1] }} className="min-h-0">
            <PhaseDetailBox phase={selectedPhase!} onClose={onClearPhase} />
          </div>

          <ResizeDivider onMouseDown={onDragStart(1)} />

          {/* Section 3: rendered prompt/skill */}
          <div className="overflow-hidden flex flex-col" style={{ height: heights[2] }}>
            <PhaseContentView phase={selectedPhase!} workflowName={workflowName} />
          </div>
        </>
      )}
    </div>
  );
}

interface ResizeDividerProps {
  onMouseDown: (e: React.MouseEvent) => void;
}

function ResizeDivider({ onMouseDown }: ResizeDividerProps) {
  return (
    <div
      role="separator"
      className="shrink-0 flex items-center justify-center cursor-row-resize group"
      style={{ height: DIVIDER_HEIGHT }}
      onMouseDown={onMouseDown}
    >
      <div className="w-12 h-1 rounded-full bg-base-300 group-hover:bg-primary/50 transition-colors" />
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
      <dt className="text-base-content/50">{label}</dt>
      <dd className="break-words whitespace-pre-wrap min-w-0">{children}</dd>
    </>
  );
}

/**
 * Sub-grid used for nested objects (loop, generic_loop, messages, on_output
 * rules). Same column structure as the outer grid but slightly dimmed.
 */
function SubGrid({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 pl-2 border-l border-base-300/60 ml-1 mt-0.5">
      {children}
    </dl>
  );
}

function PhaseDetailBox({ phase, onClose }: PhaseDetailBoxProps) {
  const messageEntries = phase.messages ? Object.entries(phase.messages) : [];
  const loopMessageEntries = phase.loop?.messages ? Object.entries(phase.loop.messages) : [];

  return (
    <div className="border border-base-300 rounded bg-base-100 p-3 text-xs h-full overflow-auto">
      <div className="flex items-center gap-2 mb-2 sticky top-0 bg-base-100 pb-1 z-10">
        <span className="font-semibold text-sm">{phase.label ?? phase.name}</span>
        {phase.label && phase.label !== phase.name && (
          <span className="text-2xs text-base-content/50 font-mono">{phase.name}</span>
        )}
        <span className="badge badge-ghost badge-xs ml-auto">{phase.type}</span>
        <button className="btn btn-xs btn-ghost btn-square" onClick={onClose} title="close">
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-2xs">
        <Field label="name">{phase.name}</Field>
        {phase.label && <Field label="label">{phase.label}</Field>}
        <Field label="type">{phase.type}</Field>
        {phase.skill && <Field label="skill">{phase.skill}</Field>}
        {phase.prompt && <Field label="prompt">{phase.prompt}</Field>}
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
    if (phase.skill) {
      out.push({ key: `skill:${phase.skill}`, label: `skill: ${phase.skill}`, kind: "skill", ref: phase.skill });
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
      <div className="flex-1 flex items-center justify-center text-2xs text-base-content/40 border border-base-300/60 rounded bg-base-200/30">
        this phase has no skill or prompt
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 border border-base-300 rounded bg-base-100 overflow-hidden">
      {/* Source tabs (only when there's more than one) */}
      {sources.length > 1 && (
        <div className="flex gap-1 border-b border-base-300 px-2 shrink-0">
          {sources.map((s) => (
            <button
              key={s.key}
              onClick={() => setActiveKey(s.key)}
              className={clsx(
                "px-2 py-1 text-2xs font-mono border-b-2 -mb-px transition-colors",
                s.key === activeKey
                  ? "border-primary text-primary"
                  : "border-transparent text-base-content/60 hover:text-base-content",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0">
        {loading && <div className="text-base-content/40 text-sm p-3">loading…</div>}
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
  { label: string; Icon: typeof ClockIcon; tone: string; sigil: string }
> = {
  cron: { label: "cron", Icon: ClockIcon, tone: "text-info", sigil: "⏰" },
  github: { label: "GitHub event", Icon: CodeBracketIcon, tone: "text-success", sigil: "🪝" },
  mention: { label: "@mention", Icon: AtSymbolIcon, tone: "text-warning", sigil: "@" },
  slack: {
    label: "Slack command",
    Icon: ChatBubbleLeftRightIcon,
    tone: "text-secondary",
    sigil: "/",
  },
  internal: { label: "internal chain", Icon: ArrowPathIcon, tone: "text-base-content/60", sigil: "↻" },
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
      <span className="text-2xs font-semibold uppercase tracking-wider text-base-content/50">
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
          <span className="text-base-content/50">— cron `{trigger.name}`</span>
        </span>
      );
    case "github":
      return (
        <span>
          <span className="font-mono text-success">{trigger.event}</span>{" "}
          <span className="text-base-content/60">— {trigger.description}</span>
        </span>
      );
    case "slack":
      return (
        <span>
          <span className="font-mono text-secondary">/{trigger.command}</span>{" "}
          <span className="text-base-content/60">— {trigger.description}</span>
        </span>
      );
    case "mention":
    case "internal":
      return <span className="text-base-content/70">{trigger.description}</span>;
  }
}
