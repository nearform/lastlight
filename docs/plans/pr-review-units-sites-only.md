# pr-review: units + sites as the only analysis path

Status: **stages 0–4, 6 and 7 built (2026-09-28); 5 (falsify) and 8 (release,
roll-out) open.** Follow-on to [`site-review-recall.md`](site-review-recall.md),
whose conclusions made the units survey + `sites` review engine the best
analysis path measured.

Decisions taken while building:

- **D1** as recommended: `review` keeps its `light` and `baseline` arms; the
  `deep` arm is gone. The triage seed is `{depth: "full", baseline: true}`,
  plus `skipReview` whenever the pipeline is on.
- **D2** option (c): `prepare`, `probe-plan` and `falsify` stay in the YAML but
  skip on `falsifyAttached != true`, which nothing projects — so `probes:
  static|full` no longer pays for probes nothing reads. Stage 5 wires (b).
- **D3** as recommended: `review.analysis.enabled` is refused at boot on
  kubernetes (`assertReviewAnalysisSupported`).
- **D4**: `models.review-site` stays unset in `default.yaml`; overlays pin it.
- **Stage 4**: `obligationContract` kept (it grades the `discharge`
  post-check); `prBody` / `linkedIssues` / the rendered `specObligations`
  dropped (only `specObligationsJson` feeds units). `surveyConcurrency` →
  `siteConcurrency`, the old name mapped per config layer before the merge.
- **Not renamed**: the `adjudicated` demotion label — it is persisted in
  `disposition.json` and the eval archives are read by it; its meaning is now
  "the findings document chose this tier". `computeTier` keeps its name;
  `adjudicatorSummary` became `documentSummary`.
- Two measured prompts changed one phrase each ("probe and adjudicate" →
  "investigate"): `survey-unit.md` and the unit request in `units-render.ts`.
  Both are part of the unit reply-cache key, so each unit is re-asked once.
- The conservation floor's missing-`findings.json` document now says "The
  review did not complete" with `incomplete.phase: "site-finalize"`.

## Goal

Simplify `apps/server/workflows/pr-review.yaml` so that, when
`review.analysis.enabled` is on, the only analysis path is:

```
triage? → facts → seed → units → survey-units → units-ingest
        → site-plan → site-review (5 investigators) → merge → select → site-finalize
        → reconcile → post-review
```

- **Keep:** the triage depth pass and its **light** path (`triage` → `review`
  light arm → `post-review`).
- **Keep, optional:** `falsify`, with `prepare` and `probe-plan`, switched by
  `review.analysis.probes`. It has to be re-attached to the sites engine (D2).
- **Remove:**
  - the agent survey fan-out (`survey`, the five `survey-*.md` prompts, the
    `survey-pass` skill, `seed --blocks`);
  - the old adjudicator (`adjudicate`, `review-adjudicate.md`, the
    `adjudicate-pass` skill);
  - `dossier` and `jev-classify`, and everything only they use (code-facts
    modules, CLI verbs, the TypeSafe dependency, config keys, tests, evals,
    docs);
  - the engine switches `surveyEngine` and `reviewEngine`, since only one
    engine remains.

Why, from the measurements: on the Martian held-out 18, `sites` with cheap
investigators beats the Haiku-investigated arm on recall and posted precision
at ¼–½ of the cost (see `site-review-recall.md`, "Conclusions"). Two survey
engines and two review engines cost a large test and docs surface and many
`skip_if` combinations. One of those combinations is already broken (below).

## Known bug — fix first

**A light re-review under `reviewEngine: sites` posts nothing and fails.**
The light harvest (`src/engine/review-triage.ts:160-172`) replaces the scratch
namespace with `{depth: "light", light: true}`, which clears `skipReview`.
But:

- `review`'s `skip_if` also has `siteReviewEnabled == true` (`pr-review.yaml`,
  `review` phase), a context flag the harvest does not touch, so `review`
  skips;
- `site-finalize` and `reconcile` skip on the light guard.

So no phase writes `findings.json`, and `post-review` fails with "could not
read findings" (`src/workflows/handlers/post-review.ts:404-423`). No golden
test covers light + sites: the sites block is `golden-pr-review.test.ts:881-963`,
and the light tests near 999 and 1105 do not set sites.

