# ADR 0001 — The workflow asset root is process-global; config arms run serially

- Status: Accepted
- Date: 2026-06-29
- Deciders: harness maintainers

## Context

The eval harness runs each instance through a real production workflow. To
resolve a workflow's YAML / prompts / skills, core looks them up by name from a
set of **asset roots** configured via `configureWorkflowAssets({ builtInRoot,
overlayRoot })` — imported from the `lastlight/evals` barrel and wrapped by our
`bootstrapAssets` (`src/bootstrap.ts`).

That configuration is **module-level state inside the `lastlight` package**: there
is one "current overlay" for the whole Node process, and core's `getWorkflow(name)`
takes no per-call asset-root argument. The overlay is how a deployment shadows
built-in workflows/skills, and in a `config`-mode run each overlay is one arm
(comparison column).

Two consequences follow from the global:

1. To compare several overlays, the harness must repoint the global asset root
   **before each arm's cases run** (the serial loop in `src/run.ts`).
2. Config arms **cannot run in parallel** — two arms with different overlays
   would race over the one global. Hence `parallel = runType === "models" && …`.

As written this is correct, but the invariant ("repoint before each arm; never
two overlays concurrently") was maintained only by **discipline**, not enforced.
A future change (flipping config to parallel, reordering the loop) could silently
race two overlays.

## Decision

1. **Accept the process-global for now.** The eval harness does not work around
   core's global asset root. Config arms stay serial.

2. **Concentrate the switch behind the `Arm` seam.** The "repoint the asset root"
   step is named `activate()` on the `Arm` interface (`src/arm.ts`):
   - `configArm.activate()` → `bootstrapAssets({ overlayDir })`
   - `modelsArm.activate()` → no-op
   The run loop calls `arm.activate()` on each arm change instead of branching on
   `runType === "config"` and comparing overlay dirs.

3. **Guard the invariant.** `activate()` enforces "one overlay at a time": it
   records the active overlay and throws loudly if a second, different overlay is
   activated while one is in use, rather than racing silently. The
   discipline-maintained rule becomes a runtime-checked one.

## The real fix (deferred)

The root cause is core's API, which we own. The proper fix is to make the overlay
a **per-call argument** — `getWorkflow(name, { overlayRoot })` (or thread it
through `runWorkflow` / `ExecutorConfig`) — so each `runInstance` passes its arm's
overlay explicitly, eliminating the global and unblocking parallel config arms.

This is a change to the `lastlight` core package and the barrel contract, out of
scope for the Arm deepening in this repo. It is tracked at
[nearform/lastlight#139](https://github.com/nearform/lastlight/issues/139). When
it lands, the migration here is one file: `configArm` returns its overlay as a
value (likely from `prepare()`), and `activate()` plus its guard are deleted.

## Consequences

- The `runType === "config"` / overlay-diff branch leaves `run.ts`; overlay
  switching lives in `configArm.activate()` only.
- The "two overlays at once" footgun throws instead of racing.
- Config-mode comparisons remain serial until the core per-call-overlay change
  lands.
- This ADR exists so a future architecture review does not re-flag the global
  without the core-API context, and knows the fix is already planned.
