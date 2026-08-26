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
npx tsx scripts/import-martian.ts --tier pr-review-heldout  # import into a sibling tier dir
```

`--tier <name>` (default `pr-review`) picks the tier directory the import writes
(`datasets/<name>/`) and the `name` stamped into a freshly-created `tier.json`,
so a held-out split can live beside this tier under its own name. The tier's
`defaultWorkflow` stays `pr-review` either way — every imported case runs the
pr-review workflow.

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

## `anchors.json` — the deterministic anchor labels

`anchors.json` **is** committed (unlike `instances.json`) and is the frozen input to the
code-facts *evidence-coverage* metric. Martian's gold set carries only
`{severity, description}` — no file, no line — so there is no deterministic join from a gold
finding to a place in the diff. `scripts/facts-anchors.ts` builds one: it pulls code-shaped
tokens out of the gold prose (tokenizer `v1`, documented rule-by-rule in the script) and marks a
finding **anchored** when one of them matches, on a word boundary, an added-or-removed line of the
three-dot (`base...head`, merge-base) diff. No model is involved — an LLM in the denominator would
make every coverage number downstream unfalsifiable.

```bash
npx tsx scripts/facts-anchors.ts              # regenerate + print the report
npx tsx scripts/facts-anchors.ts --dry-run --audit       # the hand-audit sheet
npx tsx scripts/facts-anchors.ts --dry-run --unanchored  # what could not be anchored
```

Three things about it are load-bearing:

- **Freeze the labels, not the tokenizer.** The metric's denominator IS the tokenizer's output, so
  the artifact is committed and stamps `tokenizer: "v1"`. A better tokenizer ships as `v2` in a new
  file; it never rewrites what past numbers meant.
- **It carries its own error bar.** The `audit` block records a seeded random sample of 20 anchored
  findings, each read by hand, with per-finding verdicts. Quote the anchor rate with that rate
  attached, and don't tune the tokenizer to improve it.
- **No gold text.** Only derived labels (anchors, `path:line`, severity, Martian's `bug_type` /
  `requires_context` / `language`). Join back to your local `instances.json` on
  `instanceId` + `goldIndex` to read a description.

The headline: **99/137 anchored (72.3%)**. That is a property of the *gold text*, not of
code-facts — it is the ceiling on what any identifier-level evidence layer could ever be scored
against. The 38 unanchored are mostly prose with nothing code-shaped in it (20 of them name no
identifier at all), plus a stylesheet/i18n cluster where the finding is a value, not a name.

---

**Attribution.** Cases derive from Martian's
[Code Review Bench](https://github.com/withmartian/code-review-benchmark)
(© 2025 Martian, MIT). The importer pins the PRs' base/head SHAs and inlines the
gold comments locally; nothing from Martian's dataset is committed to this repo.
