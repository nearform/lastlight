---
name: demo
description: Record a short demo VIDEO of a PR or feature — drive the repo's web UI in a real headless browser, capture the session, and composite a titled, size-capped mp4 with ffmpeg. Use on the docker QA image when the deliverable is a playable demo clip (single walkthrough or before/after comparison), not a text/screenshot report.
version: 1.0.0
tags: [demo, video, browser, ffmpeg, evidence]
---

# Demo

Turn a PR or feature into a short, polished **demo video**: drive the repo's
web UI in a real headless Chromium, screen-record the session, and composite a
titled, size-capped **mp4** the maintainer can watch inline.

This is the **video** sibling of `browser-qa` (screenshots) and `verify`/
`qa-test` (text evidence). It only works on the `lastlight-sandbox-qa:latest`
docker image, which bakes in Playwright + Chromium **and ffmpeg**. You have
bash + file tools but **no vision** — you reason over the driver's JSON stdout
and the ffprobe summary; you never "see" the video.

Compositing is **ffmpeg only** — there is no Remotion / cinematic-effects
pipeline. You get a title card, optional before/after side-by-side, trim/speed,
and a size cap. That's the deliverable: a clear, honest walkthrough, not a
marketing reel.

This skill uses **browser-qa** (the headless driver) and **building** (install
+ start the dev-server).

## When this applies

A phase on the docker QA image whose target is a **web app** the repo serves on
`localhost`, where a *moving* demonstration adds value over a screenshot. For a
CLI, a curl-able API, or pure pass/fail evidence, use `qa-test`/`verify`. For
static screenshot evidence, use `browser-qa`. Don't record a video you don't
need.

## FIRST — probe for a browser

