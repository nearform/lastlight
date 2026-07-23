import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  type ReactFlowInstance,
  Background,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  api,
  UnauthorizedError,
  type RouteGraphResponse,
  type RouteTestRequest,
  type RouteTestResponse,
} from "../api";
import { routerNodeTypes, type RouterNodeData } from "./router-node";

const nodeTypes = routerNodeTypes;

const NODE_WIDTH = 196;
const COL_GAP = 96;
const ROW_HEIGHT = 60;
const COL_X = (col: number) => col * (NODE_WIDTH + COL_GAP);
const COLUMNS = ["input", "event", "router", "handler"] as const;

const GREY_EDGE = { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 } as const;
// Once a route is triggered we recede the non-matched fan-out so the hot path
// isn't lost in the clutter of every possible router→handler edge.
const FAINT_EDGE = { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1, strokeOpacity: 0.35 } as const;
const HOT_EDGE = { stroke: "var(--color-primary, #6419e6)", strokeWidth: 3 } as const;

const CHECKS_STATES = ["", "passing", "failing", "pending", "none"] as const;
const ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"] as const;

type FormState = {
  body: string;
  title: string;
  sender: string;
  repo: string;
  issueNumber: string;
  isPullRequest: boolean;
  prAuthor: string;
  checksState: string;
  labels: string;
  authorAssociation: string;
};

const EMPTY_FORM: FormState = {
  body: "",
  title: "",
  sender: "playground-user",
  repo: "cliftonc/drizby",
  issueNumber: "",
  isPullRequest: false,
  prAuthor: "",
  checksState: "",
  labels: "",
  authorAssociation: "OWNER",
};

/**
 * Which form fields make sense for a given event, mirroring where each field
 * comes from in production: GitHub webhooks carry the repo / issue / title /
 * author-association; a Slack message carries none of that — the classifier
 * (and `extractGithubRefFromText`) parse the repo + issue out of the message
 * text itself, so those fields are hidden and instead surfaced in the result.
 */
function fieldsFor(input: "github" | "slack", type: string) {
  const isSlack = input === "slack";
  const isChecks = type === "pr.checks_failed" || type === "pr.checks_passed";
  const isComment = type === "comment.created" || type === "pr_review.submitted";
  const isIssue = type.startsWith("issue");
  return {
    slack: isSlack,
    checks: isChecks,
    body: !isChecks, // checks events carry no free text
    // Title matters even for checks events — the pr.checks_failed classifier
    // recognises a Dependabot bump largely from its title ("Bump X from Y to Z").
    title: !isSlack,
    repo: !isSlack, // webhook provides it; Slack parses it from the message
    number: !isSlack && !isChecks,
    authorAssociation: !isSlack && (isComment || isIssue),
    prToggle: !isSlack && isComment, // a comment may be on an issue or a PR
    // Only GitHub *comments* gate on an @mention. `issue.opened` is also
    // classifier-routed, but it classifies the issue title/body directly — no
    // mention required — so the "@-mention" affordances key off this, not the
    // deterministic/classifier tag (which they used to conflate).
    mention: !isSlack && isComment,
    labels: !isSlack && (isIssue || type === "pr.opened"),
  };
}

