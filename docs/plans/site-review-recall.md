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

## Final round before release (2026-09-29)

External research (SWR-Bench arXiv 2509.01494, Cursor Bugbot, c-CRAB arXiv
2603.23448, "Wisdom and Delusion of LLM Ensembles" arXiv 2510.21513) points at
one lever with measured evidence: sample more than once and take the UNION —
repeated runs overlap little, and heterogeneous models more than one model's
repeats. Majority vote throws each model's unique finds away. Our 2/3/5-of-11
luna draws are that effect.

### H5 — pair two investigators per site ($0 screens)

**Replay union** (the 10 recall sites, 9 cases; Fable grades; gold = judge ∪
Fable; `~/lastlight-micro-fixtures/2026-09-29-union-screen/union.py`):

| union | findings | real-rate | distinct gold | $ |
|---|---|---|---|---|
| luna alone (3 draws) | 14 / 10 / 14 | 0.93–1.00 | 4 / 3 / 6 | 0.12 |
| luna × 2, same model | 24–28 | 0.96–1.00 | 4 / 6 / 6 | 0.24 |
| luna + deepseek | 23–27 | 0.89–0.93 | **8 / 7 / 9** | 0.48 |
| luna + glm | 26–30 | 0.89–0.93 | 7 / 6 / 8 | 0.43 |

**Posted-level oracle union** (Martian 18 e2e bands — an upper bound: each arm
re-ran its own survey, so the sites differ):

| union | matched / 54 | recall | posted |
|---|---|---|---|
| luna r1 / r2 | 24 / 19 | 0.44 / 0.35 | 47 / 48 |
| luna + luna | 26 | 0.48 | 95 |
| luna + deepseek (4 pairs) | 30–33 | 0.56–0.61 | ~115 |
| deepseek + deepseek | 35 | 0.65 | 136 |

So pairing clears the go bar (heterogeneous ≥ same-model + 2 gold, real-rate ≥
0.85) on the replay, but end to end **deepseek × 2 beats luna + deepseek** —
the paid replay needs a deepseek × 2 arm beside luna + deepseek.

### H3 — the $0 coverage audit

`micro-site-review --audit`, the 18 Martian v7 surveys, 25 gold-mapped rows:

| selection | sites/PR | gold rows in a site |
|---|---|---|
| top 5, tests skipped (shipped) | 4.7 | 16 |
| **top 8, tests skipped** | 6.7 | **21** |
| top 5 + tests | 4.8 | 15 |
| top 8 + tests | 7.2 | 20 |
| top 12 + tests | 10.1 | 21 |
| every site | 18.2 | 25 |

Top 8 is ~+2 investigators per PR (≈ +$0.02 on luna, not the $0.25/site the
Haiku estimate above assumed). Including test files HURTS at a fixed cap —
they displace better-ranked sites. **29 of the 54 gold map to no survey row at
all**: no selection or investigator change reaches them.

### What was built (all default-off)

- `review.analysis.siteTop` (1–8, default 5) → `sites --plan --top`.
- `models.review-site-pair` → `sites --plan --pair`: slots 9–(8+top) re-run
  ranks 1–top on that model; `merge` proposes the cross-slot duplicates and
  `select` merges them.
- `site-review` declares 16 static branches with `skip_satisfied_branches`:
  `site-plan` writes every empty slot's `empty` line, so an unused slot starts
  no session.
- H6: the investigator reads `{{prIntent}}` (PR title, body, closed issues;
  template comments stripped) framed as a claim to check. Replay arm:
  `micro-site-review --pr-context`.
- `select` reads `{{priorDiscussion}}` (reviews, inline threads with
  resolution, comments — one GraphQL read, served by the evals fake too) and
  marks an item `alreadyRaised`, which `finalize` files internal.

### The paid replay (2026-09-29) — fresh draws, every finding Fable-graded

10 recall sites, 3 draws per new arm (plus the earlier draws), bands over every
draw combination; gold = judge ∪ Fable. Script:
`~/lastlight-micro-fixtures/2026-09-29-union-screen/union2.py`; grades merged
into `eval-results/labels/proposals-fable.jsonl`.

