#!/usr/bin/env node
// Deterministic YAML → TypeScript workflow converter (spike — see
// docs/plans/durable-workflows/05-migration.md).
//
//   node scripts/yaml-to-ts.mjs <workflow.yaml|dir> <outDir>
//
// Emits one `defineWorkflow` module per agent workflow, written against
// `lastlight-workflow-engine/durable`. The output is deliberately LITERAL, not
// pretty: it reproduces the YAML engine's semantics (chain synthesis, trigger
// rules, the substring BLOCKED rule, the missing-key polarity of `skip_if`)
// through the `y*` compat helpers, so a converted workflow behaves like its
// original and the diff a human then makes is a reviewable simplification.
// Anything it cannot translate is emitted as a `TODO(convert)` that fails
// loudly at run time — never silently dropped. Same input → same bytes.
//
// Cron documents (`kind: cron`) are skipped: they are trigger config, not
// workflows, and stay declarative.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";

const [, , inPath, outDir] = process.argv;
if (!inPath || !outDir) {
  console.error("usage: yaml-to-ts.mjs <workflow.yaml|dir> <outDir>");
  process.exit(2);
}

const lit = (v) => JSON.stringify(v);
const ident = (name) => "p_" + name.replace(/[^A-Za-z0-9_]/g, "_");

