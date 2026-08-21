# WP10 — run the evals in the real sandbox

**Goal.** Let the eval harness execute a case inside the **production sandbox
image**, so the thing being measured is the thing that ships.

**Depends on:** nothing structurally. Pairs naturally with [WP2](02-sandbox-image.md),
which is what makes the image's toolchain trustworthy once the eval can see it.

**Status:** proposed 2026-08-21, after WP0 landed and while WP1 was in flight.

## Why this is not a nice-to-have

Three decisions in this plan are **workarounds for one limitation**, and this WP
removes the limitation rather than the workarounds.

`apps/evals/CLAUDE.md` states the harness's own governing rule:

> These evals run the **real** production workflows … The only deviations from
> production are the two we can't do unattended: GitHub is mocked, and approval
> gates are disabled. **If a change makes the eval diverge from prod in any
> *other* way, it's wrong.**

Design-review error [E1](10-design-review.md) established that the harness
already violates this for anything living in the sandbox image: `run.ts` defaults
to `--sandbox none` (in-process, on the host), `gondolin` needs `/dev/kvm` and
`sandbox-preflight.ts` refuses on darwin, and **no eval configuration on a Mac
can see `/opt/lastlight/`**. The consequences were absorbed as three separate
compromises:

| Decision | The compromise it made | What this WP does to it |
|---|---|---|
| **§D1** | `code-facts` ships in the CLI, because the eval cannot reach the image | Weakens the *reason*. See "What this does not change" — do **not** revert D1 on this basis alone |
| **§D2** | Binary-backed tools (opengrep, gitleaks) are probed on `PATH` and degrade when absent | Removes it for eval runs: the image has them, pinned |
| **§D3** | Tools resolved from host `PATH` — explicitly named *"a **third** deviation from production, taken deliberately against this harness's own one-invariant rule"* | **Removes the deviation entirely** |

And one measurement consequence, from §D2, that is worth stating on its own:

> **Accepted consequence:** on an eval arm without the binaries, the `security`
> family is measured with its `patterns` half missing. [WP8](08-evals.md)'s
> per-family attribution must label that **"not measured"**, never "did not
> convert".

`security` is one of six obligation families. Under the current harness it is
**structurally unmeasurable on a Mac**, so any ablation rung that includes it
reports a hole. This WP is what closes that hole.

## Which stubs actually have to cross the boundary

The instinct that *"it's hard because we stub and proxy GitHub"* is the right
worry aimed at the wrong seam. The harness mocks more than a REST API —
`fake-github.ts` is described in `apps/evals/CLAUDE.md` as an in-process fake
REST API *"**plus** the non-REST `fetchRepoConfigTree` seam"* — but sorting those
stubs by **which side of the boundary calls them** is what makes this tractable:

