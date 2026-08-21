# WP7 — review memory

**Goal.** Make the reviewer accumulate repo-specific knowledge: what it has
already said, whether that landed, and what mechanisms this codebase actually
regresses on. Feed all three back into the obligation seeder.

**Depends on:** [WP6](06-adjudicate.md) (the evidence packet is the record it
persists).

> **Split in three, 2026-08-21 ([10-design-review.md](10-design-review.md)
> §D10).** As written, this WP's data source did not exist until two steps after
> it was built: [WP8](08-evals.md) §2c calls author response *"a **production**
> metric, read off `review_outcomes` once WP7 lands"*, AC6 below concedes its own
> gate is unmeasurable on historical cases, and locked decision 8 keeps the
> pipeline off until after WP9 and a human enable. `repo_mechanisms` mining would
> have landed with no history to mine — **you cannot mine history you never
> recorded.**
>
> | | Scope | When |
> |---|---|---|
> | **7a** | `record` + `review_findings`, **not gated on `review.analysis.enabled`** | with [WP6](06-adjudicate.md) |
> | **7b** | the `review_outcomes` sweep, also ungated | with 7a |
> | **7c** | mining cron, `repo_mechanisms`, retrieval into `seed` | after **[R]** — release + overlay enable |
>
> `post-review` posts findings **today**, so `record` can capture them today —
> months of finding→outcome history accumulate before the new pipeline ever
> turns on. The evidence-packet fields are optional, so today's simpler findings
> record fine and get richer when WP6 lands. 7b also gives
> `feedback_anchors`/`feedback_signals` (#255) their first consumer; they are
> analytical-only today.
>
> Cost: the schema change lands earlier than planned — both dialects, both
> generators, parity test, PGlite leg, per `apps/server/src/state/CLAUDE.md`.

## Why this is worth building, and why it is ours alone

The external sweep found **no published study** of per-PR mechanically-generated
checklists raising recall, and none of mining a repo's own review history into
named defect mechanisms ([00-evidence §8](00-evidence.md)). This is original
ground.

It is also the one part of this plan a competitor cannot copy from a public
benchmark, because **the data is the customer's own private history** — every
review we have posted, every human review comment on the repo, every fix commit,
every revert. Qodo and CodeRabbit both describe repository memory as a
differentiator; we already generate the raw material and currently throw it away.

## Two corrections to issue #177

This is issue **#177** ("Persistent cross-run memory") scoped down to review.
That RFC is good and mostly stands, but it predates two changes:

1. **It specifies a separate `better-sqlite3` database.** The state layer has
   since migrated to **Drizzle with a dual dialect** (libsql + Postgres). Use the
   existing state layer. Read `apps/server/src/state/CLAUDE.md` before touching
   the schema — a change means editing **both** `schema/sqlite.ts` and
   `schema/pg.ts`, regenerating **both** dialects, and never `drizzle-kit push`.
2. **It specifies `sqlite-vec` semantic recall from day one.** That is now a
   genuine dual-dialect problem: `sqlite-vec` on one side, `pgvector` on the
   other, with different index DDL and different query syntax. **v1 retrieval is
   structural/lexical** — keyed on repo + changed path + changed symbol — which
   is also what the memo argues for over embeddings for *code* relationships.
   Keep the `MemoryStore` port shape so embeddings can land later behind it.

Everything else in #177 — the scope/`scope_key` columns, decay, the admin UI,
the maintainer-gated capture path — is compatible and can be layered on. WP7 does
**not** implement `@bot remember`, the classifier intent, or the Claude Code
bridge.

## Schema

Three tables. Both dialects, name-parity, regenerate both.

### `review_findings`

One row per finding we **posted** (inline or demoted), written by the `record`
phase.

| Column | Note |
|---|---|
| `id`, `run_id`, `owner`, `repo`, `pr_number`, `head_sha` | keys |
| `path`, `line`, `symbol` | the anchor; `symbol` comes from the evidence packet and is what makes structural recall work |
| `severity`, `family`, `mechanism` | the taxonomy |
| `title`, `body_hash` | `body_hash` for dedup without storing prose twice |
| `confidence`, `demoted` | what the adjudicator decided |
| `created_at` | |

### `review_outcomes`

Did the finding land? One row per finding, updated by a sweep.

| Signal | Source |
|---|---|
| `path_changed_after` | did a later commit on the PR touch the anchored path/lines? The cheapest real signal we have |
| `thread_resolved` | GitHub review-comment thread state |
| `pr_merged` | terminal state |
| `reaction_score` | **already collected** — `feedback_anchors` / `feedback_signals` (issue #255) exist and are analytical-only today. This is the first consumer |
| `human_reraised` | a human posted a comment on the same path/line after ours |

`feedback` is the highest-quality signal and the rarest; `path_changed_after` is
noisy and abundant. Store both and let the ranker decide later — **do not** fuse
them into one score at write time.

### `repo_mechanisms`

Mined, not written by a run. A named mechanism plus the structural precondition
that makes it relevant.

```jsonc
{ "repo": "nearform/skillspro",
  "mechanism": "cache key omits the tenant id",
  "precondition": { "pathGlobs": ["src/cache/**"], "symbols": ["buildKey"] },
  "occurrences": 3,
  "sources": ["commit:abc123", "pr:1680#discussion_r…"] }
```

## The `record` phase

A new app-registered `PhaseTypeHandler` — the same escape hatch `post-review`
uses (`makePostReviewHandler` is registered in `src/workflows/runner.ts`; mirror
it). It runs **after** `post-review`, reads what was actually posted plus the
evidence packet, and writes `review_findings`.

It must be **non-fatal**. A memory write failing must never fail a review that
already posted. Log and continue — the same discipline as the repo-config layer's
failure rule.

## The mining cron

`workflows/cron-review-memory.yaml` + `src/cron/review-memory-mine.ts`, as a
**`handler:` cron, not a `workflow:` cron.** The reason is the one already
recorded for the digest in `apps/server/CLAUDE.md`: the facts live in our own
state DB and in GitHub, both unreachable from a sandbox, and there is no agent
tool for this. `handler:` also buys the dashboard toggle, schedule override,
per-repo participation and "Run now" that `registerDirect` would not.

It mines, per managed repo:

- **fix commits** (`git log` conventional-commit `fix:`, plus revert pairs) →
  cluster by touched paths/symbols into candidate mechanisms;
- **human PR review comments** (`gh api …/pulls/comments`, thread roots only,
  bots and LGTM/nit noise filtered — `apps/evals/src/add-case.ts`'s
  `candidateGold()` already implements exactly this filtering; reuse its rules
  rather than writing a second copy);
- **our own `review_outcomes`** — the mechanisms that we raised and that stuck.

Wrap it in `withLedger` so it writes a `cron_runs` row like every other handler
cron.

**Bound it.** One repo's history is large: cap commits scanned, cap comments
paginated, and store a watermark so each tick is incremental. Nothing here should
be able to blow a rate limit or a memory budget.

## Retrieval, and where it enters

`seed` ([WP3](03-seed-and-survey.md)) queries by **repo + changed paths + changed
symbols** — a structural join, no embeddings — and emits obligations of a new
shape:

> *"Three previous changes to this service also required updating
> `FooCache.invalidate()`. This diff touches `buildKey` and does not touch
> `invalidate`. Quote the invalidation that covers the new key, or state that
> none does."*

Note it still names **both ends** — the memory supplies the second end that the
diff does not contain. This is the same rule as everywhere else, and memory is
unusually good at supplying it.

Also surface **prior findings on the same anchor**: if we raised this exact thing
before and the human dismissed it, the survey should be told, so a re-review does
not re-litigate a settled point. That is a recall-neutral precision win — the
only one in this plan that does not cost recall, because it removes a *repeat*,
not a *finding*.

## Security

Memory bodies originate from user-authored comments and commit messages, so:

- inject them wrapped in `<<<USER_CONTENT_UNTRUSTED>>>` per
  `agent-context/security.md` — a memory must never be able to override the
  persona or the hard rules;
- scope every read to the run's `owner/repo` **server-side**, never trusting a
  client-supplied scope. A compromised sandbox must not be able to read another
  repo's memory. #177 specifies this correctly; keep it.

## Acceptance criteria

1. `record` failing does not fail a run that already posted. Test it.
2. Schema parity holds and the PGlite leg of the state suite passes. Both
   dialects regenerated, no hand-edited migration.
3. The mining cron is incremental — a second tick on an unchanged repo does
   near-zero work.
4. `seed` emits a memory-sourced obligation on a fixture where a prior finding
   exists, and that obligation names both ends.
5. A prior **dismissed** finding on the same anchor suppresses a verbatim repeat
   and nothing else.
6. **Measurement gate:** on `skillspro`, at least one repo-specific obligation
   fires. This is the hardest gate in the plan to measure on the 8-case eval —
   the cases are historical, so memory has to be seeded from history *before*
   the reviewed SHA. Say so honestly in the journal if the eval cannot show it,
   and measure it in production instead.

## Non-goals

- **No embeddings, no `sqlite-vec`, no `pgvector`.** Behind the port, later.
- **No `@bot remember`**, no classifier `remember` intent, no admin CRUD UI, no
  Claude Code bridge. All #177, all out of scope here.
- **No decay/fading yet.** Add `last_used_at` / `use_count` columns so it is
  additive, but do not build the sweep.
- **No cross-repo memory.** `scope` exists in the column set; only `repo` is
  populated.