function convert(def, file) {
  const todos = [];
  const todo = (what) => {
    todos.push(what);
    return `TODO(convert): ${what}`;
  };

  // ── value translators ─────────────────────────────────────────────────────
  const strOrRender = (s) => {
    if (s === undefined) return undefined;
    const m = /^\{\{(models|variants)\.([\w-]+)\}\}$/.exec(s);
    if (m) return `ctx.${m[1] === "models" ? "model" : "variant"}(${lit(m[2])})`;
    if (s.includes("{{")) return `ctx.render(${lit(s)}) || undefined`;
    return lit(s);
  };
  const num = (v) => {
    if (v === undefined) return undefined;
    if (typeof v === "number") return String(v);
    if (typeof v === "object" && v.from) return `ctx.num(${lit(v.from)}${v.default !== undefined ? `, ${v.default}` : ""})`;
    const m = typeof v === "string" && /^\{\{([\w.-]+)\}\}$/.exec(v);
    if (m) return `ctx.num(${lit(m[1])})`;
    return `undefined /* ${todo(`numeric value ${lit(v)}`)} */`;
  };
  const path = (p, outVar) => {
    if (p === "output") return outVar ?? `undefined /* ${todo("`output` outside a loop")} */`;
    if (p.startsWith("phaseOutputs.")) return `yGet(outputs, ${lit(p.slice("phaseOutputs.".length))})`;
    // `scratch.*` is written by core's onPhaseEnd harvests and app handlers,
    // not by the YAML — a ported workflow must compute it from step results.
    if (p.startsWith("scratch.")) return `ctx.get(${lit(p)}) /* ${todo(`scratch read ${p} — port its writer`)} */`;
    return `ctx.get(${lit(p)})`;
  };
  const expr = (e, outVar) => {
    const t = e.trim();
    let m;
    if ((m = /^([\w.]+)\.contains\(['"](.+)['"]\)$/.exec(t))) return `yContains(${path(m[1], outVar)}, ${lit(m[2])})`;
    if ((m = /^([\w.]+)\.startsWith\(['"](.+)['"]\)$/.exec(t))) return `yStartsWith(${path(m[1], outVar)}, ${lit(m[2])})`;
    if ((m = /^([\w.]+)\s*(==|!=)\s*(true|false)$/.exec(t)))
      return `${(m[2] === "==") === (m[3] === "true") ? "" : "!"}yBool(${path(m[1], outVar)})`;
    if ((m = /^([\w.]+)\s*==\s*['"](.+)['"]$/.exec(t))) return `yEq(${path(m[1], outVar)}, ${lit(m[2])})`;
    if ((m = /^([\w.]+)\s*!=\s*['"](.+)['"]$/.exec(t))) return `yNeq(${path(m[1], outVar)}, ${lit(m[2])})`;
    // The YAML evaluator treats an unparseable expression as false.
    return `false /* ${todo(`unparseable expression ${lit(e)} (YAML evaluates it false)`)} */`;
  };

  const agentOpts = (p, extraVars) => {
    const o = [];
    if (p.prompt) o.push(`prompt: ${lit(p.prompt)}`);
    const skills = p.skills ?? (p.skill ? [p.skill] : undefined);
    if (skills) o.push(`skills: ${lit(skills)}`);
    if (p.model) o.push(`model: ${strOrRender(p.model)}`);
    if (p.variant) o.push(`variant: ${strOrRender(p.variant)}`);
    if (p.timeout_seconds !== undefined) o.push(`timeoutSeconds: ${num(p.timeout_seconds)}`);
    if (p.unrestricted_egress !== undefined) o.push(`unrestrictedEgress: ${p.unrestricted_egress}`);
    if (p.web_search !== undefined) o.push(`webSearch: ${p.web_search}`);
    if (p.sandbox_image !== undefined) o.push(`sandboxImage: ${lit(p.sandbox_image)}`);
    if (p.command_policy !== undefined) o.push(`commandPolicy: ${lit(p.command_policy)} as never /* ${todo("command_policy shape")} */`);
    if (extraVars) o.push(`vars: ${extraVars}`);
    return `{ ${o.join(", ")} }`;
  };

  // ── phase order: the scheduler runs ONE ready node at a time, lowest
  // declaration index first; statuses don't change that order, only skips.
  const phases = def.phases ?? [];
  const anyDeclared = phases.some((p) => p.depends_on?.length);
  const deps = new Map(phases.map((p, i) => [p.name, anyDeclared ? (p.depends_on ?? []) : i > 0 ? [phases[i - 1].name] : []]));
  const order = [];
  const done = new Set();
  while (order.length < phases.length) {
    const next = phases.find((p) => !done.has(p.name) && deps.get(p.name).every((d) => done.has(d)));
    if (!next) throw new Error(`${file}: dependency cycle`);
    order.push(next);
    done.add(next.name);
  }

  const out = [];
  const w = (s = "") => out.push(s);
  const notify = (ind, key, msg, vars) =>
    msg ? w(`${ind}await ctx.notify(${lit(key)}, ${lit(msg)}${vars ? `, ${vars}` : ""});`) : undefined;

  let terminalPhase;
  for (const p of order) {
    const id = ident(p.name);
    const type = p.type ?? "agent";
    const rule = p.trigger_rule ?? "all_success";
    const msgs = p.messages ?? {};
    w();
    w(`    // ── ${p.name}${p.label ? ` — ${p.label}` : ""} (${type})`);
    if (p.requires_sandbox) w(`    // ${todo(`requires_sandbox: ${lit(p.requires_sandbox)} host-capability skip`)}`);
    if (p.on_success?.set_phase) terminalPhase = p;
    w(`    if (!yTrigger(${lit(rule)}, ${lit(deps.get(p.name))}, st)) st[${lit(p.name)}] = "skipped";`);
    const skips = p.skip_if ? (Array.isArray(p.skip_if) ? p.skip_if : [p.skip_if]) : [];
    if (skips.length) w(`    else if (${skips.map((e) => expr(e)).join(" || ")}) st[${lit(p.name)}] = "skipped";`);
    w(`    else {`);
    const ind = "      ";
    notify(ind, `${p.name}:start`, msgs.on_start);

    if (type === "context") {
      w(`${ind}// The run input carries the context; nothing to do.`);
      w(`${ind}st[${lit(p.name)}] = "succeeded";`);
    } else if (type === "bash") {
      w(`${ind}const ${id} = await ctx.bash(${lit(p.name)}, ${lit(p.command)}${p.timeout_seconds !== undefined ? `, { timeoutSeconds: ${num(p.timeout_seconds)} }` : ""});`);
      w(`${ind}st[${lit(p.name)}] = ${id}.success ? "succeeded" : "failed";`);
    } else if (type === "agent" && p.generic_loop) {
      const l = p.generic_loop;
      const raw = num(l.max_iterations);
      const max = /^\d+$/.test(raw) ? raw : `(${raw} ?? 1)`;
      w(`${ind}const ${id}Loop = await iterate(ctx, {`);
      w(`${ind}  name: ${lit(p.name)},`);
      w(`${ind}  maxIterations: ${max},`);
      w(`${ind}  agent: ({ iteration, previousOutput, reply }) => (${agentOpts(p, `{ iteration, maxIterations: ${max}, previousOutput, reply: reply ?? "" }`)}),`);
      if (l.until) w(`${ind}  until: (out) => ${expr(l.until, "out")},`);
      if (l.until_bash) w(`${ind}  untilBash: { command: ${lit(l.until_bash)} },`);
      if (l.fresh_context !== undefined) w(`${ind}  freshContext: ${l.fresh_context},`);
      if (l.on_soft_failure) w(`${ind}  onSoftFailure: ${lit({ retries: l.on_soft_failure.retries ?? 0, then: l.on_soft_failure.then ?? "fail" })},`);
      if (l.interactive) w(`${ind}  gate: { kind: ${lit(l.gate_kind ?? "approve")}, message: ${lit(l.gate_message ?? "Loop iteration {{iteration}} complete.")} },`);
      if (l.scratch_key) w(`${ind}  // scratch_key ${lit(l.scratch_key)}: not needed — each round is a durable step.`);
      w(`${ind}});`);
      w(`${ind}const ${id} = ${id}Loop.last ?? { success: !${id}Loop.failed, output: ${id}Loop.output };`);
      w(`${ind}st[${lit(p.name)}] = ${id}Loop.failed ? "failed" : "succeeded";`);
    } else if (type === "agent" && p.loop) {
      const l = p.loop;
      const rc = l.on_request_changes ?? {};
      const m = l.messages ?? {};
      w(`${ind}const ${id}Loop = await reviewLoop(ctx, {`);
      w(`${ind}  name: ${lit(p.name)},`);
      w(`${ind}  maxCycles: ${l.max_cycles},`);
      w(`${ind}  review: ${agentOpts(p)},`);
      w(`${ind}  reReview: ${agentOpts({ ...p, prompt: rc.re_review_prompt ?? p.prompt })},`);
      w(`${ind}  fix: ${agentOpts({ ...p, prompt: rc.fix_prompt, skill: undefined, skills: undefined, model: rc.fix_model, variant: rc.fix_variant })},`);
      if (l.approval_gate) w(`${ind}  approvalGate: { gate: ${lit(l.approval_gate)}${l.approval_artifact ? `, artifact: ${lit(l.approval_artifact)}` : ""}${m.on_pause_for_approval ? `, message: ${lit(m.on_pause_for_approval)}` : ""} },`);
      const mm = { approved: m.on_approved, requestChanges: m.on_request_changes, maxCycles: m.on_max_cycles, fixFailed: m.on_fix_failed };
      if (Object.values(mm).some(Boolean)) w(`${ind}  messages: ${lit(Object.fromEntries(Object.entries(mm).filter(([, v]) => v)))},`);
      w(`${ind}});`);
      w(`${ind}if (${id}Loop.rejected) return fail(${lit(`Rejected at ${l.approval_gate}`)});`);
      w(`${ind}const ${id} = ${id}Loop.last;`);
      w(`${ind}st[${lit(p.name)}] = "succeeded";`);
    } else if (type === "agent") {
      w(`${ind}const ${id} = await ctx.agent(${lit(p.name)}, ${agentOpts(p)});`);
      w(`${ind}st[${lit(p.name)}] = ${id}.success ? "succeeded" : "failed";`);
    } else {
      // App-registered handler types (fanout / survey-units / post-review) and
      // `script`: their behaviour lives in TypeScript already — port it to a
      // library function and call it here.
      w(`${ind}// ${todo(`port \`type: ${type}\` handler`)}. Original phase:`);
      for (const line of JSON.stringify(p, null, 2).split("\n")) w(`${ind}//   ${line}`);
      w(`${ind}const ${id} = await ctx.step(${lit(p.name)}, async (): Promise<{ success: boolean; output: string }> => {`);
      w(`${ind}  throw new Error(${lit(`TODO(convert): type: ${type} is not ported`)});`);
      w(`${ind}});`);
      w(`${ind}st[${lit(p.name)}] = ${id}.success ? "succeeded" : "failed";`);
    }

    if (type !== "context") {
      if (p.output_var) w(`${ind}outputs[${lit(p.output_var)}] = ${ident(p.name)}.output;`);
      const oo = p.on_output ?? {};
      if (oo.requires_marker)
        w(`${ind}if (st[${lit(p.name)}] === "succeeded" && !${id}.output.includes(${lit(oo.requires_marker)})) st[${lit(p.name)}] = "failed";`);
      const b = oo.contains_BLOCKED;
      if (b) {
        w(`${ind}if (st[${lit(p.name)}] === "succeeded" && yBlocked(${id}.output)) {`);
        w(`${ind}  if (yBlockedBypassed(ctx, ${lit(b.unless_label)}, ${lit(b.unless_title_matches)})) {`);
        notify(ind + "    ", `${p.name}:blocked-bypassed`, b.bypass_message ?? msgs.on_blocked_bypassed);
        w(`${ind}  } else {`);
        if ((b.action ?? "fail") === "fail") {
          notify(ind + "    ", `${p.name}:blocked`, msgs.on_blocked);
          w(`${ind}    return fail(${lit(b.message ?? "BLOCKED")});`);
        } else if (b.action === "pause") {
          w(`${ind}    // ${todo("contains_BLOCKED action: pause")}`);
        }
        w(`${ind}  }`);
        w(`${ind}}`);
      }
      if (msgs.on_success) {
        w(`${ind}if (st[${lit(p.name)}] === "succeeded")`);
        notify(ind + "  ", `${p.name}:success`, msgs.on_success);
      }
      if (msgs.on_failure) {
        w(`${ind}if (st[${lit(p.name)}] === "failed")`);
        notify(ind + "  ", `${p.name}:failure`, msgs.on_failure);
      }
      if (p.approval_gate) {
        w(`${ind}if (st[${lit(p.name)}] === "succeeded" && ctx.gateEnabled(${lit(p.approval_gate)})) {`);
        w(`${ind}  const decision = await ctx.approval(${lit(p.approval_gate)}, {`);
        w(`${ind}    summary: ${lit(`${p.label ?? p.name} complete — approval required.`)},`);
        if (p.approval_artifact) w(`${ind}    artifact: ${lit(p.approval_artifact)},`);
        if (p.approval_gate_message) w(`${ind}    message: ${lit(p.approval_gate_message)},`);
        w(`${ind}  });`);
        w(`${ind}  if (!decision.approved) return fail(${lit(`Rejected at ${p.approval_gate}`)});`);
        w(`${ind}}`);
      }
    }
    w(`    }`);
  }

  // ── module ────────────────────────────────────────────────────────────────
  const policy = {
    gitAccess: def.git_access ?? "read",
    workspace: def.workspace ?? "per-run",
    ...(def.pr_scoped !== undefined && { prScoped: def.pr_scoped }),
    ...(def.prepopulate_synth_branch !== undefined && { prepopulateSynthBranch: def.prepopulate_synth_branch }),
    ...(def.prepopulate_pr_head_ref !== undefined && { prepopulatePrHeadRef: def.prepopulate_pr_head_ref }),
    ...(def.pr_fix_shaped !== undefined && { prFixShaped: def.pr_fix_shaped }),
  };
  const head = [];
  const h = (s = "") => head.push(s);
  h(`// GENERATED by scripts/yaml-to-ts.mjs from workflows/${file} — do not edit by hand`);
  h(`// until the TODO(convert) markers are resolved; after that, edit freely and`);
  h(`// replace the y* compat helpers with plain TypeScript.`);
  h(`/* eslint-disable */`);
  h();
  h(`import {`);
  h(`  defineWorkflow, iterate, reviewLoop, yBlocked, yBlockedBypassed, yBool, yContains, yEq, yGet, yNeq, yStartsWith, yTrigger,`);
  h(`  type WorkflowOutcome, type YPhaseStatus,`);
  h(`} from "lastlight-workflow-engine/durable";`);
  h();
  h(`void [iterate, reviewLoop, yBlocked, yBlockedBypassed, yBool, yContains, yEq, yGet, yNeq, yStartsWith];`);
  h();
  h(`const fail = (summary: string): WorkflowOutcome => ({ success: false, summary });`);
  h();
  h(`export default defineWorkflow({`);
  h(`  name: ${lit(def.name)},`);
  h(`  version: "1",`);
  if (def.description) h(`  description: ${lit(def.description.trim())},`);
  h(`  policy: ${lit(policy)},`);
  if (def.classification) h(`  classification: ${lit({ intent: def.classification.intent, description: def.classification.description, ...(def.classification.examples && { examples: def.classification.examples }) })},`);
  if (def.chat) h(`  chat: ${lit(def.chat)},`);
  if (def.status_checklist) h(`  // status_checklist: true — ${todo("progress checklist reporter")}`);
  if (def.final_message) h(`  // final_message: ${todo("render final_message on completion")}`);
  if (def.variables && Object.keys(def.variables).length) h(`  // variables: ${lit(def.variables)} — unused by the YAML engine`);
  h();
  h(`  async run(ctx) {`);
  h(`    const st: Record<string, YPhaseStatus> = {};`);
  h(`    const outputs: Record<string, string> = {};`);
  h(`    void outputs;`);
  // The terminal phase's result is block-scoped; recover the PR number via outputs instead.
  const body = out.join("\n");
  let footer = `    return { success: true, summary: ${lit(terminalPhase?.on_success?.set_phase ?? "complete")} };`;
  if (terminalPhase) {
    footer = [
      `    const prText = prOutput ?? "";`,
      `    const prNumber = prText.match(/\\/pull\\/(\\d+)/)?.[1] ?? prText.match(/#(\\d+)/)?.[1];`,
      `    return { success: true, summary: ${lit(terminalPhase.on_success.set_phase)}, prNumber: prNumber ? Number(prNumber) : undefined };`,
    ].join("\n");
  }
  const prCapture = terminalPhase
    ? body.replace(
        `st[${lit(terminalPhase.name)}] = ${ident(terminalPhase.name)}.success ? "succeeded" : "failed";`,
        `st[${lit(terminalPhase.name)}] = ${ident(terminalPhase.name)}.success ? "succeeded" : "failed";\n      prOutput = ${ident(terminalPhase.name)}.output;`,
      )
    : body;
  const src = [
    ...head,
    ...(terminalPhase ? [`    let prOutput: string | undefined;`] : []),
    prCapture,
    "",
    `    if (Object.values(st).includes("failed")) return fail("one or more phases failed");`,
    footer,
    `  },`,
    `});`,
    "",
  ].join("\n");
  return { src, todos };
}

const files = statSync(inPath).isDirectory()
  ? readdirSync(inPath).filter((f) => f.endsWith(".yaml")).sort().map((f) => join(inPath, f))
  : [inPath];
mkdirSync(outDir, { recursive: true });
const report = [];
for (const f of files) {
  const def = parse(readFileSync(f, "utf8"));
  if (def.kind === "cron") {
    report.push({ file: basename(f), status: "skipped (cron)" });
    continue;
  }
  const { src, todos } = convert(def, basename(f));
  const target = join(outDir, basename(f).replace(/\.yaml$/, ".ts"));
  writeFileSync(target, src);
  report.push({ file: basename(f), status: "converted", lines: src.split("\n").length, todos: todos.length, todoList: todos });
}
for (const r of report) {
  if (r.status !== "converted") console.log(`${r.file.padEnd(28)} ${r.status}`);
  else console.log(`${r.file.padEnd(28)} ${String(r.lines).padStart(4)} lines  ${r.todos ? `${r.todos} TODO: ${[...new Set(r.todoList)].join("; ")}` : "clean"}`);
}
