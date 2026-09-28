# Site review recall — why the investigators miss gold

Status: **concluded (2026-09-28).** The investigator prompt is now h13 and
cheap investigator models beat Haiku end to end. The next step is structural:
[`pr-review-units-sites-only.md`](pr-review-units-sites-only.md) makes units +
sites the only analysis path. Follow-on to
[`adjudicate-falsify-replay.md`](adjudicate-falsify-replay.md), whose
[Pipeline integration](adjudicate-falsify-replay.md#pipeline-integration-the-sites-review-engine-built-2026-09-28-unmeasured)
section built the `sites` review engine (`review.analysis.reviewEngine:
sites`).

## Conclusions

1. **The loss was in the investigators, and the prompt was part of it.** In
   the first `sites` arm (Haiku investigators, Martian held-out 18), 11 of 20
   attributable gold misses sat inside a site that was investigated. The
   investigator stopped at its first defect, or closed `none` after probing
   only its own first suspicion. `select` and posting lost almost nothing.
2. **h13 is the shipped `review-site.md`.** It has four generic changes, and
   nothing is tuned to a case:
   - sweep every changed statement against a fixed list of defect classes,
     and finding one defect does not close the site;
   - the realistic-operation rule covers the environment, never the author's
     intent;
   - two tests before any finding: the PR caused it (compare with
     `origin/<base>`), and a real caller reaches it;
   - model a library that isn't installed, and write a confirmed defect as
     `read` rather than drop it.

   On Haiku the sweep alone (h12) raised volume but added only false
   positives; the two tests (h13) removed them (6 not real → 2). On luna,
   h13 produced the best replay arm: 14 findings, 13–14 real by Fable, 0–1
   not real.
3. **Cheap models beat Haiku as investigators.** End to end, same 18 cases,
   judge gold on the POSTED review:

   | investigator | draws | matched (of 54) | micro-P | micro-R | $/PR | wall/PR |
   |---|---|---|---|---|---|---|
   | Haiku 4.5 (control prompt, 16 cases) | 1 | 13/44 | 0.35 | 0.30 | 1.37 | 8.3 min |
   | `openai/gpt-6-luna`, medium | 2 | 24, 19 | 0.47, 0.40 | 0.44, 0.35 | 0.37 | 5.5 min |
   | `opencode/deepseek-v4-flash`, medium | 2 | 26, **28** | 0.37, 0.41 | 0.48, **0.52** | 0.61 | 9.5 min |

   The Haiku arm also used the pre-h13 prompt, so this row mixes a model
   change with a prompt change. The replays separate the two: on the same
   h13 prompt, Haiku stayed at 3 real findings and 3 gold for $2.75 per 10
   sites.
4. **luna and deepseek trade precision and cost against recall.**
   - luna: fewest comments (2.6 per PR), best precision, cheapest and fastest.
   - deepseek: most recall, and it reaches the gold luna never finds
     (cal-com-8330, cal-com-14943, keycloak-37634). It posts 3.8 comments per
     PR at about 1.6× luna's cost.

   Which is better depends on posted precision against real defects, not
   gold. That is **not yet graded**; it is the next measurement before
   choosing a default for `models.review-site`.
5. **Gold undercounts real defects.** Fable's must-fix findings that no gold
   names include:
   - a date-override double booking (cal-com-8330);
   - a device-limit bypass through the cache (grafana-79265);
   - `ResizeEmoji` calling the changed `downsize` signature (discourse-graphite-1).

   At least one gold entry looks wrong: grafana-79265#2's "won't compile" claim
   is disproved by xorm's `Exec(...interface{})`. Score arms on real defects
   (human, or Fable as a pre-grade), not gold alone ([[human-grades-primary]]).
6. **Variance is large; read bands, not points.** Three identical luna
   replays recovered 2, 3 and 5 of 11 misses. End to end, luna's two repeats
   matched 24 and 19. Every conclusion above rests on at least two draws,
   except the Haiku e2e row.
7. **Still open:**
   - **H3, selection coverage:** 9 of 20 misses were never investigated, and
     the shipped whole-diff reviewer still beats every `sites` arm on cal.com.
   - **Pairing two investigators on one site:** the models' blind spots are
     complementary.
   - **qwen3.8-flash:** the only arm to find the dayjs `===` bug, but too
     slow to run.

## Operational notes

- Fixtures: `~/lastlight-micro-fixtures/2026-09-28-sites-e2e-workspaces/`
  (the 9 cases' kept e2e workspaces, `target-sites.txt`). Prompts, `score.py`
  and every Fable batch and proposal file:
  `~/lastlight-micro-fixtures/2026-09-28-site-recall-prompts/`. Fable
  proposals are merged into `eval-results/labels/proposals-fable.jsonl` and
  shown in `#/grade`.
- Replay a chosen set of sites: `micro-site-review … --sites
  <instance>:<rank>,…` (new).
- Overlays: `~/work/nearform-evals/overlays/sites-{haiku,luna,dsv4flash}`.
  `variants.site-review` sets the investigators' thinking level (the fan-out
  resolves `variants[<phase name>]`).
- The eval's `--instance` takes a comma list. Without it, `pr-review-martian`
  runs all 50 cases, not the 18 held-out ones.
- OpenCode Zen enforces an account budget. When it runs out, every call
  returns 429 `Account budget exceeded` and the run is unusable. Smoke-test
  one case before a long arm.

The sections below are the working record in the order it happened.

## The run

- Arm: `~/work/nearform-evals/overlays/sites-haiku` (units-v7 survey on Haiku,
  `reviewEngine: sites`, Haiku investigators via `review-survey`, `select` on
  Sonnet 4.6 via `default`, `probes: off`, 5 inline / 5 body).
- Run: `eval-results/pr-review-martian-config/2026-09-28_050504-4dd91f8`.
  It was stopped at **16 of 18** cases on purpose, so treat its aggregate as
  partial.
- Also a one-case smoke run, `…/2026-09-28_045009-4dd91f8` (cal-com-22532:
  $1.69, 6m19s, 3 posted, 0/2 gold).
- Cost ≈ $1–1.9 per PR, about 6 min per case.
- **Result: 13 of 44 gold matched in the posted review (micro-recall 0.30).**
  On the cal.com cases that overlap the plain shipped reviewer
  (`overlays/baseline`, `2026-08-24_121400-64862d5`), the **baseline matched
  4/8 and posted 11; sites matched 2/8 and posted 7**. Over the 6 cal.com cases
  that run covered, the baseline matched 9/18 for $5.70.
- **The integration is faithful.** On the first 7 finished PRs the pipeline
  matched 3 gold, against 5 stated by the arm A v2 replay (same investigator,
  no `select`). That gap is inside run-to-run variance.
- **`select` is not the loss.** Per PR, 2–4 findings are pooled and nearly all
  of them are posted; it merged the one true duplicate it saw (F3/F4 in the
  smoke run).

Two harness bugs were found and fixed during the run:

- **`baseBranch` read `main` for `master`-based PRs.** `pr-context.ts` now
  takes the instance's `pr.base_ref`. The three sentry cases in this run
  predate the fix, so their findings all went to the body.
- **In-process bash phases used `spawnSync`**, which froze the eval process
  and its live dashboard. Now `runHostCommand` spawns asynchronously. Prod is
  docker-only, so this was never a prod path.

## Where the gold died

A $0 classification of every gold in the 16 cases. Gold is located by the
lexical anchors in `~/lastlight-micro-fixtures/martian-instances-anchored.json`
(derived, never commit it). Sites are re-ranked with `planSiteSlots(top: 500)`
over each kept workspace's hypothesis rows.

| where the gold was | matched | missed |
|---|---|---|
| inside a top-5 site whose investigator reported a finding | 10 | 6 |
| inside a top-5 site closed `none` | 0 | 5 |
| in a test file, which site selection skips (all were in the diff) | 0 | 4 |
| in a changed file, but its site ranked 6–9, or no site formed near it | 1 | 5 |
| no anchor, or the anchored file is not in the diff (anchor error, unattributable) | 2 | 11 |

So of the 20 attributable misses, **11 were inside investigated sites** and
**9 were never investigated**.

Investigator outcomes over all 80 slots: **1 finding: 40 sites**, 2 or 3
findings: 6, `none`: 27, empty slot: 7. The 55 findings were labelled
must-fix 35, worth-mentioning 20, nit 0.

The per-gold table, the classification script and the site-output dump are in
`~/lastlight-micro-fixtures/2026-09-28-sites-e2e-analysis/` (`gold.json`,
`classify.mts`, `inside.py`). The run's kept workspaces live under
`/var/folders/…/T/ll-eval-*`, which macOS reclaims within days; every number
here is reproducible from `gold.json`.

## Hypotheses

Ranked by the evidence behind them. The cheap tests use `micro-site-review`
over the existing units-v7 fixtures
(`~/lastlight-micro-fixtures/2026-09-27-martian-units-v7-haiku/`, with
`--instances` pointing at the anchored Martian instances). Its prompt is the
pipeline's `review-site.md`, so a replay tests exactly what ships.

### H1 — one and done

Once an investigator finds a defect, it writes it up and stops. 40 of the 46
sites that reported anything reported exactly one finding. The 6 misses inside
reporting sites are a second defect next to the reported one:

- `cal-com-8330`: reported a wrong-variable bug at L143; missed the `===` on
  dayjs objects at L119.
- `cal-com-14943`: reported the `deleteMany` filter at L39; missed the stale
  `retryCount + 1` on the same line.
- `discourse-graphite-10`: reported a nil-host crash at L6; missed the
  un-normalised `lower(host)` comparison at L10.

The prompt pushes toward it: "the strongest first", "~20 tool calls, then
write", "None is a normal answer".

*Test:* before writing, the investigator must sweep every changed statement in
the site. Writing fewer than 3 findings then requires listing the other
suspicions it checked. Replay the 6 sites (about $2). Success means the second
defect surfaces without precision collapsing; grade on the human labels, not
gold alone ([[human-grades-primary]]).

### H2 — a `none` answers only the investigator's own suspicions

The probe gate forces execution, but on questions the investigator chose. The
gold was a class it never asked about, or asked about on the wrong axis:

- `grafana-79265`: `dbSession.Exec(args...)` given a `[]interface{}` does not
  compile. The investigator probed the time-window logic.
- `grafana-97529`: it flagged the new `s.search.TotalDocs()` call, but probed it
  for side effects, not for the race with concurrent index creation.

Some dismissals rest on assumed intent: "stubs are intentionally non-functional"
(`grafana-94942`) and "negligible timing differences". The realistic-operation
rule, added to cut hypothetical-environment false positives, may be licensing
these.

*Test:* give every `none` a fixed defect-class checklist to address:
concurrency and races, does it compile and type-check, contract and
nullability, input normalisation, stale read and lost update, boundaries.
Narrow the realistic-operation rule to environments (storage blocked,
implausible users), not code intent. Replay the 5 `none` sites (about $2). Watch
the false positives the rule was written for (the arm A/C human grades).

### H3 — five vote-ranked sites cover too little of the diff

9 of 20 attributable misses were never investigated: 4 in test files (Martian
gold includes test-code bugs, such as `AssertEvents.java`'s inverted substring
check), and 5 below the cut (ranks 7 and 9) or nowhere near a site. The shipped
reviewer reads the whole diff, which is the likeliest reason it hits more.

*Tests:*

1. **$0 audit:** how much attributable gold each selection change covers.
   Options: include test files at a lower rank, top 8 instead of top 5, and
   add a site for every changed hunk the survey cast no vote on. Each costs an
   extra investigator per added site (~$0.25), so report coverage per $.
2. **Hybrid (paid):** keep the sites and feed the shipped whole-diff reviewer's
   findings (`independentReview`, today skipped under `sites`) into `merge` as
   a sixth source for `select` to dedupe. About +$0.5–1 per PR. This attacks
   "the baseline hits more" head on, but needs `site-finalize` to accept a
   second source.

### H4 — confound: Haiku vs Sonnet

The investigators run Haiku; the baseline reviewer runs Sonnet. Some of H1/H2
may be model strength.

*Test:* replay the same 11 in-site misses with `--model
anthropic/claude-sonnet-4-6` (about $6), before and after the H1/H2 prompt
change. That separates the prompt effect from the model effect.

## Replay results (2026-09-28)

### Setup

- **Fixtures.** The e2e run's own kept workspaces for the 9 cases holding an
  in-site miss, copied to
  `~/lastlight-micro-fixtures/2026-09-28-sites-e2e-workspaces/`. Each
  checkout's `.lastlight/pr-review` is restored to its pre-`site-plan` state;
  the run's `sites/`, `findings.json`, `disposition.json` and sessions sit in
  `<case>/e2e-outputs/`. `micro-site-review --leads none` re-forms exactly the
  pipeline's slots from them (checked against every `plan.json`).
- **Targets.** 10 sites (`target-sites.txt` beside the fixtures), picked with
  the new `--sites <instance>:<rank>,…` flag. They hold 11 in-site misses and 3
  gold the e2e run matched.
- **Prompts.** `~/lastlight-micro-fixtures/2026-09-28-site-recall-prompts/`:
  - `control`: the prompt the e2e run used.
  - `h12`: H1 + H2 — sweep every changed statement, a fixed list of defect
    classes, finding one defect does not close the site, the
    realistic-operation rule narrowed to environment and not intent.
  - `h13`: h12 plus the two tests before any finding (the PR caused it: compare
    with `origin/<base>`; a real caller reaches it), "model a missing library,
    and a confirmed read is still a finding", and a configuration defect class.
    **h13 is now the shipped `review-site.md`.**
- **Grading.** `score.py` scores the judge's gold (`gold-stated`). Fable graded
  every finding blind, in sub-agents, against the checkouts. It sees the finding
  text, the checkout and the PR's gold list, never the arm or the model. Its
  proposals are appended to `eval-results/labels/proposals-fable.jsonl` and
  shown in `#/grade`. **None of this is human-graded yet.**

### Results (one draw per arm; Fable proposals)

| arm | findings | real | not real | must-fix | distinct gold | $ (10 sites) |
|---|---|---|---|---|---|---|
| control · Haiku | 6 | 4 | 2 | 0 | 3 | 3.03 |
| h12 · Haiku | 10 | 4 | 6 | 0 | 3 | 3.06 |
| h13 · Haiku | 5 | 3 | 2 | 0 | 3 | 2.75 |
| control · luna/low | 6 | 5 | 1 | 1 | 3 | 0.05 |
| h12 · luna/low | 7 | 6 | 1 | 2 | 3 | 0.04 |
| control · luna/medium | 9 | 8 | 1 | 2 | 3 | 0.09 |
| h12 · luna/medium | 14 | 13 | 1 | 4 | 4 | 0.12 |
| **h13 · luna/medium** | **14** | **14** | **0** | **5** | **5** | **0.12** |

luna is `openai/gpt-6-luna`; `/low` and `/medium` are its thinking level.

- **h12 fixed one-and-done, and on Haiku it added noise.** Findings went up and
  `none` closes went down on both models. On luna the extra findings were real
  (8 → 13 at medium). On Haiku all 4 extra were graded not real: code
  unchanged from the base branch, and scenarios that need a caller that does
  not exist.
- **h13's two tests removed that noise.** Haiku went from 6 not real to 2 with
  the same gold, and luna from 1 to 0.
- **luna is not faster per turn** (≈ 4–5 s against Haiku's 5–6 s). It batches
  reads (whole regions and chained greps per call) and stops sooner: about 9
  turns per site at low, 13–17 at medium, against Haiku's 30–45. Haiku also
  breaks the prompt's rules: it `cd`s to absolute paths and writes probes to
  `/tmp`.
- **The two models find disjoint gold.** No luna arm finds the gold Haiku
  keeps (cal-com-8330#0, cal-com-14943#1, discourse-graphite-10#0). luna
  alone finds grafana-79265#0, grafana-97529#1 and discourse-graphite-10#2.
  keycloak-40940#0 is found by every luna arm but by Haiku only on h12/h13.
- **The top defects are outside the gold.** Fable's must-fix findings that no
  gold names: on a date-override day, `checkIfIsAvailable` returns before the
  busy check, so booked times show as free (cal-com-8330); and a device
  refused at the limit gets in on the next reload within the cache TTL,
  because `tagDeviceUI` caches the key before the write fails
  (grafana-79265). Scoring on gold alone would have called both noise.
- **The targeted fixes are unconfirmed.** In h12, Haiku recognised the dayjs
  `===` bug in cal-com-8330, could not import dayjs, and dropped it. In h13
  it read the same line as "checks if start equals end" and never flagged it,
  so the "a confirmed read is still a finding" rule was never exercised. No
  arm found the animated-GIF configuration gold.

### Gold no arm reaches, and why

- **grafana-79265#2 ("won't compile") is probably wrong.** `DBSession`
  embeds xorm's `Session`, whose `Exec(sqlOrArgs ...interface{})` accepts
  `args...`.
- **grafana-94942#1 is contested.** The PR's stated purpose is to disable SQL
  expressions for CVE-2024-9264, so the stubs are the fix. Fable graded the
  same finding "no" in one batch and "yes" in another. The investigators do
  not get the PR description; giving it to them would pull against H2's "not
  intent" rule.
- **grafana-79265#3/#4** are low-severity naming and consistency points;
  Fable grades the findings near #4 not real.
- **cal-com-8330#1** (dayjs `===`), **discourse-graphite-1#2** (animated GIF
  under a setting value) and **cal-com-22345#1** (a filter that drops org
  members; every arm closed that site `none`) are real and remain open.

## Suggested order

1. ~~H1 + H2 as one prompt change, one replay of the 11 in-site misses.~~
   Done: h12, then h13 (above).
2. ~~H4 on the same sites.~~ Superseded by the luna comparison. Sonnet is still
   untested.
3. ~~h13 luna/medium repeated ×2 on the same 10 sites.~~ Done. By judge gold,
   the three draws recovered 3, 2 and **5** of 11 in-site misses (gold
   stated 4 / 3 / 6), at $0.12 each. None kept any of the 3 gold Haiku
   finds. Repeat 2 is the first arm to find discourse-graphite-1#2, the
   animated-GIF configuration gold. Recall swings run to run, as warned, but
   every draw is at or above Haiku (1–2 of 11). Fable grades of the three
   draws (findings / real / must-fix / distinct gold): 14 / 14 / 5 / 5,
   10 / 10 / 3 / 3, 14 / 13 / 2 / 6. Precision holds at 93–100% across
   draws. The one "no" (MySQL `RowsAffected == 0` on a no-op UPDATE) is
   refuted by `clientFoundRows=true` in `sqlstore.go`.
4. ~~End-to-end Martian arm with luna/medium investigators.~~ Done:
   `overlays/sites-luna` (`models.review-site: openai/gpt-6-luna`,
   `variants.site-review: medium`; otherwise identical to `sites-haiku`), all
   18 held-out cases, 2 repeats (band `2026-09-28_081311-4dd91f8` +
   `…_084709-…`). Judge gold on the POSTED review:

   | arm | cases | posted | matched | micro-P | micro-R | matched on Haiku's 16 | $/PR | wall/PR |
   |---|---|---|---|---|---|---|---|---|
   | sites-haiku (control prompt) | 16 | 37 | 13/44 | 0.35 | 0.30 | 13 | 1.37 | 8.3 min |
   | sites-luna r1 (h13) | 18 | 47 | 24/54 | 0.47 | 0.44 | 18 | 0.34 | 5.5 min |
   | sites-luna r2 (h13) | 18 | 48 | 19/54 | 0.40 | 0.35 | 15 | 0.33 | 5.7 min |

   Both repeats beat the Haiku arm on recall and precision at about ¼ of the
   cost. Confounds: this changes the investigator model and the prompt
   together, and the survey is re-run fresh in each arm. The disjoint
   coverage persists end to end: Haiku matched on cal-com-8330, cal-com-14943
   and keycloak-37634, where both luna repeats scored 0. On the 6 cal.com
   cases the plain shipped reviewer (9/18, $5.70) still beats luna (7 and
   4 of 18, ~$2). Posted precision is not yet Fable- or human-graded.
5. ~~An open model on OpenCode Zen as the investigator.~~ Done.
   - **10-site replay** (h13, medium, Fable-graded): `deepseek-v4-flash`
     13 findings, 11 real, 7 distinct gold, $0.36; `glm-5.3-flash` 16 / 12 /
     4, $0.31; `qwen3.8-flash` stopped after 6 of 9 cases for speed (12 / 12 /
     5, and the only arm to state the dayjs `===` gold). Every open model
     found discourse-graphite-1#0 (`ResizeEmoji` still calls `downsize` with
     the old 5 arguments), which the judge had not matched.
   - **End to end**, `overlays/sites-dsv4flash` (`sites-luna` with
     `models.review-site: opencode/deepseek-v4-flash`), 18 cases × 2 (band
     `2026-09-28_161438-4dd91f8` + `…_171802-…`):

     | arm | posted | matched | micro-P | micro-R | on Haiku's 16 | $/PR | wall/PR |
     |---|---|---|---|---|---|---|---|
     | sites-dsv4flash r1 | 68 | 26/54 | 0.37 | 0.48 | 19 | 0.62 | 9.8 min |
     | sites-dsv4flash r2 | 68 | 28/54 | 0.41 | **0.52** | **22** | 0.61 | 9.2 min |

     This is the highest recall of any arm, and it reaches the gold luna
     never does (cal-com-8330, cal-com-14943, keycloak-37634). It pays for it
     with 3.8 posted comments per PR (luna 2.6), precision at Haiku's level,
     and cost and wall time about 1.6× luna's. deepseek's findings files fail
     the gate more often on the first try, but all closed on the retry.
   - **An earlier attempt died on OpenCode's account budget** (429
     `Account budget exceeded` on every investigator, band
     `2026-09-28_114549-4dd91f8`, unusable). The budget was raised and the run
     repeated.
   - **Open question:** whether deepseek's extra posted comments are real.
     Judge gold cannot tell; next is Fable or human grades of the POSTED
     comments of both arms.
