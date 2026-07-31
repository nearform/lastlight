# Phase 5 — Major-bump impact classification (#252)

> **Superseded in part by [09-state-machine.md](09-state-machine.md) → D10.**
> §5.5 gates only *direct* merge on `{{checksSettledPassing}}`, on the
> assumption that GitHub's required-checks gate backstops auto-merge. On a repo
> with **no required checks** that gate does not exist and auto-merge merges
> immediately — so this phase would hand **major** bumps an ungated path on
> exactly the repos the plan already documents as hazardous. Both merge actions
> are gated by one `mayMerge` predicate instead.

**Risk: low.** Depends on Phase 3 for `checksSettledPassing`.

Today the only rule about bump magnitude in the codebase is one prose conjunct
in the TRIVIAL test (`prompts/dependabot-pr-merge.md:79`): *"it is not a
**major** version bump of a runtime dependency."* Every major therefore becomes
FUNCTIONAL → `dependency-functional` + `requires-human`, whether it is a
`@types/*` dev bump or a runtime framework rewrite.

Goal: classify majors as **low / medium / high** impact from evidence, and
auto-merge those at or below a configured ceiling.

## 5.1 — A `dependency-impact` skill

`apps/server/skills/dependency-impact/SKILL.md` (new), added to
`dependabot-pr-merge`'s phase as `skills: [code-review, dependency-impact]`.

A skill rather than more prompt prose, for two concrete reasons:

- **Progressive disclosure.** The assess prompt is already 219 lines. The
  rubric is only needed when the PR *is* a major, and pi surfaces skills as an
  on-demand catalogue the agent reads when relevant.
- **It becomes per-repo tunable for free.** A managed repo can override
  `skills/dependency-impact/SKILL.md` in its own `.lastlight/` (issue #180
  allows repo skill overrides), which is exactly the per-repo tuning this work
  is meant to enable — without the operator having to widen `allowKeys`.

## 5.2 — Evidence, with no checkout

`dependabot-pr-merge` has **no working tree** by design and must keep it that
way — it is the cheap path. Every tool below is already in `READ_TOOLS`
(`packages/agentic-pi/src/extensions/github/profiles.ts:26`), so all of them
are available under the workflow's existing `repo-write` profile.

| # | Evidence | How |
|---|---|---|
| 1 | Release notes / changelog / breaking-change headings | `github_get_pull_request` → the **body**. Dependabot embeds Release notes, Changelog and Commits sections, plus a compatibility-score badge |
| 2 | Dev vs runtime dependency | The manifest change: `dependencies` vs `devDependencies`. `@types/*`, linters, formatters and test runners are dev-only; so are GitHub Actions tag bumps |
| 3 | Blast radius | `github_search_code` for `from "<pkg>"` / `require("<pkg>")` — count import sites |
| 4 | Security sensitivity | Does the package sit in auth, crypto, serialization, network, file I/O, or database-driver territory? |
| 5 | Behavioural evidence | `{{checksState}}` from Phase 3 — deterministic, not inferred from `mergeable_state` |

Evidence 5 is the pivot that makes this safe: **the suite already ran against
the bump.** Passing CI is real behavioural evidence. Release notes and blast
radius are there to catch what tests miss — a breaking change in a runtime path
the suite does not cover.

The existing STEP 1 tiering discipline stays intact: never pull a lockfile
diff, judge from the file list and PR title first.

## 5.3 — The rubric

- **low** — dev-only dependency, **or** a GitHub Actions tag bump, **or** zero
  direct import sites; no documented breaking changes; CI settled `passing`.
- **medium** — runtime dependency, CI settled `passing`, breaking changes
  documented but none matching the repo's actual usage (few import sites, none
  touching the named APIs), not security-sensitive.
- **high** — security-sensitive domain, **or** many import sites, **or**
  breaking changes plausibly touching used APIs, **or** CI not settled
  `passing`, **or** release notes missing/unparseable.