This is confirmed by reading the code, not yet by a test. Write the failing
golden test first. The likely fix: `review` skips only on the scratch flag
`scratch.reviewTriage.skipReview`. The seed sets it when analysis is on, and
the light harvest already clears it. This matters before the change and
becomes the only path after it.

## Decisions to make before building

- **D1 — Does `analysis.enabled: false` survive?** Today it is the shipped
  default: `review` (the plain whole-diff reviewer, `review.md` baseline arm)
  is the entire review. The light path needs `review` anyway, so keeping
  analysis-off costs little. It is also the zero-config fallback, and on the
  6 cal.com cases it still beats every `sites` arm (9/18, against luna's 7
  and 4). *Recommendation:* keep `review` with its **light** and **baseline**
  arms, and delete only its **deep** arm (`review.md:5-64`), which exists only
  for `independentReview` beside the adjudicator.
- **D2 — Where does `falsify` attach?** Today it skips under sites, nothing
  in the sites engine reads `probes/verdicts.jsonl`, and the investigators
  already run their own probes (their `none` gate requires an executed
  command). Options:
  - **(a)** Before `site-plan`: falsify the survey rows, and drop or de-weight
    refuted rows' votes so sites form on surviving suspicion.
    `planProbeSites` (`packages/code-facts/src/site-cluster.ts:301`) is built
    for this but not wired.
  - **(b)** After `select`: falsify the selected findings before
    `site-finalize`, as a precision gate.
  - **(c)** Keep the phases but leave them unwired under sites, and decide
    later.

  *Recommendation:* (b). The measured gap is posted precision
  (deepseek-v4-flash), and a probe per posted finding is bounded (≤ 10 per
  PR). But (b) needs its own measurement. Do (c) in the removal work, and (b)
  as a separate, measured step.
- **D3 — Kubernetes.** `assertSurveyEngineSupported` (`src/config/config.ts:1975`)
  refuses units on k8s. With units the only engine, analysis cannot run
  there at all. Refuse `analysis.enabled` on k8s at boot with a clear
  message, or make units work there. *Recommendation:* refuse at boot for
  now.
- **D4 — Default investigator model** (`models.review-site`). Today it falls
  back to `review-survey` (Haiku). The measured candidates are
  `openai/gpt-6-luna` (medium) and `opencode/deepseek-v4-flash` (medium).
  Choosing needs posted-precision grades, not gold (`site-review-recall.md`,
  conclusion 4). A default needs a provider key every deployment has, so it
  may stay unset in `default.yaml`, with overlays pinning it.
- **D5 — Migration.** Both production overlays switch engines on upgrade:
  - `cliftonc/lastlight-instance` has analysis on with the default agent
    survey and adjudicate;
  - `nearform/lastlight-nearform` sets `adjudicate: dossier`,
    `models.review-adjudicate: opencode/glm-5.3`, `probes: static`,
    `probeRounds: 1`, `models.review-falsify`.

  Decide whether each gets a `models.review-site` pin before the release, and
  whether nearform's `probes: static` is kept (it only matters once D2 is
  built). Dead keys go through the existing "accepted, ignored, warn" pattern
  (`REMOVED_ANALYSIS_KEYS`, `src/config/config.ts:1812-1822`), so an
  overlay that pins them keeps booting.

## Stages

Each stage lands green (`pnpm turbo run typecheck test build`) on its own.

### 0. Guard

- A golden test for light + sites (the bug above). Fix it.
- Golden tests pinning the kept path's phase order and edges: units → sites →
  reconcile → post-review, and light → review → post-review. They should be
  written against the target shape, so later stages only delete tests.

### 1. One engine

- `review.analysis.enabled` implies units + sites. Delete the `surveyEngine`
  and `reviewEngine` checks: the `unitSurveyEnabled` and `siteReviewEnabled`
  projections in `specContext` (`src/engine/pr-decisions.ts:1801, 1809`),
  and every `skip_if` that reads them.
- `review` skips only on `scratch.reviewTriage.skipReview` (see the bug fix).
  `reviewTriageSeed` (`src/engine/review-triage.ts:90-100`) sets
  `skipReview` = analysis on. `deep` and `independentReviewEnabled` go.
