# pr-review tier

Measures **PR-review quality** the way Martian's
[Code Review Bench](https://github.com/withmartian/code-review-benchmark) does: the
review the `pr-review` workflow posts is matched, by an LLM judge, against a
human-verified **gold set** of real issues, scoring **precision / recall / F-beta**.
The headline is **F1** (β=1, precision and recall weighted equally — Martian's
leaderboard metric); set `EVAL_F_BETA=0.5` to weight precision 2× (F0.5), mirroring
Martian's adjustable F-beta. Cases come from their **offline** set
(`offline/results/benchmark_data.json`).

`instances.json` is **gitignored** — the cases are *generated* from Martian's
benchmark, not vendored, so they don't live in this repo. Populate it **once**
locally and it persists across runs (no git noise, no re-import each time). It
holds 50 PRs across Sentry / Grafana / Cal.com / Discourse / Keycloak:

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

> Comparability caveat: our F1 won't equal the public leaderboard (different judge
> model + harness). Treat it as a **relative** optimisation signal, and inspect the
> per-case match with the dashboard's **judge** button. Martian's gold set is known
> (by their own methodology) to be **incomplete** — it caps at human performance, so
> a real issue the annotators missed scores as a false positive. That understates
> precision, which is why the default is F1 rather than the precision-weighted F0.5.

---

**Attribution.** Cases derive from Martian's
[Code Review Bench](https://github.com/withmartian/code-review-benchmark)
(© 2025 Martian, MIT). The importer pins the PRs' base/head SHAs and inlines the
gold comments locally; nothing from Martian's dataset is committed to this repo.