export function RouterPlayground() {
  const [graph, setGraph] = useState<RouteGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedInput, setSelectedInput] = useState<"github" | "slack">("github");
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [result, setResult] = useState<RouteTestResponse | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .routeGraph()
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) return; // handled globally
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const eventType = useMemo(
    () => graph?.eventTypes.find((e) => e.type === selectedType && e.input === selectedInput) ?? null,
    [graph, selectedType, selectedInput],
  );
  const fields = useMemo(
    () => (selectedType ? fieldsFor(selectedInput, selectedType) : null),
    [selectedInput, selectedType],
  );

  const selectEvent = useCallback((type: string) => {
    setSelectedType(type);
    setResult(null);
    setTriggerError(null);
  }, []);
  const selectInput = useCallback((input: "github" | "slack") => {
    setSelectedInput(input);
    setSelectedType(null);
    setResult(null);
    setTriggerError(null);
  }, []);

  const onTrigger = useCallback(async () => {
    if (!selectedType || !fields) return;
    setTriggering(true);
    setTriggerError(null);
    setResult(null);
    const onPr =
      selectedType === "pr.checks_failed" ||
      selectedType === "pr.checks_passed" ||
      selectedType === "pr_review.submitted" ||
      selectedType.startsWith("pr.") ||
      (fields.prToggle && form.isPullRequest);
    const req: RouteTestRequest = {
      source: selectedInput,
      type: selectedType,
      body: form.body,
      title: fields.title && form.title ? form.title : undefined,
      sender: form.sender || undefined,
      repo: fields.repo && form.repo ? form.repo : undefined,
      issueNumber: fields.number && form.issueNumber ? Number(form.issueNumber) : undefined,
      isPullRequest: onPr || undefined,
      prAuthor: onPr && form.prAuthor ? form.prAuthor : undefined,
      checksState: onPr && form.checksState ? form.checksState : undefined,
      labels: fields.labels && form.labels
        ? form.labels.split(",").map((l) => l.trim()).filter(Boolean)
        : undefined,
      authorAssociation: fields.authorAssociation ? form.authorAssociation : undefined,
    };
    try {
      setResult(await api.routeTest(req));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setTriggerError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggering(false);
    }
  }, [selectedType, selectedInput, form, fields]);

  const matchedHandler =
    result && result.route.action === "handler" ? result.route.handler : undefined;

  // ── Graph model ────────────────────────────────────────────────────────────
  // Everything funnels through the Router node (routeEvent IS the router — it
  // decides deterministic events too), so no edge ever crosses over it. We only
  // render handlers that are actual routing targets, plus the just-matched one.
  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node<RouterNodeData>[], edges: [] as Edge[] };

    const evts = graph.eventTypes.filter((e) => e.input === selectedInput);

    const targets = new Set<string>();
    for (const e of graph.deterministicEdges) targets.add(e.to);
    for (const e of graph.intentEdges) targets.add(e.to);
    if (matchedHandler) targets.add(matchedHandler);
    const handlers = graph.handlers.filter((h) => targets.has(h.name));
    if (matchedHandler && !handlers.some((h) => h.name === matchedHandler)) {
      handlers.push({ name: matchedHandler, kind: "workflow" });
    }
    handlers.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "workflow" ? -1 : 1,
    );

    // The node ids that make up the just-triggered "hot path". When a result is
    // present, every node NOT in this set recedes (dimmed) so the route pops.
    const hotPath = new Set<string>();
    if (result && selectedType) {
      hotPath.add(`input:${selectedInput}`);
      hotPath.add(`event:${selectedType}`);
      hotPath.add("router");
      if (matchedHandler) hotPath.add(`handler:${matchedHandler}`);
      else if (result.route.action !== "handler") hotPath.add(`terminal:${result.route.action}`);
    }
    const hasResult = hotPath.size > 0;
    const stateFor = (id: string) => ({
      matched: hotPath.has(id),
      dimmed: hasResult && !hotPath.has(id),
    });

    // The two fall-through outcomes (ignore / reply) are ALWAYS shown as fixed
    // endpoints at the bottom of the handler column — they're permanent router
    // outcomes, so the column always reserves two extra slots for them and the
    // relevant one lights up when a route falls through.
    const TERMINALS = [
      { action: "ignore" as const, label: "Ignored", subtitle: "dropped — no reply" },
      { action: "reply" as const, label: "Replied", subtitle: "canned reply posted" },
    ];
    const handlerRows = handlers.length + TERMINALS.length;

    // Vertically centre every column around the tallest one's midline so the
    // Router lines up with the fan-out centre and the graph reads symmetric.
    const maxCount = Math.max(graph.inputs.length, evts.length, 1, handlerRows);
    const centerY = ((maxCount - 1) / 2) * ROW_HEIGHT;
    const yFor = (i: number, n: number) => centerY + (i - (n - 1) / 2) * ROW_HEIGHT;

    const nodes: Node<RouterNodeData>[] = [];
    const edges: Edge[] = [];
    const node = (
      id: string,
      col: number,
      y: number,
      data: Omit<RouterNodeData, "column"> & { column?: RouterNodeData["column"] },
    ): Node<RouterNodeData> => ({
      id,
      type: "routerNode",
      position: { x: COL_X(col), y },
      data: { ...data, column: data.column ?? COLUMNS[col] } as RouterNodeData,
      draggable: false,
      style: { width: NODE_WIDTH },
    });

    // Edges recede to a faint hairline once a route is triggered — the hot
    // overlay edges below carry the eye instead.
    const baseEdge = (id: string, source: string, target: string): Edge => ({
      id,
      source,
      target,
      sourceHandle: "right",
      targetHandle: "left",
      style: hasResult ? FAINT_EDGE : GREY_EDGE,
    });

    // col 0 — inputs (clickable selectors)
    graph.inputs.forEach((inp, i) => {
      nodes.push(
        node(`input:${inp.id}`, 0, yFor(i, graph.inputs.length), {
          label: inp.label,
          variant: inp.id === "slack" ? "slack" : "github",
          selected: inp.id === selectedInput,
          ...stateFor(`input:${inp.id}`),
        }),
      );
    });

    // col 1 — event types for the selected input → Router
    evts.forEach((e, i) => {
      const id = `event:${e.type}`;
      nodes.push(
        node(id, 1, yFor(i, evts.length), {
          label: e.type,
          variant: e.routing === "classifier" ? "classifier" : "deterministic",
          subtitle: e.routing,
          selected: e.type === selectedType,
          ...stateFor(id),
        }),
      );
      edges.push(baseEdge(`e:input->${e.type}`, `input:${selectedInput}`, id));
      edges.push(baseEdge(`e:${e.type}->router`, id, "router"));
    });

    // col 2 — the router
    nodes.push(
      node("router", 2, centerY, {
        label: "Router",
        variant: "router",
        subtitle: "routeEvent",
        ...stateFor("router"),
      }),
    );

    // col 3 — handlers (routing targets only)
    handlers.forEach((h, i) => {
      const id = `handler:${h.name}`;
      nodes.push(
        node(id, 3, yFor(i, handlerRows), {
          label: h.name,
          variant: h.kind === "in-process" ? "in-process" : "workflow",
          subtitle: h.claimedIntent ?? h.kind,
          ...stateFor(id),
        }),
      );
      edges.push(baseEdge(`e:router->${h.name}`, "router", id));
    });

    // The two fall-through endpoints, always present at the bottom of column 3.
    TERMINALS.forEach((t, i) => {
      const id = `terminal:${t.action}`;
      nodes.push(
        node(id, 3, yFor(handlers.length + i, handlerRows), {
          label: t.label,
          variant: t.action,
          subtitle: t.subtitle,
          ...stateFor(id),
        }),
      );
      edges.push(baseEdge(`e:router->${id}`, "router", id));
    });

    // ── Highlight the matched funnel on trigger ───────────────────────────────
    if (result && selectedType) {
      const hot = (id: string, source: string, target: string, label?: string): Edge => ({
        id,
        source,
        target,
        sourceHandle: "right",
        targetHandle: "left",
        animated: true,
        label,
        labelStyle: { fontSize: 10, fill: "var(--color-primary, #6419e6)", fontWeight: 700 },
        labelBgStyle: { fill: "var(--color-base-100, #fff)", fillOpacity: 0.9 },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 3,
        style: HOT_EDGE,
        zIndex: 10,
      });
      edges.push(hot(`hot:input->${selectedType}`, `input:${selectedInput}`, `event:${selectedType}`));
      edges.push(hot(`hot:${selectedType}->router`, `event:${selectedType}`, "router"));
      if (matchedHandler) {
        edges.push(
          hot(`hot:router->${matchedHandler}`, "router", `handler:${matchedHandler}`, result.classification?.intent),
        );
      } else if (result.route.action !== "handler") {
        const tid = `terminal:${result.route.action}`;
        edges.push(hot(`hot:router->${tid}`, "router", tid, result.route.action));
      }
    }

    return { nodes, edges };
  }, [graph, selectedInput, selectedType, matchedHandler, result]);

  // Refit on container resize (the form panel changes the flow width).
  const wrapperRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<Node<RouterNodeData>, Edge> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const el = wrapperRef.current;
    if (!el) return undefined;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!mountedRef.current) return;
        const flow = flowRef.current;
        if (!flow) return;
        try {
          if (flow.getNodes().length === 0) return;
          flow.fitView({ padding: 0.12 });
        } catch {
          /* raced against unmount — ignore */
        }
      });
    });
    ro.observe(el);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      flowRef.current = null;
    };
  }, []);

  const onNodeClick = useCallback(
    (_: unknown, node: Node<RouterNodeData>) => {
      if (node.id.startsWith("input:")) selectInput(node.id.slice("input:".length) as "github" | "slack");
      else if (node.id.startsWith("event:")) selectEvent(node.id.slice("event:".length));
    },
    [selectInput, selectEvent],
  );

  if (error) {
    return (
      <div className="flex items-center justify-center flex-1">
        <div className="rounded border border-error/30 bg-error/10 p-4 text-error text-sm">{error}</div>
      </div>
    );
  }
  if (!graph) {
    return <div className="flex items-center justify-center flex-1 text-base-content/50">Loading…</div>;
  }

  const isSlackClassifier = selectedInput === "slack";
  // The real configured handle for this instance — a comment must @-mention it
  // to route (the default is `last-light`, but overlays/env can rename it).
  const botHandle = `@${graph.botName}`;

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-base-100">
      <div className="border-b border-base-300 px-4 py-3">
        <h2 className="text-sm font-semibold text-base-content">Event Router Playground</h2>
        <p className="text-xs text-base-content/60">
          Thread a synthetic event through the real classifier + router. Nothing runs — it only shows
          where the event would route, and why.
        </p>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div ref={wrapperRef} className="flex-1 min-w-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            fitViewOptions={{ padding: 0.12, minZoom: 0.3, maxZoom: 1 }}
            minZoom={0.25}
            maxZoom={1.5}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
            onInit={(instance) => {
              flowRef.current = instance;
            }}
            onNodeClick={onNodeClick}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={0.5} color="var(--color-base-300, #ccc)" />
          </ReactFlow>
        </div>

        {/* Form + why panel */}
        <div className="w-80 shrink-0 border-l border-base-300 overflow-auto p-4 space-y-4 bg-base-100">
          {!selectedType || !fields ? (
            <p className="text-xs text-base-content/50">
              Pick an input on the left, then click an event type to configure and trigger a test.
            </p>
          ) : (
            <>
              <div>
                <div className="text-xs font-semibold text-base-content">{selectedType}</div>
                <div className="text-2xs text-base-content/50">
                  {eventType?.routing === "classifier"
                    ? "Classifier-routed — the LLM decides the intent."
                    : "Deterministic — a fixed router branch decides."}
                </div>
              </div>

              {isSlackClassifier && (
                <div className="rounded border border-info/30 bg-info/10 p-2 text-2xs text-base-content/70">
                  A Slack message carries no repo or issue — the classifier parses them from the text
                  itself (e.g. <span className="font-mono">review cliftonc/drizby#42</span>). Whatever it
                  extracts shows up in the result below.
                </div>
              )}

              {fields.body && (
                <Field label={fields.slack ? "Message" : fields.mention ? "Comment text" : "Body"}>
                  <textarea
                    className="textarea textarea-bordered textarea-sm w-full h-24 font-mono text-xs"
                    value={form.body}
                    onChange={(e) => setForm({ ...form, body: e.target.value })}
                    placeholder={
                      fields.slack
                        ? `${botHandle} review cliftonc/drizby#42`
                        : fields.mention
                          ? `${botHandle} build a login page`
                          : selectedType === "issue.opened"
                            ? "How does the auth flow work?"
                            : "Issue / PR description…"
                    }
                  />
                </Field>
              )}
              {fields.mention && (
                <p className="text-2xs text-base-content/40 -mt-2">
                  Tip: GitHub comments only route when they mention{" "}
                  <span className="font-mono">{botHandle}</span> exactly; otherwise they’re ignored.
                </p>
              )}

              {fields.title && (
                <Field label={fields.checks ? "PR title (Dependabot bump)" : "Issue / PR title"}>
                  <input
                    className="input input-bordered input-sm w-full text-xs"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder={fields.checks ? "Bump lodash from 4.17.20 to 4.17.21" : undefined}
                  />
                </Field>
              )}
              {fields.checks && (
                <p className="text-2xs text-base-content/40 -mt-2">
                  The connector only emits checks events for Dependabot/Renovate PRs — set the PR author
                  to <span className="font-mono">dependabot[bot]</span> and a bump title so it routes to the
                  CI-fix workflow.
                </p>
              )}

              {(fields.repo || fields.number) && (
                <div className="grid grid-cols-2 gap-2">
                  {fields.repo && (
                    <Field label="Repo">
                      <input
                        className="input input-bordered input-sm w-full text-xs font-mono"
                        value={form.repo}
                        onChange={(e) => setForm({ ...form, repo: e.target.value })}
                      />
                    </Field>
                  )}
                  {fields.number && (
                    <Field label="Issue / PR #">
                      <input
                        className="input input-bordered input-sm w-full text-xs"
                        value={form.issueNumber}
                        onChange={(e) => setForm({ ...form, issueNumber: e.target.value })}
                        inputMode="numeric"
                      />
                    </Field>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Field label="Sender">
                  <input
                    className="input input-bordered input-sm w-full text-xs"
                    value={form.sender}
                    onChange={(e) => setForm({ ...form, sender: e.target.value })}
                  />
                </Field>
                {fields.authorAssociation && (
                  <Field label="Author assoc.">
                    <select
                      className="select select-bordered select-sm w-full text-xs"
                      value={form.authorAssociation}
                      onChange={(e) => setForm({ ...form, authorAssociation: e.target.value })}
                    >
                      {ASSOCIATIONS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>

              {fields.labels && (
                <Field label="Labels (comma-separated)">
                  <input
                    className="input input-bordered input-sm w-full text-xs"
                    value={form.labels}
                    onChange={(e) => setForm({ ...form, labels: e.target.value })}
                    placeholder="needs-info, bug"
                  />
                </Field>
              )}

              {fields.prToggle && (
                <label className="flex items-center gap-2 text-xs text-base-content/70 cursor-pointer">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-xs"
                    checked={form.isPullRequest}
                    onChange={(e) => setForm({ ...form, isPullRequest: e.target.checked })}
                  />
                  On a pull request
                </label>
              )}

              {(fields.checks || (fields.prToggle && form.isPullRequest)) && (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="PR author">
                    <input
                      className="input input-bordered input-sm w-full text-xs"
                      value={form.prAuthor}
                      onChange={(e) => setForm({ ...form, prAuthor: e.target.value })}
                      placeholder="dependabot[bot]"
                    />
                  </Field>
                  <Field label="Checks state">
                    <select
                      className="select select-bordered select-sm w-full text-xs"
                      value={form.checksState}
                      onChange={(e) => setForm({ ...form, checksState: e.target.value })}
                    >
                      {CHECKS_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s || "—"}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}

              <button className="btn btn-primary btn-sm w-full" onClick={onTrigger} disabled={triggering}>
                {triggering ? "Routing…" : "Trigger"}
              </button>

              {triggerError && (
                <div className="rounded border border-error/30 bg-error/10 p-2 text-2xs text-error">
                  {triggerError}
                </div>
              )}

              {result && <WhyPanel result={result} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-2xs uppercase tracking-wider text-base-content/50 mb-1">{label}</span>
      {children}
    </label>
  );
}

function WhyPanel({ result }: { result: RouteTestResponse }) {
  const { route, classification, explanation } = result;
  const actionTone =
    route.action === "handler" ? "text-success" : route.action === "reply" ? "text-info" : "text-warning";
  const classifierErrored =
    explanation.reason?.startsWith("classifier error") ||
    explanation.reason?.includes("no parseable INTENT");
  return (
    <div className="rounded border border-base-300 bg-base-200/40 p-3 space-y-2 text-xs">
      {classifierErrored && (
        <div className="rounded border border-error/40 bg-error/10 p-2 text-2xs text-error">
          The classifier didn’t really run — this fell back to <span className="font-mono">chat</span>.
          Either the LLM call errored (missing/invalid provider key), or the model returned empty output
          (a reasoning model can exhaust the classifier’s small token budget on hidden reasoning).
          <div className="mt-1 font-mono break-words opacity-80">{explanation.reason}</div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="badge badge-xs badge-ghost">{explanation.routingKind}</span>
        <span className={`font-semibold ${actionTone}`}>{route.action}</span>
      </div>
      <div className="text-base-content/80 font-mono text-2xs break-words">{explanation.branchLabel}</div>
      {route.action === "handler" && (
        <div>
          <span className="text-base-content/50">handler: </span>
          <span className="font-mono">{route.handler}</span>
          {explanation.routeKey && (
            <span className="text-base-content/40 font-mono"> ({explanation.routeKey})</span>
          )}
        </div>
      )}
      {route.action === "reply" && (
        <div className="text-base-content/70 whitespace-pre-wrap">{route.message}</div>
      )}
      {route.action === "ignore" && <div className="text-base-content/70">{route.reason}</div>}
      {classification && (
        <div className="border-t border-base-300 pt-2 space-y-1">
          <div>
            <span className="text-base-content/50">intent: </span>
            <span className="font-mono">{classification.intent}</span>
          </div>
          {classification.model && (
            <div>
              <span className="text-base-content/50">model: </span>
              <span className="font-mono break-all">{classification.model}</span>
            </div>
          )}
          {classification.repo && (
            <div>
              <span className="text-base-content/50">extracted: </span>
              <span className="font-mono">
                {classification.repo}
                {classification.issueNumber ? `#${classification.issueNumber}` : ""}
              </span>
            </div>
          )}
          {explanation.reason && !classifierErrored && (
            <div className="text-base-content/70 italic">“{explanation.reason}”</div>
          )}
        </div>
      )}
      {explanation.notes.length > 0 && (
        <ul className="border-t border-base-300 pt-2 space-y-0.5 text-base-content/60">
          {explanation.notes.map((n, i) => (
            <li key={i}>• {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