6. H3's $0 coverage audit: 9 of the 20 attributable misses were never
   investigated, and no investigator change reaches them.
7. Worth an arm: luna and Haiku investigators on the same site, since their
   gold is disjoint (~+5% cost over Haiku alone).

## Caveats

- **One run.** Repeats of one arm have swung micro-recall 0.32 → 0.08 on
  skillspro.
- **Anchors are lexical.** Some are plainly wrong: keycloak-37634's gold 0 is
  anchored to `OAuth2GrantType.java`, while the real defect, which we found, is
  in `AccessTokenContext.java`. That is why 11 misses are unattributable.
- **Gold only.** Martian gold is incomplete. Of arm A's hand-graded must-fix
  findings on skillspro, 4 of 9 were in no gold.

## State of the branch when this was written

`feat/unit-survey`, **uncommitted**: the `sites` engine (code-facts
`site-review.ts` + `sites` CLI verbs, the `reviewEngine` config key, the five
phases in `pr-review.yaml`, `review-select.md`, the slot-generic
`review-site.md`), the blank-line anchor snap in `sites --merge`, the async
`runHostCommand`, and the eval `baseBranch` fix. Also the docs sync (spec 02,
06 and 07, the www configuration and CLI pages, the package CLAUDE.md files).
`pnpm turbo run typecheck test build` was green before the last three fixes;
their own suites pass.

Added since (also uncommitted): the h13 `review-site.md`, `micro-site-review
--sites`, and wider result/number columns on the evals dashboard's
phase-replay list.
