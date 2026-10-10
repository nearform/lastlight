# 04 — Overlays in TypeScript

> **Deferred 2026-10-10** ([`09-decisions.md`](09-decisions.md) #9). Not part
> of #435: no overlay repo has ever forked a workflow YAML. #435 rejects
> `instance/workflows/*.yaml` at boot and keeps built-ins internally
> composable so this design stays open. Kept as the design for the follow-up
> issue; the first real override need decides the typed options.

## Today

Workflow YAML is replaced **whole, by name** (`packages/shared/src/workflow-loader.ts`
`populateCache`): built-in → overlay → (never) repo. `lastlight fork` copies the
YAML and every prompt/skill it references; the fork stops receiving core
changes. Prompts, skills and agent-context are layered **per file** and stay
that way.

## Proposal

1. **Loading.** The loader discovers `instance/workflows/*.ts` and imports
   them at boot. Node strips types natively from 22.18 / 23.6 (unflagged), so
   no build step on the host — bump `engines.node` to `>=22.18` (the image is on
   24 already) or fall back to `jiti` for older Nodes. Overlay code may import
   only `lastlight-workflow-engine/durable` and a new
   `lastlight-core/workflows` barrel of built-ins and helpers.
2. **Compose, don't fork.** Built-ins export their parts as functions:

   ```ts
   // instance/workflows/build.ts — same name, so it shadows the built-in
   import { defineWorkflow } from "lastlight-workflow-engine/durable";
   import { buildWorkflow } from "lastlight-core/workflows";

   export default defineWorkflow({
     ...buildWorkflow.definition,
     version: "nearform-1",
     async run(ctx) {
       await ctx.agent("license-check", { prompt: "prompts/license-check.md" });   // extra step
       return buildWorkflow.run(ctx, { reviewer: { maxCycles: 3 } });             // typed options
     },
   });
   ```

   Core changes to `buildWorkflow.run` flow through; only the deliberate
   override is the overlay's. Typed options (`reviewer.maxCycles`, step hooks)
   are added where overlays actually diverge — today neither overlay repo has
   ever forked a workflow YAML, so start with zero options and grow.
3. **Trust boundary unchanged.** The operator overlay is trusted code already
   (it controls prompts, models and `git_access`). The per-repo `.lastlight/`
   layer **never** supplies workflow code — same structural rule as today
   (`populateCache` skips `repo`), now enforced by only scanning the overlay dir.
4. **Validation.** `lastlight repo config validate` / `validateAssets` become a
   typecheck: the CLI ships the `.d.ts` for both barrels and runs `tsc
   --noEmit` over `instance/workflows`. The CLI still gains no edge to core at
   runtime (types only).
5. **Config-only knobs remain config.** `models`, `variants`, `approval`,
   `disabled.*`, `routes`, `gate.*`, `fix.*` stay in `config.yaml` /
   `.lastlight/lastlight.yml` and reach workflows through `ctx.model`,
   `ctx.gateEnabled`, `ctx.num` — the per-repo bounded-override rules are
   untouched.