| arm | distinct gold | real-rate | findings | $ / 10 sites |
|---|---|---|---|---|
| luna × 1 | 4.3 [3–6] | 0.98 | 12.7 | 0.12 |
| luna + PR context × 1 | 4.3 [3–6] | 0.95 | 13.0 | 0.12 |
| deepseek × 1 (default thinking) | 6.0 [6–6] | 0.84 | 15.5 | 0.53 |
| deepseek × 1, `low` | 4.3 [3–5] | 0.67 | 9.0 | 0.23 |
| luna × 2 | 5.3 [4–6] | 0.97 | 25.3 | 0.24 |
| **luna + deepseek** | **8.2 [7–10]** | **0.90** | 28.2 | **0.65** |
| luna + deepseek-low | 6.6 [4–9] | 0.84 | 21.7 | 0.35 |
| deepseek × 2 | 8.8 [8–10] | 0.84 | 31.0 | 1.05 |
| luna + deepseek × 2 | 10.4 [9–12] | 0.88 | 43.7 | 1.17 |

Conclusions:

1. **Pair luna with deepseek.** It nearly doubles luna's gold at 0.90 real-rate,
   and gets 93% of deepseek × 2's gold for 62% of the cost at higher precision.
2. **deepseek's thinking is what it is paid for.** pi-ai maps
   `deepseek-v4-flash`'s `medium` to NO reasoning-effort parameter
   (`thinkingLevelMap.medium: null`), so "medium" is the provider default,
   ~75% of output tokens as reasoning. `low` cut $ by 60% and wall by 55%, but
   dropped gold 6.0 → 4.3 and real-rate 0.84 → 0.67: its extra wrong findings
   rest on false premises (e.g. "uploads have no size validation"). Keep the
   default; never pin `low`.
3. **PR context is neutral** on gold and precision. Its visible effect is
   grafana-94942 (the "disable SQL expressions" PR), which luna now closes
   `none` 3/3 — the contested gold. Keep it; it is not a lever.