The browser driver lives in the **browser-qa** skill bundle at
`<browser-qa-dir>/scripts/agent-browser.mjs`, and this skill's compositor at
`<demo-dir>/scripts/compose-demo.sh`. Resolve both `<…-dir>` paths from the
available-skills catalogue (it gives each skill's absolute staged path); do not
assume a relative path from `$PWD` — your cwd is the checked-out repo, the
bundles are siblings.

Run the runtime probe before anything else:

```bash
node <browser-qa-dir>/scripts/agent-browser.mjs doctor
```

- Exit 0 with `{"ok":true,...}` → proceed.
- Exit non-zero (lean image / gondolin / no Chromium) → **DO NOT attempt a demo.**
  Report that the demo path was unavailable on this host and stop. (The workflow
  gates this phase to the QA image, so this should be rare — but never fake a
  recording.)

## Understand what to prove

Read the PR (description, diff, linked issue) from the context the prompt gives
you. For each change, ask: *what could a viewer confuse this with?* Design the
demo so the viewer sees something that **only happens if the feature works as
claimed** — both states (before/after, input/result) must appear on screen.

State your **commitments** up front, then honour them:

- **Layout** — `single` (default: a new feature, a fix proof, a walkthrough) or
  `side-by-side` (only when the story is fundamentally a comparison: regression
  fixed, behaviour-preserving refactor). Never fabricate a "before" to justify
  side-by-side.
- **Speed** — target a watchable length; speed up dead time rather than leaving
  it. 30–60s is a good single-feature target.

## Build and run the app

Follow the **building** skill to install dependencies, then start the repo's
dev-server **in the background** and poll with `curl` until it answers on
`localhost:PORT`. Note the port — you pass it as `--base-url`.

## Capture the session

Author a `flow.json` (same shape as **browser-qa**) that scripts the
interaction as a *director*, not an operator:

- **Record the baseline first** — the starting state is act one.
- **Hold after state changes** — add a `{"pause": 1200}` (or `waitFor`) so the
  result is readable before moving on.
- **Verify between steps** — `waitFor` the expected element before the next
  action; don't blindly fire keys into an unsettled page.

Because recording auto-enables the driver's **demo mode**, you get a visible
**synthetic cursor** that animates to each target, and holds between steps —
you don't script those. To make typing visible on screen, prefer **`type`**
(character-by-character) over `fill` (instant) for any input the viewer should
watch being filled. Tune pacing with `--step-delay` / `--type-delay` if a flow
feels rushed or draggy (see the browser-qa skill).

Record the session by passing `--record-dir`:

```bash
node <browser-qa-dir>/scripts/agent-browser.mjs run flow.json \
  --base-url http://localhost:PORT \
  --record-dir /tmp/demo-cap
# → writes /tmp/demo-cap/session.webm, reports {"video":"…/session.webm", …}
```

Pick the viewport to match the layout so the clip isn't letterboxed (the
compositor renders at **1920×1080** by default): `1920x1080` for `single`;
`~960x1000` per panel for `side-by-side` (set it in the flow's `viewport`).
Recording at the output resolution keeps UI text crisp instead of upscaled.

**Before/after comparison:** record the **same** scripted interaction against
each branch — `session-after.webm` (PR head) and `session-before.webm` (base
branch). Only the behaviour should differ.

When the harness triggered this on a PR, your workspace is **already checked out
at the PR head** — record the *after* from that current checkout first (no
re-checkout). Then get the *before* from the base branch. The pre-clone is
shallow + single-branch, so fetch the base **by ref** (the prompt passes its
name) rather than trusting a local branch name, which may be a synthesized
`lastlight/N-slug` that actually points at the default branch:

```bash
git fetch --depth 1 origin <baseBranch>
git checkout -B <baseBranch>-base FETCH_HEAD   # re-install deps + restart the dev-server after switching
```

**Verify the checkout did what you think before you composite:** read the
disambiguating element on *both* recordings (the driver's `text`/`assertText`).
It MUST be present in *after* and absent in *before*. If both look identical, the
checkout is wrong (a stale/fictional branch, deps not rebuilt, or a dev-server
still serving the old branch) — STOP and fix it. Never ship a side-by-side that
shows no difference and call it a before/after; that is the failure this skill
exists to prevent.

## Compose the video

Composite the raw recording(s) into the final mp4 with the bundled wrapper:

```bash
# Single walkthrough
<demo-dir>/scripts/compose-demo.sh \
  --output <artifact-dir>/demo.mp4 \
  --title "PR #42 — Add dark mode toggle" \
  --subtitle "Toggling persists the theme across reloads" \
  --layout single --speed 1 \
  /tmp/demo-cap/session.webm

# Before/after comparison — first clip = left/BEFORE, second = right/AFTER
<demo-dir>/scripts/compose-demo.sh \
  --output <artifact-dir>/demo.mp4 \
  --title "PR #51 — Fix flicker on load" \
  --layout side-by-side --labels "BEFORE (main)" "AFTER (PR)" \
  /tmp/before/session-before.webm /tmp/after/session-after.webm
```

Flags: `--title` (required, on the card), `--subtitle`, `--layout
single|side-by-side`, `--labels A B` (side-by-side), `--speed N`, `--trim
START:END` (seconds, single layout), `--crf` (default 18 — lower = higher
quality), `--target-size-mb` (default 10), `--width/--height` (default
1920×1080), `--title-secs`. The script normalizes (lanczos scale), lays out, adds
the title card, then does a **quality-first single-pass CRF** encode
(`+faststart`, `yuv420p`); only if that overshoots `--target-size-mb` does it
fall back to a size-capped two-pass encode. It prints a JSON summary line:
`{"output":"…","resolution":"1920x1080","duration":"38.4","size_mb":3.1}`.

## Guardrails — self-check before reporting

Confirm the output with `ffprobe` (the script's summary already reports these):

- **Resolution** matches the requested size (default 1920×1080).
- **Duration** is sane — not 0s, within a watchable band (~15–90s). Don't crank
  `--speed` so high (or so low) that the clip becomes a sub-second flash or a
  near-static crawl; the agent that shipped a 0.2s recording at `--speed 0.05`
  proved nothing.
- **Size ≤ 10 MB** so GitHub embeds it inline (25 MB hard limit). The CRF encode
  usually lands far under this on its own; if it's over, the script auto-falls
  back to a size-capped encode, but you can also lower `--target-size-mb`, raise
  `--crf`, or raise `--speed`.

If the recording is too short to be meaningful (a couple of seconds), go back
and add interaction steps — don't ship a clip that proves nothing.

## Output location

Write `demo.mp4` into the **artifact directory the prompt provides** (the run's
`.lastlight/<issueKey>/` dir, referenced by the template variable the prompt
passes). The harness harvests it into the dashboard Artifacts view, and the
public artifact URL makes it playable inline on GitHub. Do **not** commit the
mp4 into the repo, and do **not** post it yourself — the workflow embeds it.

Video delivery requires **server-mode build-assets**. If the mp4 can't be
persisted (no artifact dir provided, or repo-mode), say so in the report and
describe what the demo showed instead.

## Evidence rules

Mirror `verify`/`browser-qa` — you are demonstrating real behaviour, not selling
it:

- **Never fake it.** Don't edit the code under test to force a nicer demo, and
  don't stage a result the feature didn't actually produce.
- **Show the disambiguating moment** — the thing that only happens if the change
  works. Off-camera claims don't count.
- If something doesn't work, the honest demo shows that — report it; don't trim
  the failure out and call it a success.

## Report

Produce your report as your **final message** — the workflow posts it (don't
comment yourself). Keep it short:

```
## Demo: <target>

**Environment:** <branch / commit, package manager, how served, Chromium version>

<one or two sentences: what the video demonstrates and the key moment to watch>

- **Layout:** single | side-by-side
- **Video:** demo.mp4 (<resolution>, <duration>s, <size>MB)

### Not covered
<one line: anything the demo doesn't show, and why>
```

The workflow embeds the playable video from the artifact store; reference it as
`demo.mp4`. If the browser or compositor was unavailable, say so plainly instead
of pretending a clip exists.
