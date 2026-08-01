# `fix` — the diagnosis half of the fix loop

Six cases against `dependabot-ci-fix`, one per member of core's `DIAGNOSIS_CLASSES` plus the
promoted-flaky attempt. Each seeds a red dependency PR: a fixture repo at `repos/<id>/`, and a
`pr_state` block carrying the CI evidence the agent is handed.

## What this measures, and what it deliberately does not

The escalation *policy* — attempts, cost, which classes are retryable — is a set of pure functions
over the `PrState` snapshot (`resolveFixDisposition` and friends), already table-tested in core with
no model involved. Re-testing it here would cost model spend to measure arithmetic.

What only an eval can measure is the half that needs a model: **given real CI evidence, does the
agent reach the right class?** That verdict is the input every downstream decision is taken on — a
`flaky` verdict on a genuinely reproducible failure burns three attempts and escalates a PR that one
push would have fixed, and it touches no GitHub state at all, so nothing but the marker catches it.
Hence `expect_markers.diagnosis_class` is the primary grade here, not `expect_github`.

`fix__flaky-promoted` is the one case that exercises the attempt dimension: it runs at attempt 3
with two prior `flaky` verdicts, so `flakyPromoted` is true and the prompt tells the agent its flaky
verdict will no longer be accepted. It must reach a real class instead — the case fails if it
answers `flaky` again, which was the defect the promotion exists to break (09-state-machine.md §S1).

## Base and head are different commits

`repos/<id>/` is the tree at the **base** commit; `repos-head/<id>/` is the PR's own commit, applied
on the branch. Both are needed, and the run that proved it is instructive: with the two identical, a
diagnosing agent asked "is this broken on `main` too?" — the first question worth asking — checked,
correctly answered *yes*, and returned `upstream-broken` for a case whose whole point was
`reproducible`. Every red-dependency case would have read the same way. A fixture with no bump
commit is not a dependency PR.

## The expectations are the shipped rubric's, not an intuition

Two of the first draft's cases expected answers `skills/fixing/SKILL.md` calls wrong, and the first
run caught both. The clearest was an `actions/checkout` 503 expecting `infra-dependent`: the skill's
own table assigns "a timeout or **network blip**" to `flaky`, and reserves `infra-dependent` for a
check that "needs secrets, a live service, a deployed backend, a browser". The model answered
`flaky` and was right. The case is now an `e2e` job with no `STAGING_BASE_URL`, which is that clause
exactly. When a case and the skill disagree, the skill wins — otherwise the eval measures the
fixture author.

## What the harness cannot exercise here

The `fix` phase's `skip_if` rows read `scratch.fixMarkers.diagnosis.class`, and that scratch is
written by the marker harvest through `workflow_runs.scratch` — a **database** the eval harness
deliberately does not pass (see the harness guide's "Gates need a DB"). So in an eval the fix phase
runs even after a `flaky` verdict, where production would skip it. The diagnosis itself is
unaffected, which is what these cases grade; but do not read a `CI_FIX_COMPLETE` marker on a
non-retryable case as evidence that production would have attempted a fix.

## The evidence is consistent by construction

`pr_state.ci_jobs` feeds two things from one source: the prompt's `{{ciSection}}`, and the fake
GitHub's Actions endpoints (`github_list_workflow_runs` / `github_get_job_logs`). An agent that digs
into the logs therefore reads the same failure it was told about. A case whose tools 404 would be
measuring an agent working around the harness.
