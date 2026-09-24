# Open-model evals — where we are, how we got here, and how to continue

> **Status: 2026-09-24.** Micro-survey screens of four open models (via OpenCode Zen) against Haiku 4.5 are done on two fixtures, and the first three full-pipeline open arms have run — **see "The finding" below: an all-open stack roughly doubles recall at half the cost.** This file is the handoff: the process, the tooling, what was found, what is still broken, and the order to run the broader evals in. The measurements themselves are recorded, with run ids, in [`micro-survey-evals.md` → "Open-model screens"](micro-survey-evals.md#open-model-screens-and-the-quality-view-they-forced-2026-09-24).

## The finding (2026-09-24) — open weights beat the Anthropic stack on recall, at half the cost

Same build (`bc10db3`), same 8 cases (25 gold), same judge (Sonnet 4.6). Runs `2026-09-24_054639-bc10db3` (first three arms) and `2026-09-24_105043-bc10db3` (no-probes). The open arms share Kimi K3 (review), GLM 5.3 (adjudicate), GLM 5.3 Flash (triage); falsify on DeepSeek V4.1 Flash where probes run.

| arm | survey | matched | posted | P | R | F1 | $/case | min/case |
|---|---|---|---|---|---|---|---|---|
| `verdict-derived` (Anthropic) | Haiku 4.5 | 9/25 | 25 | 0.36 | 0.36 | 0.36 | $3.71 | 25.4 |
| `oc-centre` | DeepSeek V4.1 Flash | **20/25** | 63 | 0.32 | **0.80** | 0.45 | $2.33 | 45.9 |
| `oc-survey-glmf` | GLM 5.3 Flash | 18/25 | 47 | **0.38** | 0.72 | **0.50** | $1.96 | 29.7 |
| `oc-survey-glmf-noprobes` | GLM 5.3 Flash, no falsify | 16/25 | 47 | 0.34 | 0.64 | 0.44 | **$1.95** | **23.7** |

1. **The open stacks find about twice the gold at about half the cost** — 16–20/25 matched against 9/25, at $1.95–2.33 a case against $3.71. Well outside the band identical Anthropic arms have shown (8–12/25).
2. **They get there by posting more, not by being more accurate.** 47–63 posts against 25; precision flat at 0.32–0.38. On `1641` (no gold at all) every open arm posted 3–4 comments, all false positives, where the baseline posted none.
3. **GLM 5.3 Flash is the survey model.** Against DeepSeek V4.1 Flash it gives up 2 gold (18 vs 20) for 16 fewer posts and 16 fewer minutes per case — best F1, and ~1.5 min per survey branch against ~10.
4. **Dropping probes saves 6 min/case and nothing else.** Cost unchanged ($1.96 → $1.95), matched 18 → 16, with per-case swings in both directions (`1587-r2` +1, `1680-r2` +1, `1667` −2, `1680-r1` −1, `1587-r3` −1) — noise. The oracle buys nothing measurable here. (The probed GLM arm still ran two falsify rounds; `probeRounds: 1` is now set on every active overlay.)
5. **Nothing was masked.** Triage skipped no case (every case surveyed) and the gate re-run fired **zero** times in 32 case-runs.

**What it does not show.** *Which role* drives the recall — the open arms move every role at once, so the extra posts could be Kimi's review, GLM 5.3's adjudication or the survey. *That the ranking is stable* — one sample per arm, and identical arms have swung 12 vs 8; the 9 → 16–20 gap is large enough to trust, the 20/18/16 order among open arms is not. *What the extra comments cost a reader* — about two thirds of posts are false positives in every arm, but the open arms post twice as many.

**Working candidate: `oc-survey-glmf-noprobes`** — F1 0.44 vs 0.36, half the cost, the shortest wall clock. Next: repeats of it beside the baseline (bands, not points); a role-isolation arm (Sonnet review over an open survey) to find where the recall comes from; then precision — false positives on clean PRs are now the main cost.

**Why it was slow.** `oc-centre` averaged 46 min/case: DeepSeek survey branches ran ~13 min each in the full arm against 4.5–6 min in screens, because the run held up to 45 concurrent Zen sessions (3 arms × 3 cases × 5 branches) and Zen slows ~2× per turn under load. Run one open arm at a time, or at lower `--concurrency`, when wall clock matters.

## The question

Can the pr-review pipeline — built, tuned and measured entirely against Anthropic models — run on open weights, at what cost, and which open model belongs in which role? The comparator is the `verdict-derived` config arm `2026-09-23_150604-e014b96` (8 cases, 11/25 matched, micro P/R 0.38/0.44, $3.69–$4.41/case).

## The process — the loop that produced the findings

Each step exists because skipping it cost us a wrong conclusion once.

1. **Screen before spending.** A full config arm is 30–45 min and roughly $30 at `--concurrency 3`, and two identical arms have scored 12/25 and 8/25. A micro-survey replays ONE survey branch on a preserved workspace — about 2–8 min and $0.01–$0.40 a repeat — so a model can fail cheaply. 8 repeats is the floor for ranking anything.
2. **Pick fixtures where gold is findable.** Check the full arms' `internalGold` per case first. `1587-r3` looked like a good screen and is dead: no CONFIRM-era arm, and no model, ever found any of its 4 gold. The informative pairs are the ones where a survey *family* found gold in a full arm — `1680-r1` · `enforcement` (unseeded: open discovery) and `1667` · `contract` (12 seeded checks: verdicts at guided lines).
3. **Read quality, not counts.** `needsProbe%` / fire rate count probe requests; a pass that finds nothing and asks to verify every row scores 100%. Read the gold overlay (found it / looked, said fine / never looked), the F1, the seed ledger (answered / skipped / own rows / lines lost / gate) and the per-row probe reason (`verify` vs `risk`/`gap`/`unknown`).
4. **Use a current-code reference, not the fixture baseline.** The "baseline" is the rows frozen inside the fixture, written by the old pipeline. The comparator for a model screen is a reference model (Haiku) replayed on the same fixture and family now.
5. **Investigate every void or odd repeat.** Each one so far was a real defect, not noise: Haiku writing one `NOT MEASURED` row and stopping (a prompt contradiction), 0-row repeats (multi-line JSON silently dropped — in prod too), identical lines from two models (the seed, not the model, decides where rows land), inconsistent baselines (judge flips at temperature 0).
6. **Fix, then re-run every arm** — a shared prompt or skill change invalidates all prior repeats. Delete the stale runs so the list only holds comparable ones.
7. **Record** — measured numbers and run ids in `micro-survey-evals.md`; process and continuation here.

## Tooling — where everything is

| what | where |
|---|---|
| replay one survey branch | `apps/evals/scripts/micro-survey.ts` — `--fixture --family --instances --model --thinking --repeats --label`; `--judge-votes N`, `--no-judge`, `--dry-run` (free: location half + seed ledger) |
| fill new report fields into old reports, $0 | `apps/evals/scripts/micro-survey-backfill.ts` — skips reports still being written; run after a screen finishes |
| does the seeder ASK the gold's question? | `apps/evals/scripts/seed-questions.ts --fixtures --instances [--votes 3]` — one judge call per fixture |
| does the seeder even POINT at the gold? | `apps/evals/scripts/facts-obligations.ts` (location, $0) |
| report shapes + arithmetic (browser-safe) | `apps/evals/src/micro-survey.ts` — gold overlay, F1, vote, seed stats, row view |
| Node half shared by script + backfill | `apps/evals/src/micro-survey-node.ts` — `claimOf`, `rowsViewOf`, `seedStatsIn` (wraps the gate's `checkDischarge`) |
| why a row probes | `packages/code-facts/src/survey-verdict.ts` — `probeReasonOf`, `isReassurance`, beside `deriveVerdict` |
| the discharge gate | `packages/code-facts/src/discharge.ts` — `checkDischarge` |
| dashboard | `pnpm --filter @lastlight/evals-dashboard build`, then (from the workspace) `npx tsx <lastlight>/apps/evals/src/run.ts serve` → `#/micro-survey`. **Restart `serve` after any change to the index** (`summariseMicroReport`); a SPA-only change needs a rebuild and a refresh |
| the workspace | `~/work/nearform-evals` — `overlays/oc-*` (the five open arms), `eval-results/micro-survey/` (reports, `rows/`, `.judge-cache/`), `micro-results/logs/` |
| fixtures | `~/lastlight-micro-fixtures/{arm1,arm2}/<instance>/` — copied out of `$TMPDIR`, which macOS purges |

**Always run from source.** The workspace packages resolve to `dist/`, so after changing `code-facts`, `shared`, `workflow-engine` or `agentic-pi`: `pnpm turbo run build --force --filter=…` (turbo's cache replay leaves mtimes stale; `--force` is how you know).

## What the screens found

Standings, 8 repeats each, "repeats that found ≥1 gold" (all runs on post-fix code; `1680-r1` has 4 gold, `1667` has 5):

| model (via Zen) | `1680-r1` enforcement — unseeded | `1667` contract — 12 seeded | cost / repeat | median time |
|---|---|---|---|---|
| **DeepSeek V4.1 Flash** (`low`) | **6/8** · G1 G2 G3 | 6/8 · G1 G3 G4 G5 | ~$0.08 | 4.5–6 min |
| **GLM 5.3 Flash** (`low`) | 3/8 · G1 G2 G3 | **7/8** · G1 G3 G5 | **~$0.02** | **1.5–2 min** |
| DeepSeek V4 Flash (`low`) | 0/8 | 7/8 · G1 G3 G4 G5 | ~$0.03 | 4 min |
| MiniMax M3 (default) | 3/8 · G1 G2 | 7/7 judged of 8 · G1 G3 G5 — **gate fails 3/8**: no evidence (r1), 2/12 and 3/12 checks answered (r2, r4) | ~$0.22 | 5 min |
| Haiku 4.5 — current code | 1/8 · G1 | 5/8 · G3 G5 | ~$0.28 | 3–4 min |
| baseline (frozen in fixture) | G1 | G5 | — | — |

What it supports, within the house rules (8 repeats, two fixtures):

- **Open discovery**: DeepSeek V4.1 Flash is the only model that finds gold most of the time.
- **Seeded checks**: the cheap models (GLM 5.3 Flash, DeepSeek V4 Flash) match or beat Haiku at roughly a tenth of the cost.
- **Haiku on today's prompts is not the recall winner** it was measured as on the Martian corpus — worth re-checking before any pipeline assumes it.
- **MiniMax** finds gold but is the priciest open model and the least compliant with the evidence contract.
- **Zen is fast per request** (TTFT 0.4–3 s, 80–230 tok/s) but slowed ~2× per turn when 8 screens ran at once. Latency differences are turns × thinking tokens: DeepSeek/MiniMax take 3–6× GLM's tool calls, and `low` DeepSeek still emits 600–800 tokens for a one-sentence answer.

## Fixed on `feat/pi-0.87-opencode-zen` (committed, prod-facing — needs a release)

- **Prompts + shared skill**: `NOT MEASURED` / "no obligations could be built" → record it, then work the diff (not "record and stop"). `tests` keeps *stop* on purpose.
- **Discharge gate** (both contracts, incl. the shipped `minimal`): fails a zero-obligation family with no real claim, a seeded check no row names, and a claim row with no `evidence` record.
- **Eval instrument**: gold overlay + F1 + cached 3-vote baseline + `--judge-votes`; seed ledger; per-row check id + probe reason; `seed-questions.ts`; backfill; dashboard (state squares per defect, bars instead of number lists, plain-language legend).

## Still broken — the backlog, in the order I would take it

1. ~~**The reader drops multi-line JSON.**~~ **Done (2026-09-24).** One reader, `parseJsonl` (`packages/code-facts/src/jsonl.ts`): a line that parses alone is a row as before; a line that does not is retried as a brace-balanced, string-aware span, counted in `recovered`; a failure counts one malformed line and resumes at the next, so a torn row cannot swallow later ones. Every gate (`hypotheses.ts`, `probes.ts`) and every eval mirror (`micro-survey*`, `review-pipeline-stats`, `deletion-risk`) reads through it; `post-review.ts` and the evals dashboard carry tested copies (they cannot depend on code-facts). Re-reading the stored screen rows recovered **8 rows** (4 each in `oc-deepseek-v4-flash` r3 and `oc-glm-5.3-flash` r5 on `1680-r1` — the "0-row repeats"); the preserved fixtures gave 2 more, and 2 genuinely broken lines (mismatched braces, `1587-r2`/`r3` security row 1) stay malformed. Stored reports still carry the old counts until `micro-survey-backfill.ts` runs.
2. ~~**A failed gate changes nothing.**~~ **Done (2026-09-24), signed off.** New fanout key `on_branch_gate_failure: { retries: 0 | 1 }`, declared on `pr-review`'s survey: a branch whose gate ran and said no is re-run once (`<phase>_branch_<name>_regate` row + window) with the gate's command and verbatim output appended last, then gated again. Never on a timed-out/unrunnable gate, a hard-failed branch, or a resume dedup; a failed re-run leaves the first result standing. The discharge notes now list every unnamed check and name bare-evidence rows by position (`row 3 of contract.jsonl`). Dashboards (server pipeline, evals phase tree/session), `phase-models.ts` and `survey-cost.ts` know the suffix. **Not visible in micro-survey screens** — `micro-survey.ts` calls agentic-pi directly, not the fan-out handler; teaching it a `--regate` pass (gate via `seedStatsIn`, re-prompt with `gateRetrySection`) is the cheap way to measure what the re-run buys before a full arm.
3. **Define the unseeded marker.** Models write the "ran unseeded" first row as an ordinary claim (derived Minor), which reads as a finding and can slip past the gate's prefix test. Proposed: exactly `{"id":"<family>-unseeded","unseeded":true,"surveyed":[<files opened>]}`, no `claim`; the reader treats it as a marker; the gate passes a zero-obligation family on a real claim OR a marker with a non-empty `surveyed`.
4. **The seeder is blind to literals.** `1680-r1` enforcement seeded 0 because `constants` found no named constant — the TTL is a bare `120` passed to `imgCache.set`, the MIME filter an inline string — and the key file was in no tsconfig. Mint from numeric literals passed as TTL/limit/size arguments; treat a changed file outside every tsconfig as a coverage gap, not silence.
5. **Seeded questions that ask the wrong thing.** `seed-questions.ts`: of 20 gold, 11 have a seeded question that would surface the defect, 4 are seeded but asked wrong, 5 are not seeded. Re-run with `--votes 3` before acting — "asked right" on `1587-r3` G2/G4 reads generously.
6. **The probe budget.** A clean discharge over a changed hunk always probes (`verify`). On `1667` that is 10–12 probes per repeat for 0–2 real risks. Decide what the oracle is for before running arms with `probes: static`, or the falsify phase dominates spend.

## Continuing — the broader evals

**Before any full arm:** land or rebase `feat/pi-0.87-opencode-zen` (the `opencode/` provider only exists there) and rebuild from source. Backlog items 1 and 2 are done on the branch; the full arms are the first measurement of item 2 unless micro-survey gains `--regate` first.

**Re-screen after every shared prompt/skill/gate change**, same two fixtures, and add a third informative pair if one can be found (candidates: `1587-r1` · `contract`, `1680-r2`). Delete stale reports before re-running.

**Survey workhorse — settled for now: GLM 5.3 Flash** (see "The finding"). `oc-centre` (V4.1) and `oc-survey-glmf` (GLM) have both run; GLM wins on F1, speed and cost.

**Then the config arms**, from `~/work/nearform-evals`, always with the same-binary baseline in the same command:

```bash
lastlight-evals run pr-review --mode config \
  --overlay overlays/verdict-derived \
  --overlay overlays/oc-centre \
  --overlay overlays/oc-survey-glmf \
  --concurrency 3 --keep-workspace
```

Use the source harness (`npx tsx <lastlight>/apps/evals/src/run.ts …`) rather than a globally installed `lastlight-evals` — the global one lags the branch. Read triage depths first on every open arm (GLM 5.3 Flash does triage; a wrong `light` skips the pipeline), then internal recall per gold, then posted. Copy the preserved workspaces into `~/lastlight-micro-fixtures/<arm>/` before macOS purges them — that is also what makes the next micro-survey possible.

**Then the one-role moves** — `oc-adj-kimi`, `oc-adj-minimax`, `oc-floor` — now that the open stack is viable; rebase them on `oc-survey-glmf-noprobes` rather than `oc-centre`. Also unscreened: full GLM 5.3 vs GLM 5.3 Flash in the survey role (~$2–4 micro-survey screen). See `nearform-evals/overlays/README-open-models.md` for the arm table and the per-model evidence behind each pick.

## Gotchas collected on the way

- `set -- $spec` does not word-split in zsh; loops over `"a b"` pairs silently pass the whole string as `$1`.
- Killing a `bash -c "run A; run B"` chain's child starts B — kill the chain's parent, or `pkill -f micro-survey.ts` twice.
- The backfill skips reports still being written; a running screen rewrites its report every repeat and would overwrite the fill.
- Zen rejects Python's default user agent (403); curl's is accepted.
- pi-ai's Fireworks price for DeepSeek V4.1 Flash is copied from V4 Flash 0731 and understates it ~40%; Zen's table has it right.