**Unknown ⇒ high.** The rubric must be explicit that inability to gather
evidence is itself a high-impact signal, not a reason to guess low.

## 5.4 — Labels

Keep `dependency-trivial` / `dependency-functional` (they are load-bearing for
discovery) and **add**:

- `dependency-major-low` — `0e8a16`
- `dependency-major-medium` — `fbca04`
- `dependency-major-high` — `b60205`

Add the constants next to `DEP_TRIVIAL_LABEL` in
`apps/server/src/cron/dependabot-discovery.ts:55`, which is the single source
of truth, and extend `apps/server/tests/cron/label-vocab.test.ts` — it asserts
those exact strings appear in the prompt files, and is the only thing keeping
code and markdown in sync.

`dependency-functional` + `requires-human` continue to mean high impact, so
discovery behaviour for the escalated case is unchanged.

## 5.5 — Prompt changes

`apps/server/workflows/prompts/dependabot-pr-merge.md`:

- **STEP 2** — the "not a major version bump" conjunct becomes a *branch into
  the rubric* rather than an automatic FUNCTIONAL. Non-major bumps are
  unaffected: the existing TRIVIAL test still governs them.
- **STEP 2b** — the label state machine gains the three impact labels, applied
  and cleared with the same idempotent `github_ensure_labels` +
  `github_add_labels` / `github_remove_label` discipline, and the same
  "never touch a label outside this vocabulary" rule (Renovate's `rebase` label
  must survive).
- **STEP 3** — a major at or below `{{dependencies.autoMergeMaxImpact}}` gets
  `github_enable_auto_merge` (squash), plus — when
  `{{dependencies.auditComment}}` — **one** comment stating the impact tier and
  the evidence used. High keeps today's `dependency-functional` +
  `requires-human` path, including the rebase nudge that #245 made independent
  of the verdict.
- **Direct merge is gated on `{{checksSettledPassing}}`**, replacing the
  current "confirm `mergeable_state` is exactly clean" heuristic with the
  code-computed fact. This is the concrete fix for the hazard the prompt
  already documents at line 143.
- **Marker extended**:
  ```
  ASSESSMENT_COMPLETE: pr=<N> verdict=<TRIVIAL|FUNCTIONAL> impact=<none|low|medium|high> action=<automerge|merge|rebase|rebase-and-human|comment|already-handled>
  ```
  `requires_marker` matches the literal `ASSESSMENT_COMPLETE` prefix, so
  appending a field is backward-compatible with the existing contract test.

### Comment-spam discipline

The audit comment adds one comment per auto-merged major, and the cron re-runs
daily. The prompt's existing anti-repeat rules — *"At most two comments, ever"*
and *"skip the comment when `requires-human` was already present before this
run"* — must be extended to cover it: skip when an equivalent audit comment is
already on the PR, or when the impact label was already applied before this
run.

## Files

| File | Change |
|---|---|
| `apps/server/skills/dependency-impact/SKILL.md` | new |
| `apps/server/workflows/dependabot-pr-merge.yaml` | `skills: [code-review, dependency-impact]` |
| `apps/server/workflows/prompts/dependabot-pr-merge.md` | STEP 2 / 2b / 3 + marker |
| `apps/server/src/cron/dependabot-discovery.ts` | three label constants |

## Tests

- `tests/workflows/dependabot-pr-merge.test.ts` — the impact vocabulary is
  present; direct merge is gated on the settled flag; the skill is wired; the
  `#245` rebase-independence assertions still pass.
- `tests/cron/label-vocab.test.ts` — the three new constants appear verbatim in
  the prompt.
- An evals case per impact tier (see [06-config.md](06-config.md) →
  Verification).

## Done when

- A `@types/*` major on a green PR auto-merges with an audit comment (with
  `autoMergeMaxImpact >= low`).
- A major in an auth/crypto package, or one with many import sites, still gets
  `requires-human`.
- No major can direct-merge while checks are `pending` or `none`.
