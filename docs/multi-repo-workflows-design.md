# Multi-Repo Workflows — Design

Issue: [#371](https://github.com/nearform/lastlight/issues/371).

Today every run operates on **exactly one repo**: one `owner`/`repo` pair is
threaded from the trigger to the sandbox, the App token is scoped to it, one
checkout is cloned, and the agent's cwd is that checkout.

The need is cross-repo *analysis*: a support issue whose cause and fix land in
different repos. The hard part is not cloning two repos — that is mostly
widening a scalar to a list. The hard part is **deciding which other repos to
include**, cheaply and safely, without cloning the org.

## Shape

```
cron sweep (host-side, handler:) ──▶ index at <stateDir>/repo-graph/
                                          │  staged into the sandbox
                                          ▼
                                    scout phase (agent, cheap model)
                                          │  queries repo_graph_* tools
                                          │  declares siblings + evidence
                                          ▼
                                    host validates + materialises
                                          │  wider mint, sibling clones
                                          ▼
                                    architect → executor → …
```

Repos are **not** named at trigger time. `--with owner/other` survives only as
a manual escape hatch.

## Deciding which repos to include

This is the whole design. Four gates, narrowest last.

**1. The graph proposes.** An internal dependency graph gives the candidates:
depth-1 neighbours of the primary. Nothing else is a candidate.

**2. The agent selects.** Choosing *which* neighbour matters needs the issue or
PR text — a package name in a stack trace, a symbol in a diff. This is
judgement, not a lookup, so it is an agent phase (see "Scout phase").
Naive inclusion of every neighbour is the failure mode to avoid: extra
checkouts are not neutral, they are more places for the agent to search and
more ways to be wrong.

**3. The host validates.** Every named repo must survive
`graph adjacency ∩ getManagedRepos() ∩ same installation ∩ access ceiling`.
Validation is host-side and unavoidable, because the request is model-authored
and — on public repos — the issue body is attacker-influenceable.

**4. Access is derived, never declared.**

```
sibling access = min(org config ceiling, the workflow's own git_access)
```

No new workflow schema key. Every workflow already declares
`git_access: read | issues-write | review-write | repo-write`
(`packages/workflow-engine/src/core/schema.ts:718`). So `issue-triage` gets
read-only siblings whatever the org sets, `build` gets write only if the org
opted in, and an overlay-only workflow gets the right answer for free — which
is the point of #369.

The org half lives in the **overlay config**, next to `managedRepos`: whether
auto-attachment happens at all, the ceiling, sweep scope and cadence. These are
deployment facts with one correct value per instance, not per-workflow facts.

To keep gate 3 from rejecting things gate 2 could have avoided, every tool
result carries **`materialisable: true|false` and a reason**, precomputed from
the same intersection. The agent can see a cause it cannot attach — and say so,
which is a useful triage answer — without ever proposing the impossible.

## The graph

Two indexes, joined:

- **package name → repo that publishes it** (the inverted index)
- **repo → its declared dependencies**

The join is the filter. `react` and `lodash` fall out for free because no
managed repo publishes them, so "is this dependency internal?" is never a
heuristic or a scope-prefix guess — it is the join failing to match.

### Building it

One host-side cron sweep, per installation, over
`getAccessibleManagedRepos()`. Per repo, on the **default branch only** — the
trust rule `apps/server/src/config/repo-config.ts:18` already enforces, because
a graph built from PR heads would let a PR rewrite the org's dependency map:

1. `GET /git/trees/{default}?recursive=1` — the whole file list in one call.
2. Filter through the existing `ecosystemOf` / `ROOT_MANIFEST_NAMES`
   (`packages/code-facts/src/manifests.ts:67`). Cap manifests per repo.
3. Fetch each and extract **both** indexes from the same file: the published
   name (new, small, per-ecosystem) and the declared deps (`parseManifest`,
   already handles six ecosystems).

**Full recursive tree, not root-only.** Monorepos are exactly where an org has
many packages behind few repos — this repo is its own proof, with seven
published packages and none at the root.

Because one manifest read yields both indexes, the GitHub dependency-graph SBOM
endpoint is **not needed**, which also removes the question of whether
dependency-graph is enabled on private repos. Keep it on the shelf if
lockfile-accurate transitive edges are ever wanted.

Gaps: Gradle and `Gemfile` do not reliably declare a published name (Ruby's
lives in a `.gemspec`), so they contribute dependency edges but few publisher
entries. Go is free — the module path *is* the repo URL.

### Storage and refresh

`<stateDir>/repo-graph/`, following `repo-config`'s TTL + sidecar pattern. This
is derived data, fully rebuildable from GitHub and never a source of truth;
paying a two-dialect migration (`apps/server/src/state/CLAUDE.md`) to persist a
cache we can regenerate is the wrong trade.

The sweep is a host-side cron with a `handler:`, exactly like `cron-digest`:
`apps/server/workflows/cron-repo-graph.yaml` → `src/cron/repo-graph.ts`,
registered via `buildCronHandlers`. Disableability comes free — `crons.disable`,
the dashboard toggle (`cronOverrides`), and manual "Run now", which matters
because an operator enabling multi-repo wants the index built now.

**On by default, inert by default**: registered and ticking, returning
immediately at zero cost unless the org config opts in.

Webhook invalidation is deferred. Daily staleness is safe by construction: a
*missing* edge degrades to a single-repo run, a *stale* edge is caught by
validation.

## Tools

The index is **staged into the sandbox** and queried through tools — not loaded
as JSON by the agent, and not fetched over a host callback (no sandbox→host
channel exists, and the one worth avoiding is a credential-minting one).

A `repo-graph` extension in `packages/agentic-pi/src/extensions/`, loaded like
`loadGitHubExtension` (`packages/agentic-pi/src/extensions/github/index.ts:71`):
if the index is not staged, no tools register and single-repo runs never see
them.

| tool | answers |
| --- | --- |
| `repo_graph_find_package(name)` | who publishes `@acme/payments`? |
| `repo_graph_neighbours(repo, direction)` | what does this depend on / what depends on it? |
| `repo_graph_search(query)` | fuzzy-match a name from a stack trace |

Every result carries **evidence** — the manifest line that produced the edge —
so escalations are grounded and the host can check them, plus the
`materialisable` flag above.

Depth-N traversal is deliberately excluded. The agent chains `neighbours` calls,
keeping each result small and the traversal visible in the transcript rather
than a black-box closure.

## Scout phase

A dedicated agent phase, before the planning phases. Dedicated because:

- it runs on a **cheap model** while planning keeps the expensive one;
- it emits a **structured decision** the host can validate, rather than an
  escalation parsed out of a long free-form plan;
- **ordering** — it sits *before* `architect`, so the plan is written with
  sibling source already on disk instead of blind to the code it spans.

It carries `skip_if` (`schema.ts:424`), so a repo with no internal neighbours
pays nothing.

**Escalation contract**: a marker plus a structured JSON block in the phase
output, reusing `on_output.requires_marker` (as `issue-triage` does with
`TRIAGE_COMPLETE`). The sandbox stays strictly output-only and the decision is
auditable in the run output.

## Materialisation

The token is minted once per phase in `prepareRun` and handed to the sandbox as
env — there is no channel to widen it mid-run. But `prepareRun` runs **per
phase**, so escalation lands at a phase boundary: the host validates, the next
phase gets the wider mint and the sibling checkout.

This needs **no new workspace machinery**. The reuse guard is per repo dir
(`existsSync(join(repoDir, ".git"))`, `apps/server/src/sandbox/index.ts:318`),
so a newly-named sibling falls through to a fresh clone while the primary keeps
its uncommitted scratch. The token rides a one-shot `-c http.extraheader` flag,
"never embedded in the URL, never persisted" (`:295`), so a wider phase-scoped
token needs no remote rewriting.

Siblings clone the **default branch**, shallow, with no PR-shaped refs
(`branch`, `baseBranch`, `ensureBaseAvailable` are meaningless on a repo with no
PR). They inherit `recreateFromBase` so a re-triggered `build` discards stale
sibling checkouts too.

## Failure policy

Split by class, because the risks differ:

- **Validation rejection** — drop the repo, warn, continue. The rule
  `repo-config.ts:26` already states for untrusted input: "warn, drop the bad
  bits, run anyway". The name is model-authored, so the likely cause is a
  hallucination, and the fallback is a single-repo run — today's behaviour. Log
  at `warn` with full context, because the same signal is what prompt injection
  looks like.
- **Clone failure after validation passed** — fail fast for write workflows,
  warn-and-continue for read. A rejected repo leaves the run no worse than
  today; a failed clone after the plan assumed it leaves the run inconsistent.

## Scope: read-only

Because the ceiling is `min(org config, git_access)`, read-only is a **config
default, not a code branch**. The whole mechanism ships and is exercised end to
end with the org ceiling defaulted to `read`. Proven in triage first.

That already serves the reported use case. Triage answers "the cause is in
`acme/payments-sdk`" through the tools with **no clone and no token widening at
all**; build and pr-fix get sibling source on disk to read while planning.

Write-to-all is a follow-up: raise the ceiling, add per-repo branches, one PR
per changed repo, cross-PR linking, and build-asset partitioning. Its central
question has no precedent here — **there is no cross-repo transaction, so a
half-applied change across two repos is worse than none.**

## Constraints and landmines

- **`unmanagedReposInContext` must be routed through.** The choke-point guard in
  `dispatchWorkflow` (`apps/server/src/index.ts:459`) and the eager 403 in
  `/api/build` (`:1688`) both inspect only `context.repo` and `context.repos`
  (`apps/server/src/managed-repos.ts:113`). A new `secondaryRepos` field would
  silently bypass the allowlist.
- **Cross-installation checkout cannot work.** "One token, N repos" holds only
  *within one installation*: `installationId` is resolved from the run's owner
  (`apps/server/src/engine/agent-executor.ts:152`) and a mint "is scoped to ONE
  installation" (`:47`). The graph **records** cross-installation edges — the
  oracle answer is still correct and useful — but only same-installation
  siblings are materialisable.
- **Marker-ordering bug in the clone loop.** `writeMarker(markerPath, runId)` is
  called *inside* the per-repo clone paths (`sandbox/index.ts:389`, `:455`)
  while `markerPath` is workspace-level (`:308`). Looping naively over
  `[primary, ...secondary]` on a reused workspace means repo A refreshes and
  writes the marker, then repo B reads `lastRun === runId`, takes the "same run,
  preserve" branch (`:322`), and **silently skips its refresh**. Read the marker
  once before the loop; write it once after. Only manifests on reused
  workspaces, so it passes every fresh-workspace test.
- Egress is unchanged: clones go to `github.com`, already allowlisted.

## Open questions

1. **Does the org run Backstage?** `catalog-info.yaml` is designed-for as
   provider #2 behind the same port, and records service/API/system edges no
   package manifest can. A package graph will systematically miss "the upstream
   service that caused the bug" — which is close to the reported case. If those
   files already exist, provider #2 may be worth more than provider #1.
2. **Sibling branch selection.** Matching a same-named feature branch on a
   sibling is a plausible refinement.
3. **Staging scope on public repos.** The staged index describes org structure.
   Narrowing it for runs where the issue body is attacker-influenceable is worth
   a look before enabling this on public repos.
