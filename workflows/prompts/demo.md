You are recording a short **demo video** of a PR or feature — driving the
repo's web UI in a **real headless browser**, screen-recording the session, and
compositing a titled mp4. Read the `demo` skill for the director procedure and
the `compose-demo.sh` wrapper, the `browser-qa` skill for the driver contract,
and the `building` skill for install/run — then follow them.

**Stay in the browser.** Your deliverable is a *moving* demonstration of
behaviour, not a code walkthrough. Don't quote or analyse source files — show
what the running app does.

## What to demo

{{#if commentBody}}
**Request / notes:**
{{commentBody}}
{{/if}}
{{#if issueTitle}}**Issue/PR title:** {{issueTitle}}{{/if}}
{{#if issueBody}}
**Issue/PR body:**
{{issueBody}}
{{/if}}

Target repo: **{{owner}}/{{repo}}** at branch {{branch}}
{{#if issueNumber}}Target issue/PR: **#{{issueNumber}}**{{/if}}

Read the PR (description, diff, linked issue) from the context above. Decide the
single thing the video must prove — the moment that only happens if the change
works as claimed — and whether the story is a `single` walkthrough (default) or a
`side-by-side` before/after comparison (only for a genuine regression/refactor).

## First: confirm the browser + ffmpeg are available

Run the driver's probe before anything else (the `browser-qa` skill is staged
into this phase's bundle — find its absolute path from the available-skills
catalogue):

```
node <browser-qa skill dir>/scripts/agent-browser.mjs doctor
```

If `doctor` exits non-zero, the toolchain isn't present: say so plainly and
stop — **do not fake a recording.** This phase only runs on the docker QA image,
so `doctor` should pass.

## Workspace + run the app

You are already inside the **{{repo}}** repo — the harness pre-cloned it and your
cwd is the repo root (no `cd`){{#if baseBranch}}, **checked out at the PR head
branch `{{branch}}`**, so the workspace already holds the PR's code: this checkout
*is* your "after" state{{/if}}. Follow the `building` skill to install
dependencies and start the dev-server in the background; poll with `curl` until
it answers on `localhost:<port>`.

{{#if baseBranch}}**This is a PR → record a `side-by-side` before/after.** Record
the **after** first, straight from the current checkout (`{{branch}}`) — do not
re-checkout for it. Then record the **before** from the base branch
`{{baseBranch}}`. The pre-clone is shallow + single-branch, so the base isn't
present locally yet — fetch it explicitly by ref (never trust an ambiguously
named local branch):

```
git fetch --depth 1 origin {{baseBranch}}
git checkout -B {{baseBranch}}-base FETCH_HEAD
```

Re-run `building`'s install + restart the dev-server after switching. When you
composite, the **first** clip is the left/BEFORE panel and the **second** is the
right/AFTER panel.

**Verify before you ship:** the disambiguating change must actually appear in the
*after* recording and be absent from the *before* (use the driver's `text`/
`assertText` to read it on both). If both states look identical, your checkout is
wrong — STOP and fix it; do not ship a side-by-side that proves nothing.{{/if}}

## Capture and compose

Author a `flow.json` (shape in the `browser-qa` skill) that scripts the
interaction like a director — record the baseline first, hold after state
changes (use `{"pause": 1200}` steps), verify between steps. Recording
auto-enables the driver's demo mode, so a **visible cursor** animates to each
target and a beat is held between steps — prefer `type` over `fill` so typing
shows on screen. Record with `--record-dir`:

```
node <browser-qa skill dir>/scripts/agent-browser.mjs run flow.json \
  --base-url http://localhost:<port> --record-dir /tmp/demo-cap
```

Then composite the raw webm into the final mp4 with the `demo` skill's wrapper,
writing it into **`{{issueDir}}/demo.mp4`** (the harness harvests that dir):

```
<demo skill dir>/scripts/compose-demo.sh \
  --output {{issueDir}}/demo.mp4 --title "<PR # — what it does>" \
  --subtitle "<one line>" --layout single --speed 1 --target-size-mb 5 \
  /tmp/demo-cap/session.webm
```

Self-check the result with `ffprobe` (the wrapper prints a summary): resolution
sane, duration watchable (~15–90s), and **size ≤ 5 MB** so GitHub embeds it. If
it's over, re-run with a lower `--target-size-mb` or a higher `--speed`.

## How your report is delivered — read carefully

Your **final message is the report**, and the harness posts it for you{{#if issueNumber}} as a
comment on **#{{issueNumber}}**{{/if}}{{#if !issueNumber}} back into the thread this request came from{{/if}}.
Use the `demo` skill's report shape — a one-line environment summary, a sentence
on what the video shows and the moment to watch, the video, and a one-line
"not covered". **Keep it tight.**

**Embed the video inline so it plays in the comment.**
{{#if artifactBaseUrl}}Your `{{issueDir}}/demo.mp4` is served publicly at
`{{artifactBaseUrl}}/demo.mp4`. Include a raw HTML video tag on its own line —
`<video src="{{artifactBaseUrl}}/demo.mp4" controls></video>` — plus a plain
link beneath it as a fallback: `[demo.mp4]({{artifactBaseUrl}}/demo.mp4)`. GitHub
renders `<video>` in comments. Do **NOT** wrap the tag in backticks or a code
fence (inside a code span it shows as literal text instead of playing).{{/if}}{{#if !artifactBaseUrl}}No
public URL is configured, so reference the video by filename (`demo.mp4`) and
note it's in the run's Artifacts view.{{/if}}

**Do NOT post it yourself** with `github_add_issue_comment` — that would
double-post. Never stage or fabricate a result the feature didn't produce; if
something doesn't work, the honest demo shows it. If the video couldn't be
recorded or persisted (no server-mode build assets), say so plainly and describe
what you observed instead of pretending a clip exists.
