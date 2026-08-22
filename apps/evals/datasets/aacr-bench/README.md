# AACR-Bench — the external adjudication instrument

This directory holds **no data**. AACR-Bench is downloaded on first use into
`.eval-cache/aacr-bench/dataset.json` (gitignored) and pinned by sha256 in every
report. This file is the record of what the dataset is, what it is good for, and
the three things about it that will mislead you if nobody writes them down.

- **Source:** [`Alibaba-Aone/aacr-bench`](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench) on Hugging Face
- **Licence:** Apache-2.0
- **Published alongside:** [`alibaba/open-code-review`](https://github.com/alibaba/open-code-review) (Apache-2.0, Go)
- **Single file:** `dataset.json`, ~2.1 MB, a JSON array of **2,145** objects
- **Fetched from:** `https://huggingface.co/datasets/Alibaba-Aone/aacr-bench/resolve/main/dataset.json`
- **sha256 (first fetch, 2026-08-22):** `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86`

## Why it is not committed

2.1 MB of somebody else's corpus does not belong in this tree, and the eval
package's `files` list would ship it to npm. The reproducibility story is the
**sha256 stamped in `report.json`** instead, exactly as `datasets/pr-review/instances.json`
is generated rather than vendored. `.eval-cache/` is already in `apps/evals/.gitignore`.

Override the cache location with `LASTLIGHT_EVALS_CACHE`, or point at a local copy
with `--dataset <path>`.

## The consumer

`apps/evals/scripts/aacr-adjudicate.ts` — see its header doc-block, which is the
long-form version of everything below.

```bash
cd apps/evals

# The two deterministic floors. No model calls, no keys, no spend.
npx tsx scripts/aacr-adjudicate.ts --arm keep-all --all
npx tsx scripts/aacr-adjudicate.ts --arm drop-all --all

# The whole pipeline including prompt construction, with a stub decision.
npx tsx scripts/aacr-adjudicate.ts --arm llm --dry-run --limit 50 --print-prompt

# A real run. Prints its cost first and REFUSES without --yes.
npx tsx scripts/aacr-adjudicate.ts --arm llm --limit 50 --yes --out
```

## Row shape

Every key is present on every one of the 2,145 rows (verified).

| Field | Type | Notes |
|---|---|---|
| `project_main_language` | str | C++ 508, TypeScript 422, Java 272, Go 245, C 206, Python 151, JavaScript 141, Rust 92, PHP 56, C# 52 |
| `pr_url` | str | `https://github.com/OWNER/REPO/pull/N` — 200 distinct PRs across 50 repos |
| `pr_source_commit` | str | **This is `base.sha`, not the head** (verified 12/12) |
| `pr_target_commit` | str | A historical head sha |
| `pr_change_line_count` | int | |
| `pr_category` | str | e.g. `Code Refactoring / Architectural Improvement` |
| `is_ai_comment` | bool | **1,597 true / 548 false** |
| `note` | str | **The review comment text — the whole input.** p50 283 chars, p95 867, max 2,223 |
| `path` | str | File the comment is on |
| `side` | str | `right` \| `left` |
| `source_model` | str | Which model wrote it; **empty string on the 548 human rows** |
| `from_line`, `to_line` | int | |
| `category` | str | Code Defect 1022, Maintainability and Readability 905, Performance 144, Security Vulnerability 74 |
| `context` | str | Diff Level 1017, File Level 744, Repo Level 384 |
| `label` | int | **1 = expert-verified CORRECT (1,505), 0 = INCORRECT (640)** |

Cross-tabs worth having:

| | label=1 | label=0 | base rate |
|---|---|---|---|
| AI-authored | 1,114 | 483 | 69.8% |
| human-authored | 391 | 157 | 71.4% |

`source_model`: GPT-5.2 575, (human) 548, Claude-Code/Claude-4.5-Sonnet 279,
Qwen-Coder-480B 254, GLM-4.7 229, Deepseek-V3.2 136, Gemini-3-Pro 124.

## No clone. No checkout. That is the point

Adjudication takes the **comment text plus its metadata** and nothing else. No
repo is cloned, no sha is resolved, `gh` is never invoked, and the two commit
fields are recorded for provenance only. That is why this instrument could be
built before any of the review-reconstruction work in
[`docs/plans/review-evidence-pipeline/`](../../../../docs/plans/review-evidence-pipeline/) —
it has no dependency on WP1–WP5.

## The three things that will mislead you

### 1. This is not review recall

The script measures whether an arm can tell a valid comment from an invalid one
**when handed the comment**. It says nothing about whether our reviewer would
have *generated* that comment — which is the actual bottleneck (1 of 25 gold
findings on `skillspro`). An arm can score perfectly here and move review recall
by zero.

### 2. It is not the AACR-Bench leaderboard's metric

The published leaderboard scores review **generation** against the 1,505 label=1
rows as a gold set to be found — Open Code Review v1.3.1 at 20.0% recall
(301/1505), Claude Code v2.1.169 at 28.9% (435/1505). Different task, different
denominator. Per the `01b` house rule and
[WP9 AC9](../../../../docs/plans/review-evidence-pipeline/09-external-validation.md),
our number and theirs are never averaged, pooled, or put in the same column.

The 640 label=0 rows are, as far as the leaderboard is concerned, not part of the
gold set at all. They exist for exactly the classification task this script runs,
and WP9's write-up of the dataset ("1,505 annotated ground-truth issues") does not
mention them.

### 3. 74% of it is machine-authored

1,597 comments were written by GPT-5.2, Claude-4.5-Sonnet, Qwen-Coder-480B,
GLM-4.7, Deepseek-V3.2 or Gemini-3-Pro and *then* expert-verified. Only 548 are
human-authored. So the corpus over-represents the findings AI reviewers already
produce, and an adjudicator tuned on it is tuned to police machine output. The
script always reports the two halves separately and never pools them.

Contamination applies as it does to the Martian set: these are public
repositories, and the PRs are historical. Treat it as a *contaminated, large,
public* set complementary to the *clean, tiny, private* `skillspro` one — never
pooled with it either.

## What a result here means for WP6

[WP6](../../../../docs/plans/review-evidence-pipeline/06-adjudicate.md)'s
adjudicator **may re-rank, re-tier and demote, but may not delete a finding
without a probe transcript refuting it.** Every time a filter has been measured
against a conservative reviewer it has cost recall — our own candidate v2
(micro-recall 1/25 → 2/25, F1 halved, reverted), BitsAI-CR's ReviewFilter
(precision 54.5 → 67.1, recall 45.5 → **39.8**), and Open Code Review's own
deterministic layer (discards ~5,100 findings and loses 134 real defects doing
it).

So the headline metric is **retention** (kept ÷ label=1), not interception. The
deterministic arms pin what those numbers are *without* the intervention, which
is the only thing that makes the intervention's numbers a guard rather than a
decoration:

| Arm | retention | interception | precision | F1 |
|---|---|---|---|---|
| `keep-all` — **what production does today** | 100.0% (1505/1505) | 0.0% (0/640) | 70.2% (1505/2145) | 0.825 |
| `drop-all` | 0.0% (0/1505) | 100.0% (640/640) | n/a (0/0) | n/a |

`keep-all`'s precision is the corpus base rate and its F1 of **0.825** is the bar.
An arm scoring below it has traded recall for nothing — which is the exact shape
of the reverted candidate v2. A WP6 adjudicator drops in as a fourth arm by
implementing the `Arm` interface in the script and registering in `ARMS`.