- Re-point the DAG edges:
  - `site-plan` depends on `units-ingest`, no longer on `survey`;
  - `reconcile` depends on `site-finalize`;
  - `post-review` stays `none_failed` on `review`, but check the trigger
    rule now that `review` always skips on the full path.

### 2. Remove the agent survey

- **Workflow:** the `survey` phase.
- **Prompts:** `survey-{contract,enforcement,security,state,spec,tests}.md`.
  `survey-tests.md` is already orphaned.
- **Skill:** `survey-pass`. It is a fixture name in
  `tests/sandbox/declared-skills-only.test.ts`, so rename the fixture.
- **code-facts:** `seed-render.ts` and `seed --blocks`, and the per-family
  block check in the `seed` phase. `units` reads `obligations.json`, not the
  blocks.
- **Config:** `surveyPasses`, already unconsumed.
- **Core:** `renderSpecObligations` (`src/engine/review-spec.ts:783-830`) and
  the `specObligations` projection feed only `survey-spec.md`. Keep
  `specObligationsJson`, which feeds units.

### 3. Remove the adjudicator, dossier and jev

- **Workflow:** the `adjudicate`, `dossier` and `jev-classify` phases.
- **Prompt and skill:** `review-adjudicate.md`, `adjudicate-pass`.
- **code-facts:**
  - `jev-classify.ts` and `jev-classify-io.ts`, and the CLI `jev-classify`
    verb;
  - `adjudicate-render.ts` and the CLI `dossier` verb;
  - `adjudicate-admit.ts`;
  - the `findings` gate mode and `--ledger`;
  - `@typesafe-ai/sdk` in `packages/code-facts/package.json`.
- **Untangle first:**
  - `pathOfRow` lives in `adjudicate-render.ts`, but `site-cluster.ts:53`
    and `apps/evals/src/site-summary.ts:41` use it. Move it into
    `hypotheses.ts` or similar.
  - `findings.ts:61` imports `readAdmission`, and honours `admission.json` at
    263 and 813. Remove that path.
  - `site-cluster.ts:55` imports `planProbes` from `probe-plan.ts`. Keep it;
    `probe-plan.ts` stays for falsify.
- **Rename, don't delete** (sites uses them):
  - `computeTier` in `src/engine/github/review-poster.ts`, documented as the
    "dossier output half";
  - `adjudicatorSummary` in `review-summary.ts`;
  - the `adjudicated` demotion label.

### 4. Config cleanup

- Remove from `default.yaml`, `packages/shared/src/config-types.ts`,
  `repo-config-schema.ts` and `config.ts`, adding each to
  `REMOVED_ANALYSIS_KEYS` so an overlay that pins it warns and boots:
  - `surveyEngine`, `reviewEngine`, `independentReview`
  - `adjudicate`, `jevModel`, `admit`, `jevTimeoutSeconds`, `surveyPasses`
  - `models.review-adjudicate`
- **`jevTimeoutSeconds` is a REQUIRED duration:** `requiredSeconds` throws
  when it is missing, and it appears in the `ReviewAnalysisDurationKey` union
  and `withReviewDurations`. Remove it from all of those in one commit.
- **Rename `surveyConcurrency`**, which now bounds only `site-review`'s
  `max_concurrent`. Rename to `siteConcurrency`, keeping the old key as an
  alias.
- **`obligationContract`** now only toggles the `discharge` post-check that
  `units-ingest` reports, so decide whether to keep it.
- **`prBody` and `linkedIssues`** are projected but no prompt reads them. Drop
  them, or give them to the investigators; that would be a measured change.

### 5. Falsify (D2)

The removal stages leave `prepare`, `probe-plan` and `falsify` intact but
never scheduled under sites (option c). Attaching them under option (b) is
its own change with its own arm: replay on the 10 recall sites first, then
end to end at 2 or more repeats. Also:

- `review-falsify.md` says rows "survive to adjudication" (62, 103, 191, 218).
  Reword it.
- `prepare` runs whenever probes are on, but under sites nothing reads
  `env.json`. Gate it on falsify actually running.

### 6. Evals