4. **Why sites with gold closed `none`.** Three sites, all draws, all models:
   cal-com-22345 (gold is a guard UNCHANGED on main — "the PR caused it"
   correctly excludes it), grafana-94942 (the stubs ARE the PR's fix), and
   cal-com-14943 (one real miss: a `none` that never asked the concurrency
   class — the H2 residue). So judge-gold recall under-reads h13 arms: Martian
   gold includes pre-existing bugs in touched code and intended behaviour.

### Next step — the end-to-end Martian arm

**Config under test** (all switches built on this branch, default-off):

- `models.review-site: openai/gpt-6-luna`, `variants.site-review: medium`
- `models.review-site-pair: opencode/deepseek-v4-flash` (the pair branches
  inherit `variants.site-review`; deepseek's `medium` = provider default,
  which is what was measured)
- `{{prIntent}}` and `{{priorDiscussion}}` on (they ride `analysis.enabled`)

**Arms** (Martian 18 × 2 repeats, `--keep-workspace`, dashboard open), each
against the existing `sites-luna` band (`2026-09-28_081311` + `…_084709`):

1. `overlays/sites-pair` — the config above, `siteTop: 5`. The one variable
   is the pair (plus the two context blocks, measured neutral / untestable on
   Martian). Expect ~$0.65/PR, wall bound by deepseek (~3 min/site).
2. `overlays/sites-pair-top8` — the same with `siteTop: 8` (the H3 audit's
   +5 gold rows in reach). Run after (1) so the pair's effect reads on its own.

**Before the paid band ($0):**

- Smoke: one case of `sites-pair` — all 16 branches account for themselves
  (5 run, 11 skip with no session), `merge` proposes the cross-slot
  duplicates, `select` closes its gate over ~20 findings, the post lands.
- Docs-sync over the branch (spec 02/06/07, www configuration, code-facts
  `sites` verbs), then commit.

**Smoke (2026-09-29, `2026-09-29_072004-4dd91f8`, keycloak-40940): passed.**
4 sites, so 8 of the 16 branches ran (4 luna, 4 deepseek pair) and 8 skipped
with no session; two branches closed on their regate; `merge` pooled 3
findings (one luna, two deepseek) into one proximity group and `select` merged
them into ONE comment; posted 1, gold 1/2, $0.34, 10.5 min. Docs synced (spec
02/06/07, www configuration, code-facts and workflows guides); the turbo gate
is green.

**Concurrency.** The fan-out ceiling on `none` was 6, so a paired top-5 PR (10
slots) ran in two waves and a paired top-8 (16) in three, each as slow as its
slowest deepseek site. It is now 16 on `none` (the widest static fan-out);
`docker`, the production backend, stays 6. Both pair overlays set
`siteConcurrency: 16`, and the band runs `--concurrency 6
--repeat-concurrency 2`, so **its wall/PR is not comparable** with the earlier
bands (they ran 3 cases at once with repeats in series).

**Test-file sites now fill free slots (built 2026-09-29, AFTER the
`sites-pair` band started — that band still skips them).** `sites --plan`
ranks test-file sites after every other site (`clusterSites`' `demotePath`)
instead of dropping their rows, so they take only the slots code sites leave
empty and cannot displace one. The smoke case shows why: 9 of keycloak-40940's
17 rows were in test files, and 4 sites left rank 5 empty. Not a config key.
It lands in `packages/code-facts/dist` only when that is rebuilt after the band
(the eval runs the built CLI), so `sites-pair-top8` is the first arm to carry
it — making that arm two variables (top 8 + test fill); the H3 audit re-run
with `--tests last` against `--tests skip` separates them at $0.

**Branch failures no longer fail the run (fixed 2026-09-29, after the band
started).** In the band, sentry-greptile-1 reported `workflowSucceeded: false`
although it posted and was graded: one deepseek pair slot hit an OpenCode Zen
"404 status code (no body)" (`error_agent`, never retried), and the scheduler
failed the workflow on any failed row. Now a provider error re-runs its branch
once, and a failed branch in a fan-out that succeeded is `tolerated` — visible,
not a workflow failure. In production the old behaviour left the head
unassessed and the review sweep re-dispatched a posted review. The band's
scorecard still carries such cases as errors; their review metrics count.

**The band, and the laptop sleep.** Band `2026-09-29_075200-4dd91f8` +
`…_075201-…`: the 13 non-cal.com instances finished clean in both repeats.
At 08:37 UTC the laptop clamshell-slept on battery for ~90 min (`pmset -g
log`), freezing every in-flight session: `select`'s Sonnet call returned 111
min later, and pair slots died with "Connection error." on wake. The five
cal.com instances in flight (10967, 11059, 22345, 22532, 8330) are re-run ×2
under `caffeinate -i` at `--concurrency 3` (`2026-09-29_103239-4dd91f8` +
`…_103240-…`, core with the retry/tolerated fix, code-facts unchanged) and
spliced in for those five. Separately: the in-process backend never passes
the agent timeout to agentic-pi, so a hung call on `none`/gondolin runs until
it returns (production is docker) — a follow-up.

**Result — judge gold on the POSTED review, 18 cases × 2** (13 instances
from the band, the 5 cal.com from the re-run):

| arm | matched (of 54) | micro-R | micro-P | posted/PR | $/PR |
|---|---|---|---|---|---|
| **sites-pair r1 / r2** | **28 / 28** | **0.52 / 0.52** | 0.37 / 0.32 | 4.2 / 4.7 | 0.69 / 0.71 |
| sites-luna r1 / r2 | 24 / 19 | 0.44 / 0.35 | 0.47 / 0.40 | 2.6 / 2.7 | 0.38 / 0.37 |
| sites-dsv4flash r1 / r2 | 26 / 28 | 0.48 / 0.52 | 0.37 / 0.41 | 3.8 / 3.8 | 0.62 / 0.61 |

- The pair's recall is the best band yet and the steadiest: 28 in both
  repeats (luna 24/19, deepseek 26/28). It keeps deepseek's cal.com wins
  (cal-com-8330 2/2 twice, 14943 1–2) and luna's where deepseek slips.
- But on judge gold it is deepseek × 1 plus comments: same recall as
  deepseek's better repeat, 0.4–0.9 more comments per PR, precision at
  deepseek's level (≈ 10 points under luna), $0.08–0.10/PR more. `select`
  merges the pair's duplicates (the smoke) but still posts more.
- Wall/PR is not comparable (12 cases at once, then the cal.com re-run at 3).
- Over ~$1/PR: cal-com-10967 ($1.31/$1.32) and keycloak-37634
  ($1.15/$1.20); every other case-run ≤ $0.91.
- Not yet read: real-rate of the posted comments (Fable pre-grade, then
  human). The ship rule turns on it — judge gold alone cannot tell whether
  the pair's extra comments are real defects gold misses (as on
  discourse-graphite-1, grafana-79265) or noise.

**Read the band on**, in order: human grades of the POSTED comments
(`#/grade`, Fable proposals pre-filled; primary), Fable real-rate, judge-gold
micro-recall/precision, comments/PR, $/PR, wall/PR. `select` must MERGE the
pair's duplicates — watch posted comments/PR, not pooled findings.

**Ship if:** posted real findings/PR rise over `sites-luna` with real-rate no
more than 10 points below it, ≤ ~$1/PR, and no `post-review` failures. Else
ship `sites-luna` (h13, `models.review-site` pinned) and pick up the verifier.

**Deferred (one variable at a time):** a `preExisting` finding flag (report
pre-existing bugs in touched code at a low tier — what Martian gold rewards);
`none` must record which defect classes it asked of each changed statement,
with concurrency required on a site that writes shared state; the stage-5
verifier as the precision gate if the pair's posted precision slips.

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