| Stub | Called by | Crosses? |
|---|---|---|
| REST routes (`github_*` tools) | the **agent** | **Yes** — needs a container-resolvable URL |
| `POST /graphql` (`enablePullRequestAutoMerge`) | the **agent** | **Yes** — same HTTP surface |
| `labelsOn` / `mergeOf` / `autoMergeOf` / `submittedReviews` | `grade.ts`, **after** the run | No — harness-side, reads recorded state |
| `fetchRepoConfigTree` (the `.lastlight/` layer, #180) | `repo-config.ts` → **core's own** `resolveRepoRunConfig` | No — harness-side by design: *"read by the HARNESS, not by an agent tool"* |
| `PrState` projection (`pr-context.ts`) | **core's own** `renderContext`, in-harness | No — resolved before the agent starts |

So the non-REST seams — the ones that genuinely cannot survive a process
boundary, because they are method swaps rather than endpoints — are **all on the
harness side**. They are computed before the agent runs or read after it
finishes. The agent-facing surface is HTTP plus environment, and
`githubApiBaseUrl` is **already a threaded seam**: `run-instance.ts` sets it,
core threads it `ExecutorConfig.githubApiBaseUrl → agenticRun`, and
`mechanism.test.ts` guards the consumer side. Nothing in it assumes the same
process; it assumes a resolvable URL.

That is why `gondolin` already works **with** the mock: it isolates the agent's
tools while `github_*` stays in-process. `docker`/`smol` move the whole agent
inside — which is the fidelity we want, and which is what breaks a loopback URL.

**The hard parts are therefore not GitHub.** They are the three below, and none
of them announces itself when wrong.

## The three that are actually hard

**H1 — the environment does not follow the agent in.** `applyEvalEnv()` installs
the static-token env (`GITHUB_TOKEN=eval-fake-token`, `GITHUB_APP_ID` /
`GITHUB_APP_INSTALLATION_ID` **unset**) once per batch into `process.env`, and
every `runInstance` is called with `manageEnv: false` so it never splices env
itself. A container inherits none of that. The sandbox executor must forward the
GitHub env *and* the provider key explicitly — and the failure mode of getting it
half-right is the worst kind: with `GITHUB_APP_ID` leaking in, the run stops
being static-token mode and tries to mint a real installation token.

**H2 — session logs, and therefore cost.** The executor's shim writes the session
jsonl, the final envelope is flushed **fire-and-forget**, and `run-instance.ts`
calls `drainSessions()` before `collectMetrics()` for exactly that reason. If the
agent writes its session tree inside the container while the drain watches a host
path, the drain sees a quiet tree immediately, `collectMetrics()` finds nothing,
and **cost silently reports 0**. The harness's own docs already flag this as a
standing trap; containerisation makes it the default outcome rather than an edge
case.

**H3 — the image vendors its own `agentic-pi`.** The sandbox images no longer
install it from npm; they **vendor it from the workspace** via a `pnpm deploy`
bundle built in `sandbox*.Dockerfile`. So a sandboxed run exercises the *image's*
agent harness, not the working tree's. For measuring production fidelity that is
precisely correct. For measuring an unreleased `agentic-pi` change it is the same
trap as running the published core — you would be measuring a different build
than the one you edited, with nothing erroring. Whatever image a rung is measured
on must be stamped in the scorecard (criterion 5) and rebuilt when the workspace
`agentic-pi` changes.

## What else has to move

Beyond H1–H3, each of these is load-bearing:

1. **The seeded workspace must be mounted.** `seed.ts` pre-populates
   `<stateDir>/sandboxes/<taskId>` on the host — the fixture/checkout plus a
   local bare `origin` so `git push` works offline. The container must see that
   exact path, or the agent starts in an empty tree.
2. **`prePopulateBranch` must stay unset.** `runWorkflow` only clones from
   GitHub when it is set, and the eval deliberately never sets it. If a sandbox
   path starts setting it, the runner will try to clone real GitHub.
3. **Preflight, not a crash.** Model `sandbox-preflight.ts`: check the daemon is
   reachable and the image tag exists, and **refuse with the command to fix it**.
   Never fall back to `none` silently — an arm that quietly measured the host
   toolchain while claiming the image is worse than a failed run.
4. **Image provenance in the scorecard.** `meta.core` already records which
   `lastlight-core` produced a run (see [HANDOFF](HANDOFF.md)). The sandbox image
   ref and its `toolchain.json` stamp belong beside it, for the same reason: a
   rung measured on one image and shipped on another is a difference nothing
   else would surface.
5. **Concurrency.** `run.ts` runs provider families concurrently, relying on
   per-run `mkdtemp` stateDirs and a private fake-GitHub port each. Container
   naming, port mapping and cleanup must preserve that isolation.

## What this does **not** change

- **§D1 stays.** `code-facts` shipping in the CLI is still right: it works on any
  host with no image, no daemon and no pull, which is what makes the cheap
  single-case iteration loop (~$1–2.5) usable. This WP removes D1's *original*
  justification, so record honestly that the decision now rests on a different
  argument than the one that produced it — but re-litigating it would churn WP1
  for no measurement gain.
- **The two legitimate deviations stay.** GitHub is still mocked; approval gates
  are still disabled. Those are the two we cannot do unattended.
- **`none` stays the default.** It is the fast path and the CI path. This is an
  opt-in fidelity mode, not a new default — and per locked decision 8 the thing
  it measures is off by default anyway.

## Acceptance criteria

1. `--sandbox docker` runs a pr-review case end to end, with the agent's
   `github_*` calls recorded by the fake GitHub exactly as under `--sandbox none`.
2. A case run under `--sandbox docker` and the same case under `--sandbox none`
   produce the same recorded GitHub mutations for a fixed model and seed — the
   sandbox changes *where* the agent runs, not *what* the workflow does.
3. Cost and token metrics are **non-zero** under the sandbox path. A test asserts
   this directly; it is the failure that otherwise reports as a free eval run.
4. The preflight refuses, with actionable guidance, when the daemon is down or
   the image tag is missing — and never silently downgrades to `none`.
5. The scorecard records the image ref and toolchain stamp for a sandboxed run.
6. `--sandbox none` remains byte-identical in behaviour and stays the default.
7. With the image in play, `security` reports as **measured** rather than
   `notMeasured` in WP8's per-family attribution.

## Non-goals

- **Not `smol`.** One backend, done properly. `smol` can follow the same seam.
- **Not making sandboxed runs the gate.** The ablation ladder's rungs are
  comparable only within one execution mode; switching mid-ladder would confound
  every delta. Decide the mode once, before the rungs that matter.
- **Not a CI change.** CI keeps `none`.
- **Not gondolin's removal**, though this reduces the argument for keeping it.

## The honest risk

The eval's whole value is that it runs production's real workflows. Adding a
second execution mode adds a way for the two modes to *disagree* — and a
disagreement discovered halfway up the ablation ladder invalidates the rungs
below it. Criterion 2 exists to catch that early, and the non-goal above exists
so the choice is made once rather than drifted into.
