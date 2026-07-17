# Author a pr-review eval case from a real GitHub PR

`lastlight-evals add-case --pr <url> --review` turns a real GitHub **PR** into a
`pr-review` case: the PR's **human review is the gold set** the model's review is
scored against (precision / recall / F-beta, via an LLM judge). It does the
mechanical, reproducible extraction with `gh`; **you** curate the gold. The output
is **byte-compatible** with `scripts/import-martian.ts`, so cases you author sit
alongside the Martian Code Review Bench cases in the same `pr-review/instances.json`.

This is the path for *"I want to create a PR-review eval dataset from these gold
PRs"* — PRs whose human reviews are the standard you want a model (or an evolving
prompt/skill) to reproduce.

## What it extracts

- **The `pr` fixture** — `base_ref`/`head_ref` + `base_commit`/`head_commit` (from
  the PR's `baseRefOid`/`headRefOid`), `title`, `body` (truncated), `user`. At run
  time the harness clones the repo and checks out the PR **head**; the review
  workflow diffs `base..head`. No repo clone happens at author time.
- **A candidate `review_gold`** from the PR's *human* review: inline review
  comments (`path` + `line` + body) and substantive top-level review bodies. The
  CLI filters the obvious noise — reply threads, `LGTM`/approve-only comments, and
  bot comments (unless `--include-bots`) — and defaults every entry's `severity`
  to `medium` (GitHub comments carry none). Outdated comments (whose hunk moved)
  are kept via `original_line` and flagged.

> **Anti-spoil.** The human review is written **only** into `review_gold` (the
> held-out judge gold). The CLI never puts it in `pr.reviews` / `pr.review_comments`
> — those seed the mocked GitHub the agent can read, which would hand it the
> answer. This mirrors `import-martian.ts`, and the run-time seeding
> (`seedWorkspacePrReview`) only checks out git, never the prior discussion.

## Prerequisites

- `gh` on PATH and authenticated (`gh auth login`) — used to read PR metadata + review comments.
- Node 24+ (same as the rest of the harness). A **judge model** at run time
  (`EVAL_JUDGE_MODEL`, else a strong default per provider key).

## Command

```bash
lastlight-evals add-case --pr <github-pr-url> --review [options]
```

Options:

| flag | meaning |
|---|---|
| `--pr <url>` | a GitHub PR url (pair with `--review` here, or `--code-fix` for a build case) |
| `--review` | with `--pr` → a **pr-review** case (gold = the PR's human review) |
| `--severity <level>` | default severity for candidate gold comments (`low`\|`medium`\|`high`\|`critical`; default `medium`) |
| `--include-bots` | keep review comments from bots (default: skipped) |
| `--tier <name>` | target tier dir (default `pr-review`) |
| `--id <slug>` | `instance_id` (default `prreview__<repo>-<n>`) |
| `--datasets <dir>` | datasets root to write into (a `<tier>/` subdir). Default `./datasets`, else `./evals/datasets` |
| `--overlay <dir>` | write into `<dir>/evals/datasets` instead |
| `--dry-run` | print the proposed instance JSON + evidence block; don't write |

## The recommended flow (CLI extracts → you refine)

1. **Dry-run first.** `add-case --pr <url> --review --dry-run` prints the proposed
   instance and an **evidence block** listing every candidate gold comment
   (`author · file:line [severity] first-line`, tagged `(outdated)` / `(bot)`).
2. **Read the evidence and curate `review_gold`** — this is the whole point of a
   *gold* dataset:
   - **Severity.** Every candidate defaults to `medium`. Set each to its real
     impact (`critical`/`high`/`medium`/`low`) — the judge is severity-aware.
   - **Prune noise.** Drop comments that aren't concrete findings — questions,
     style nits, "why not X?", praise, anything `(outdated)` that no longer applies
     to the head diff.
   - **Add what the humans missed** (optional). If you know of a real issue the
     human reviewer didn't post, add a `review_gold` entry by hand (`severity` +
     `description`; `file`/`line` optional — the judge matches on substance).
   - **Empty gold?** If the PR had no usable review comments, the CLI warns and
     leaves `review_gold: []` — author it by hand from the PR diff, or the case
     can't be judged.
3. **Write it.** Re-run without `--dry-run` (add `--datasets <dir>` / `--overlay
   <dir>` to target a workspace). The instance is appended to
   `<root>/pr-review/instances.json` (creating `tier.json` if the tier is new);
   re-running with the same PR **replaces by `instance_id`**, so curation is
   idempotent.
4. **Verify end-to-end** with the cheapest model — confirms the seed + judge
   plumbing (needs a judge-model key):

   ```bash
   EVAL_INSTANCE=<instance_id> lastlight-evals run pr-review --model haiku
   ```

   Inspect the judge trace in the dashboard (the **judge** button) to see the
   finding↔gold pairing behind the precision/recall/F score.

## Authoring from a list of gold PRs

Run `add-case --pr <url> --review` **once per URL** — each appends into the same
`pr-review/instances.json`. Because `review_gold` curation is per-PR judgement,
do one curation pass per PR rather than a bulk import: dry-run → refine → write.
Spawning a **curation sub-agent per PR** (each handed one URL, returning the
curated instance) keeps the judgement isolated and parallelizes cleanly, while the
CLI's replace-by-id write makes accumulation safe.

## Tuning knobs

- **`--severity <level>`** sets the default for *all* candidates in one PR — handy
  when a PR's review is uniformly high- or low-stakes; you still refine per entry.
- **`--include-bots`** keeps bot review comments (CodeRabbit, Greptile, etc.).
  Off by default because bot comments are noisy and rarely the human gold; include
  them only if the bot's review *is* the standard you're grading against.

See `instance-schema.md` for the full `pr` / `review_gold` field reference and the
pr-review grading model.