- **Delete or archive:**
  - `scripts/micro-adjudicate.ts`
  - `scripts/micro-survey.ts`, `micro-survey-backfill.ts`, `survey-cost.ts`,
    `seed-questions.ts`
  - `scripts/jev-hypothesis-probe.ts`, `say-gap.ts`
  - `scripts/aacr-adjudicate.ts` and `finding-calibration.ts` (standalone
    TypeSafe research)
  - `@typesafe-ai/sdk` in `apps/evals/package.json`
  - the `"adjudicate"` `PhaseKind` in `src/phase-replay.ts`
- **Keep:**
  - `unit-survey-replay` (its agent-survey comparison side becomes historical)
  - `micro-site-review`, `cluster-screen`, `seed-fixtures`
  - `micro-falsify`, if D2 keeps falsify
  - the shared helpers in `src/micro-survey*.ts`, which unit-survey-replay,
    micro-site-review and unit-survey-index import
  - `src/labels*.ts`
- **Overlays in `~/work/nearform-evals/overlays/`:** most measure the removed
  path (`adjudicate: dossier/jev`, `models.review-adjudicate`, the default
  agent survey). They stay runnable only against a pre-removal core; note
  that in the evals README rather than deleting them.

### 7. Docs

Run the `docs-sync` skill. Known surfaces:

- **`apps/server/spec/`:**
  - 02: the `ReviewAnalysisConfig` block, the models, the `review.analysis`
    table row and the independentReview / surveyEngine / reviewEngine
    paragraphs;
  - 06: the fan-out examples, which are survey-centric;
  - 07: the pr-review prompt table;
  - 08: the survey-pass and adjudicate-pass rows.
- **`apps/server/src/workflows/CLAUDE.md`** and **`apps/server/CLAUDE.md`**
  ("only under the experimental `surveyEngine: units`").
- **`apps/www`:** `configuration.astro` and `cli.astro` (the `lastlight
  facts` verbs).
- **`packages/code-facts/CLAUDE.md`:** the `discharge`, `findings`, `units`,
  `dossier --admit` and `sites` sections.
- **`apps/evals/CLAUDE.md`:** the script table.
- **Stale wording in kept files:**
  - `skills/pr-review/references/findings-schema.md:21-24`
  - `skills/code-review/SKILL.md:60-63, 175`
  - `survey-unit.md:23`, `review-site.md:9, 115`, `review-select.md:7`

### 8. Release and roll out

- This is prod-facing, so it needs a release (`docs/RELEASING.md`).
- Pin `models.review-site` in each overlay per D4 and D5, then bump
  `deploy.version` and push. Both overlays auto-deploy on push.
- Watch the first reviews on each host: cost per PR, posted comments per PR,
  and any `post-review` failure.

## What stays unchanged

These are generic, and site-review uses them:

- the `fanout` handler (`context_file`, `on_branch_gate_failure`,
  `until_bash`);
- the `survey-units` handler and its reply cache;
- `post-review`;
- `reconcile` (`findings --repair`, `stampDerivedSeverity`);
- `facts`, `seed` (obligations for units), `units` and `units-ingest`, with
  `discharge` as its reported post-check;
- the whole `sites` code in code-facts (`site-review.ts`, `site-cluster.ts`).

## Inventory source

Mapped on 2026-09-28 by a read-only sweep of the tree, with file and line
references. Line numbers will drift; re-grep before editing. The sweep's
full inventory (phase table, context-var sources, config keys by fate,
prompts, code, tests, evals, docs, overlays) is summarised in the stages
above. The most useful anchors:

- **Context vars:** `specContext` (`src/engine/pr-decisions.ts:1725-2078`)
  and `triageContext` (1638-1668).
- **Config:** `review.analysis` in `default.yaml` 484-842; the types in
  `config-types.ts` 368-778, with defaults at 975-1036; the parse in
  `config.ts` 1405-1529.
- **Tests to delete or rewrite:**
  - `pr-review-adjudicate.test.ts` (all)
  - `pr-review-survey.test.ts` 106-243, 386-600
  - `golden-pr-review.test.ts` 241-560, 727-880, 965-1320
  - `pr-review-command-policy.test.ts` 82-95
  - `policy-blocks-boot.test.ts` 232-330
  - `pr-decisions.test.ts` 1662-1737
  - in code-facts: `jev-classify`, `adjudicate-admit`, `adjudicate-render`
    and `seed-render` tests, plus parts of `cli`, `probe-plan` and
    `findings` tests
