---
name: dependency-impact
description: Judge a MAJOR dependency bump by its blast radius — low / medium / high — from evidence you can gather without a checkout (release notes, dev-vs-runtime, import-site count, security sensitivity, the settled CI result). Use when a dependency PR is a major version bump and you must decide whether it can land automatically. Unknown counts as high.
version: 1.0.0
tags: [dependencies, merge, risk]
---

# Dependency impact

A major version bump is not one thing. `@types/node` 20→21 and a runtime
framework rewrite are both "major", and semver magnitude alone cannot tell them
apart. So judge the **blast radius**, not the version number: what could this
change actually break *in this repository*?

**No checkout.** The merge workflow has no working tree by design — it is the
cheap path, and keeping it cheap is what lets it run on every green dependency
PR. Every tool below is a `github_*` read tool already available to you. Never
clone, and never pull a lockfile diff: judge from the PR title, the file list
and the manifest change first, and reach for more evidence only when the tier is
still in doubt.

## The evidence

Gather in this order and stop as soon as the tier is decided — each row costs
more than the one above it.

| # | Evidence | How |
|---|---|---|
| 1 | Dev vs runtime dependency | The manifest change: `dependencies` vs `devDependencies`. `@types/*`, linters, formatters and test runners are dev-only; so is a GitHub Actions tag/SHA bump |
| 2 | Release notes / changelog / breaking-change headings | `github_get_pull_request` → the **body**. Dependabot embeds Release notes, Changelog and Commits sections, plus a compatibility-score badge |
| 3 | Blast radius | `github_search_code` for `from "<pkg>"` / `require("<pkg>")` — count the direct import sites |
| 4 | Security sensitivity | Does the package sit in auth, crypto, serialization, network, file I/O, or database-driver territory? |
| 5 | Behavioural evidence | The settled check state supplied in your prompt — deterministic, computed in code, **not** inferred from `mergeable_state` |

Evidence 5 is the pivot that makes any of this safe: **the suite already ran
against the bump.** Passing CI is real behavioural evidence, not a prediction.
Rows 2–4 exist to catch what the tests miss — a breaking change on a runtime
path the suite does not cover.

## The rubric

Pick exactly one tier.

- **low** — a dev-only dependency, **or** a GitHub Actions tag bump, **or** zero
  direct import sites; no documented breaking changes; CI settled `passing`.
- **medium** — a runtime dependency, CI settled `passing`, breaking changes
  documented but none matching this repo's actual usage (few import sites, none
  touching the named APIs), and not security-sensitive.
- **high** — a security-sensitive domain, **or** many import sites, **or**
  breaking changes plausibly touching APIs this repo uses, **or** CI not settled
  `passing`, **or** release notes missing or unparseable.

**Unknown ⇒ high.** Being unable to gather the evidence is itself a high-impact
signal, never a reason to guess low. If the PR body carries no release notes, if
`github_search_code` is denied or times out, if you cannot tell dev from runtime
from the file list — the tier is **high**. The cost of a wrong `high` is one
maintainer clicking merge; the cost of a wrong `low` is a silent breaking change
landing on the default branch unreviewed.

Two corollaries worth stating because the pull is the other way:

- **"CI is green" alone is not `low`.** A green suite that never exercises the
  bumped package proves nothing about it. Zero import sites is what makes green
  conclusive.
- **A missing-checks repo cannot produce `low` or `medium`.** With no settled
  passing checks there is no behavioural evidence at all, so a major bump there
  is `high` by the rubric's last clause.

## Report the evidence, not just the tier

Whatever consumes this rubric needs the *why* on the record — a tier with no
evidence behind it is unauditable, and the audit comment left on an
auto-merged major is the only durable explanation of why it was safe to land.
So state, in one or two lines:

- the tier, and the **one** clause of the rubric that decided it;
- the evidence you actually gathered — dev/runtime, import-site count, whether
  release notes documented breaking changes, and the settled check result;
- anything you could **not** determine, named explicitly (it is why the tier is
  `high` if it is).

Non-major bumps are outside this rubric entirely — they have no impact tier, and
the calling prompt's existing trivial/functional test governs them unchanged.
