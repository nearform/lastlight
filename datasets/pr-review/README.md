# pr-review tier

Measures **PR-review precision** the way Martian's
[Code Review Bench](https://codereview.withmartian.com/) does: the review the
`pr-review` workflow posts is matched, by an LLM judge, against a human-verified
**gold set** of real issues, scoring **precision / recall / F0.5** (F0.5 weights
precision 2× over recall — false positives cost more than misses).

`instances.json` ships **empty** because the cases are large, real-repo PRs — they
are *generated*, not vendored. Populate it from the Martian offline set (50 PRs
across Sentry / Grafana / Cal.com / Discourse / Keycloak):

```bash
# needs `gh` (authenticated) + network; pins base/head SHAs into instances.json
npx tsx scripts/import-martian.ts            # full 50
npx tsx scripts/import-martian.ts --limit 3  # a quick subset first
npx tsx scripts/import-martian.ts --dry-run  # preview without writing
```

Then run the tier (heavy — clones the real repos, calls a judge model):

```bash
# grade one model; the judge defaults to a strong model per your provider keys
# (override with EVAL_JUDGE_MODEL). See src/judge.ts.
npx tsx src/run.ts run pr-review --model <model>            # full tier
npx tsx src/run.ts run pr-review --model <model> --limit 3  # first 3 cases (controlled/cheap)
```

`--limit N` caps the tier to its first N instances (in file order) — the
lightest way to smoke-test the plumbing before cloning + grading all 50. Combine
with `--instance <id>` to pin exact cases.

Each case's shape (`src/schema.ts`):

- `pr` — the PR fixture served by the fake GitHub + checked out at its **head**
  (base + head refs/commits, so `git diff origin/<base>...HEAD` works offline).
- `review_gold` — the gold comments (`severity` + `description`; file/line are
  absent in the Martian set, so the judge matches on substance).
- `expect_github.review_submitted` — a cheap deterministic proxy (a review was
  posted) alongside the judge grade.

> Comparability caveat: our F0.5 won't equal the public leaderboard (different
> judge model + harness). Treat it as a **relative** optimisation signal, and
> read the per-case false-positive / missed-gold lists (hover the dashboard's
> review cell) — the Martian gold set is known to be incomplete.
