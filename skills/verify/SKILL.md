---
name: verify
description: Test a behaviour claim as an investigator and report whether the evidence confirms or refutes it — CONFIRMED / REFUTED / INCONCLUSIVE with bash-captured evidence. Use when asked to verify a claim, prove a fix works, or check that a PR does what it says.
version: 1.0.0
tags: [github, verify, testing, evidence]
---

# Verify

Test a specific claim about behaviour and report whether the evidence supports
or refutes it. The deliverable is a **verdict with evidence**, not an opinion.

This skill uses the **building** skill for installing dependencies and running
the repo's build/test commands in the sandbox.

> **Scope (text-evidence path).** The sandbox agent has bash, file read, and the
> github tools — no browser, no screenshots, no video. Prove claims with what
> bash can capture: test output, command stdout/stderr, `curl` against a
> dev-server you start, log excerpts, file contents, exit codes. A browser /
> screenshot path is a separate docker-gated capability (not available here);
> if a claim genuinely can only be shown in a rendered UI, say so under
> **INCONCLUSIVE** rather than guessing.

## Ground rule — investigator, not advocate

Your job is to find out whether the claim is **true**, not to make it look true.
A conclusive "this is broken" with clear evidence is exactly as valuable as a
"this works". Specifically:

- **Never fabricate, hardcode, mock, or stage evidence** to match an expected
  outcome. Do not edit the code under test to make a result appear.
- If the behaviour you observe **contradicts** the claim, that is the result —
  report it as REFUTED with the evidence inline. Don't bury it.
- **Don't retry a failing test hoping for a different answer.** Retry only after
  *changing* the environment or procedure (wrong branch, missing build step),
  and only when you have reason to believe the test setup — not the code — was
  wrong. One unexpected result that reproduces is a finding.

## Parse the target

The Context block gives you the claim and (usually) a PR or issue. The claim may
arrive as:

- A **direct claim** — "ESC cancels streaming in bash mode", "the `--fork` flag
  creates a new session".
- A **PR reference + claim** — verify the claim against that PR's head.
- A **PR reference only** — read the PR description + diff and identify the most
  important, most testable claim it makes; state which claim you chose.

When a PR/issue is given, read its description and diff for context (from the
local checkout — see the **building** skill's workspace notes; don't pull the
diff through the API).

## Decide what would convince a skeptic

Name the single behaviour to observe and the evidence that settles it:

- **Functional claim** (a feature works, a flow completes) → run it and capture
  the output / exit code / resulting state.
- **Regression / fix claim** ("no longer clears the screen", "stops erroring") →
  show the **before and after**: reproduce on the base ref, then show it gone on
  the head ref. Both states must appear in the evidence — an off-camera "it's
  fixed" doesn't count.
- **Output/encoding claim** → capture the exact bytes/text (`xxd`, `od -c`, raw
  stdout) rather than describing them.

## Run the test

Follow the **building** skill to install and build. Then exercise the claim with
the minimal sequence that demonstrates it, capturing evidence at the decisive
step. Start a dev-server in the background and `curl` it when the claim is about
a running service; run the CLI directly when it's a CLI claim; run the targeted
test when the repo already encodes the behaviour as a test.

If the environment blocks a clean test (missing dependency the sandbox can't
provide, build failure you can't resolve, infra that won't run), capture what
blocked it — that drives an **INCONCLUSIVE** result, not a guess.

## Report

Produce your report as your **final message** in this shape — the workflow posts
it for you (don't `github_add_issue_comment` yourself; that would double-post):

```
## Verify: <claim>

**Environment:** <branch / commit, package manager, how the app was run>

### Evidence
<commands run + their captured output — fenced. Include both states for a
before/after claim.>

### Conclusion
**CONFIRMED** | **REFUTED** | **INCONCLUSIVE**

<one paragraph: what the evidence shows and why it settles the claim.>
```

- **REFUTED** — state the expected behaviour (from the claim), the observed
  behaviour (from the evidence), include the evidence inline, and note any
  environmental factors (branch, commit, OS). This is a valuable finding, not a
  failed run.
- **INCONCLUSIVE** — report exactly what blocked the test and what would be
  needed to resolve it. Do not guess at the outcome.

## Do NOT

- Retry a failing test more than once without changing the environment/procedure.
- Hardcode expected output, mock responses, or edit the code under test to force
  a result.
- Assume unexpected behaviour means *you* made a mistake — it may be a real bug.
- Omit evidence that contradicts the claim.
