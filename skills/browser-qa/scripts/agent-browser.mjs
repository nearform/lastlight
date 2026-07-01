#!/usr/bin/env node
// agent-browser.mjs — bundled headless-browser driver for Tier B browser QA.
//
// CONTRACT
// --------
// Runs inside the `lastlight-sandbox-qa:latest` docker image, which bakes in
// Playwright + Chromium at PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers and
// makes the global `playwright` package resolvable via NODE_PATH. The calling
// agent has bash + file tools but NO vision: it reasons over this CLI's JSON
// stdout (extracted text, assertion results, console errors). The PNG
// screenshots are human evidence only — the agent never "sees" them.
//
// Subcommands:
//   doctor
//     Runtime probe. Launches headless Chromium (--no-sandbox), opens
//     about:blank, closes. On success prints {"ok":true,"chromium":"<version>"}
//     and exits 0; on ANY failure prints {"ok":false,"error":"..."} and exits 1.
//     The skill runs this first to decide browser-vs-text.
//
//   run <flow.json> [--base-url URL] [--out-dir DIR] [--record-dir DIR]
//              [--demo] [--no-cursor] [--step-delay MS] [--type-delay MS]
//              [--move-steps N]
//     Executes a FLOW in ONE Chromium session (state preserved across steps) and
//     prints a single JSON report.
//
//     With --record-dir DIR (or `"record": true` in the flow), the whole session
//     is screen-recorded via Playwright's native recordVideo and saved to
//     <record-dir>/session.webm (default: the out-dir). The saved path is
//     reported as `video` in the JSON. Used by the `/demo` workflow, which then
//     composites the raw webm into a titled mp4 with compose-demo.sh.
//
//     DEMO MODE (auto-on whenever recording; also --demo or `"demo": true` in the
//     flow) makes the capture human-watchable — headless Chromium otherwise
//     paints no cursor and fires actions instantly:
//       - a synthetic cursor overlay (opt out with --no-cursor) that animates to
//         each target before acting, driven by real page.mouse events;
//       - `type` steps that key in char-by-char (--type-delay, default 70ms);
//       - a deliberate hold between steps (--step-delay, default 700ms).
//     Outside demo mode every one of these is a no-op, so screenshot QA runs
//     behave exactly as before. Env equivalents: LASTLIGHT_STEP_DELAY_MS,
//     LASTLIGHT_TYPE_DELAY_MS, LASTLIGHT_MOVE_STEPS.
//
//     Flow shape:
//       { "baseUrl": "http://localhost:3000",
//         "viewport": {"width":1280,"height":800},
//         "steps": [
//           {"name":"home", "goto":"/"},
//           {"click":"text=Login"},
//           {"fill":["#email","a@b.com"]},
//           {"type":["#search","hello"]},
//           {"press":"Enter"},
//           {"waitFor":"#dashboard"},
//           {"assertText":"Welcome"},
//           {"pause": 1200},
//           {"text":"h1"},
//           {"screenshot":"after-login"}
//         ] }
//     A step may combine an action plus a trailing `screenshot`. `pause` holds
//     for N ms (a readable beat after a state change, for demo recordings);
//     `type` shows visible per-character typing, `fill` sets the value instantly.
//
//     Per-step semantics:
//       - A step error (selector not found, assertion fail, timeout) is recorded
//         {ok:false} and the run CONTINUES (best-effort QA) — EXCEPT a `goto`
//         that throws is FATAL: remaining steps are marked skipped.
//       - assertText passes if the text is visible anywhere on the page; on miss
//         the step is {ok:false} but the run continues.
//       - text extracts a selector's textContent into the step result.
//       - screenshot writes <out-dir>/<basename>.png (full page).
//
//     Final stdout: one JSON object
//       { ok, baseUrl, steps:[{index,action,ok,ms,text?,screenshot?,error?}],
//         consoleErrors:[...], screenshots:[paths] }
//     Exit 0 even when steps failed (the agent reads the JSON to judge). Exit
//     non-zero only on a FATAL harness error (bad flow file, launch failure).
//
// Dependency-free apart from playwright.

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

// This file is ESM (.mjs); playwright is a CJS package. createRequire gives us
// a `require` that resolves an absolute package-dir path (see loadPlaywright).
const require = createRequire(import.meta.url);

const WAIT_TIMEOUT = 10_000; // sane default for waitFor / assertText probes
// When recording, hold the page open briefly after the last step before closing
// the context (which flushes the .webm). A bare goto→waitFor→text flow finishes
// in ~250 ms — too short for Playwright's video to capture a *painted* frame, so
// the clip can come out blank (the /demo before/after's "before" panel did).
// Settling lets late paints + async data ("Loading…") resolve and guarantees a
// watchable tail. Override with --record-settle-ms / LASTLIGHT_RECORD_SETTLE_MS.
const RECORD_SETTLE_MS = Number(process.env.LASTLIGHT_RECORD_SETTLE_MS) || 1500;

// ── Demo-mode pacing ─────────────────────────────────────────────────────────
// Headless Chromium paints NO cursor and fires actions instantly, so a raw
// recording looks like the UI mutating on its own. "Demo mode" (auto-on whenever
// the session is recorded — see run()) makes the capture human-watchable: a
// synthetic cursor overlay that animates to each target, char-by-char typing,
// and a deliberate pause between steps. These are no-ops outside demo mode, so
// screenshot QA runs are untouched. All tunable via flags / env.
const DEMO_STEP_DELAY_MS = Number(process.env.LASTLIGHT_STEP_DELAY_MS) || 700;
const DEMO_TYPE_DELAY_MS = Number(process.env.LASTLIGHT_TYPE_DELAY_MS) || 70;
const DEMO_MOVE_STEPS = Number(process.env.LASTLIGHT_MOVE_STEPS) || 25;

// Synthetic cursor overlay, adapted from Puppeteer's mouse-helper (Apache-2.0),
// made self-installing so it can be injected via context.addInitScript and picked
// up by Playwright's recordVideo (it's page DOM, so it lands in the .webm). It
// follows the REAL mouse events that page.mouse.move/down/up dispatch.
const MOUSE_HELPER_SRC = `(() => {
  const install = () => {
    if (window.__mouseHelperInstalled || !document.body) return;
    window.__mouseHelperInstalled = true;
    const box = document.createElement('div');
    box.classList.add('mouse-helper');
    const style = document.createElement('style');
    style.innerHTML = \`
      .mouse-helper {
        pointer-events: none;
        position: absolute;
        z-index: 2147483647;
        width: 20px; height: 20px;
        margin-left: -10px; margin-top: -10px;
        border-radius: 10px;
        border: 2px solid rgba(255,255,255,.9);
        background: rgba(0,0,0,.35);
        box-shadow: 0 0 0 1px rgba(0,0,0,.4);
        transition: background .15s, border-radius .15s, transform .08s;
      }
      .mouse-helper.button-1 {
        transition: none;
        background: rgba(30,120,255,.7);
        transform: scale(.75);
      }
    \`;
    document.head.appendChild(style);
    document.body.appendChild(box);
    const move = (e) => { box.style.left = e.pageX + 'px'; box.style.top = e.pageY + 'px'; };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mousedown', (e) => { move(e); box.classList.add('button-1'); }, true);
    document.addEventListener('mouseup', (e) => { move(e); box.classList.remove('button-1'); }, true);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, false);
  } else {
    install();
  }
})();`;

// Animate the synthetic cursor to the centre of a selector, best-effort. Returns
// the target box when it landed (so the caller can click at those coords), or
// null to fall back to Playwright's own targeting.
async function moveCursorTo(page, selector, demo) {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await loc.scrollIntoViewIfNeeded({ timeout: WAIT_TIMEOUT }).catch(() => {});
    const box = await loc.boundingBox();
    if (!box) return null;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy, { steps: demo.moveSteps });
    await page.waitForTimeout(140).catch(() => {});
    return { cx, cy };
  } catch {
    return null;
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function loadPlaywright() {
  // Resolve playwright via CJS `require`: it handles an absolute package-dir
  // path ($LASTLIGHT_PLAYWRIGHT, baked into the QA image) by reading the
  // package.json `main` — which ESM `import()` of a directory does NOT do — and
  // it honours NODE_PATH for the bare-specifier fallback. playwright ships a CJS
  // entry, so `require` returns { chromium, … } directly.
  const candidates = [process.env.LASTLIGHT_PLAYWRIGHT, 'playwright'].filter(Boolean);
  for (const spec of candidates) {
    try {
      return require(spec);
    } catch {
      // try the next candidate
    }
  }
  emit({
    ok: false,
    error:
      'playwright not available — browser QA needs the lastlight-sandbox-qa image',
  });
  process.exit(1);
}

async function doctor() {
  const { chromium } = await loadPlaywright();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto('about:blank');
    const version = browser.version();
    await page.close();
    emit({ ok: true, chromium: version });
    process.exit(0);
  } catch (err) {
    emit({ ok: false, error: String(err && err.message ? err.message : err) });
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Resolve a goto target against the base URL. Absolute URLs pass through.
function resolveUrl(target, baseUrl) {
  if (/^https?:\/\//i.test(target)) return target;
  if (!baseUrl) return target;
  return baseUrl.replace(/\/+$/, '') + '/' + String(target).replace(/^\/+/, '');
}

// Returns the action name for a step (for reporting) — first recognized key.
function actionOf(step) {
  for (const k of [
    'goto',
    'click',
    'fill',
    'type',
    'press',
    'waitFor',
    'assertText',
    'text',
    'pause',
  ]) {
    if (k in step) return k;
  }
  if ('screenshot' in step) return 'screenshot';
  return 'noop';
}

async function execStep(page, step, baseUrl, outDir, screenshots, demo) {
  const result = {};
  let fatal = false;

  if ('goto' in step) {
    // Navigation failure is FATAL.
    try {
      await page.goto(resolveUrl(step.goto, baseUrl), {
        waitUntil: 'load',
        timeout: WAIT_TIMEOUT * 3,
      });
    } catch (err) {
      throw Object.assign(new Error(`goto failed: ${err.message}`), {
        fatal: true,
      });
    }
  } else if ('click' in step) {
    // Demo mode: animate the cursor to the target and click at its coordinates
    // so the pointer travel + press are visible. Fall back to Playwright's own
    // targeting when the box can't be resolved (or outside demo mode).
    const at = demo.enabled ? await moveCursorTo(page, step.click, demo) : null;
    if (at) {
      await page.mouse.down();
      await page.mouse.up();
    } else {
      await page.click(step.click, { timeout: WAIT_TIMEOUT });
    }
  } else if ('fill' in step) {
    const [sel, val] = step.fill;
    if (demo.enabled) await moveCursorTo(page, sel, demo);
    await page.fill(sel, val, { timeout: WAIT_TIMEOUT });
  } else if ('type' in step) {
    const [sel, val] = step.type;
    if (demo.enabled) await moveCursorTo(page, sel, demo);
    await page.locator(sel).first().pressSequentially(val, {
      timeout: WAIT_TIMEOUT,
      delay: demo.enabled ? demo.typeDelay : 0,
    });
  } else if ('pause' in step) {
    // Explicit hold — for reading a state change before the next action.
    const ms = Number(step.pause) || 0;
    if (ms > 0) await page.waitForTimeout(ms);
  } else if ('press' in step) {
    await page.keyboard.press(step.press);
  } else if ('waitFor' in step) {
    await page.locator(step.waitFor).first().waitFor({
      state: 'visible',
      timeout: WAIT_TIMEOUT,
    });
  } else if ('assertText' in step) {
    // Pass if visible anywhere on the page; miss => step fails, run continues.
    try {
      await page
        .getByText(step.assertText, { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    } catch {
      throw new Error(`assertText not found: ${JSON.stringify(step.assertText)}`);
    }
  } else if ('text' in step) {
    const txt = await page
      .locator(step.text)
      .first()
      .textContent({ timeout: WAIT_TIMEOUT });
    result.text = txt == null ? '' : txt.trim();
  }

  // A trailing screenshot can ride along with any action (or stand alone).
  if ('screenshot' in step) {
    const base = String(step.screenshot).replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = join(outDir, `${base}.png`);
    await page.screenshot({ path, fullPage: true });
    result.screenshot = path;
    screenshots.push(path);
  }

  return { result, fatal };
}

async function run(flowPath, baseUrlArg, outDirArg, recordDirArg, opts = {}) {
  let flow;
  try {
    flow = JSON.parse(readFileSync(resolve(flowPath), 'utf8'));
  } catch (err) {
    emit({ ok: false, error: `cannot read flow file: ${err.message}` });
    process.exit(1);
  }
  if (!flow || !Array.isArray(flow.steps)) {
    emit({ ok: false, error: 'flow file must have a "steps" array' });
    process.exit(1);
  }

  const baseUrl = baseUrlArg || flow.baseUrl || '';
  const outDir = resolve(outDirArg || process.cwd());
  // Record the session when --record-dir is passed OR the flow opts in with
  // `"record": true`. The .webm lands in the record dir (default: out-dir).
  const doRecord = !!recordDirArg || flow.record === true;
  const videoDir = resolve(recordDirArg || outDir);
  // Demo mode = recording, an explicit --demo, or flow.demo. It slows the run
  // down (cursor animation, char-by-char typing, inter-step holds) so the
  // capture is watchable; it's a no-op for plain screenshot QA. Cursor overlay
  // is on by default in demo mode, opt out with --no-cursor.
  const demo = {
    enabled: opts.demo === true || flow.demo === true || doRecord,
    cursor: opts.cursor !== false,
    stepDelay: Number.isFinite(opts.stepDelay) ? opts.stepDelay : DEMO_STEP_DELAY_MS,
    typeDelay: Number.isFinite(opts.typeDelay) ? opts.typeDelay : DEMO_TYPE_DELAY_MS,
    moveSteps: Number.isFinite(opts.moveSteps) ? opts.moveSteps : DEMO_MOVE_STEPS,
  };
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    /* best effort */
  }
  if (doRecord) {
    try {
      mkdirSync(videoDir, { recursive: true });
    } catch {
      /* best effort */
    }
  }

  const viewport = flow.viewport || { width: 1280, height: 800 };
  const { chromium } = await loadPlaywright();
  let browser;
  const steps = [];
  const screenshots = [];
  const consoleErrors = [];
  let videoPath = null;

  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  } catch (err) {
    emit({
      ok: false,
      error: `browser launch failed: ${err && err.message ? err.message : err}`,
    });
    process.exit(1);
  }

  try {
    const context = await browser.newContext({
      viewport,
      // Playwright records video per-context; the size matches the viewport so
      // the clip isn't letterboxed. The .webm is flushed on context.close().
      ...(doRecord ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
    });
    // Inject the synthetic cursor before the first navigation so it's present on
    // every page (addInitScript re-runs on each document). Only in demo mode.
    if (demo.enabled && demo.cursor) {
      await context.addInitScript(MOUSE_HELPER_SRC).catch(() => {});
    }
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(String(err && err.message ? err.message : err));
    });

    let fatalHit = false;
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const action = actionOf(step);

      if (fatalHit) {
        steps.push({ index: i, action, ok: false, ms: 0, error: 'skipped (prior fatal step)' });
        continue;
      }

      const started = Date.now();
      try {
        const { result } = await execStep(page, step, baseUrl, outDir, screenshots, demo);
        steps.push({ index: i, action, ok: true, ms: Date.now() - started, ...result });
      } catch (err) {
        const entry = {
          index: i,
          action,
          ok: false,
          ms: Date.now() - started,
          error: String(err && err.message ? err.message : err),
        };
        steps.push(entry);
        if (err && err.fatal) fatalHit = true; // navigation failure: skip the rest
      }

      // Demo mode: hold between steps so the video breathes (skip after an
      // explicit `pause`, which already held, and after a fatal step).
      if (demo.enabled && demo.stepDelay > 0 && action !== 'pause' && !fatalHit) {
        await page.waitForTimeout(demo.stepDelay).catch(() => {});
      }
    }

    // Finalize a recording (if any) BEFORE emitting: saving the video requires
    // the context to close, which flushes the .webm to disk. A save failure is a
    // reported finding, not a fatal run error.
    if (doRecord) {
      // Settle before closing: let late paints + async data resolve and ensure
      // the .webm has a watchable, non-blank tail (see RECORD_SETTLE_MS).
      if (RECORD_SETTLE_MS > 0) {
        await page
          .waitForLoadState('networkidle', { timeout: RECORD_SETTLE_MS })
          .catch(() => {});
        await page.waitForTimeout(RECORD_SETTLE_MS).catch(() => {});
      }
      const video = page.video();
      await context.close();
      if (video) {
        const target = join(videoDir, 'session.webm');
        try {
          await video.saveAs(target);
          videoPath = target;
          await video.delete().catch(() => {});
        } catch (err) {
          consoleErrors.push(
            `video save failed: ${err && err.message ? err.message : err}`,
          );
        }
      }
    }

    emit({
      ok: steps.every((s) => s.ok),
      baseUrl,
      steps,
      consoleErrors,
      screenshots,
      ...(videoPath ? { video: videoPath } : {}),
    });
    process.exit(0);
  } catch (err) {
    // Unexpected harness error mid-run — still emit a JSON object.
    emit({
      ok: false,
      error: String(err && err.message ? err.message : err),
      baseUrl,
      steps,
      consoleErrors,
      screenshots,
      ...(videoPath ? { video: videoPath } : {}),
    });
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'doctor') {
    await doctor();
    return;
  }

  if (cmd === 'run') {
    const positional = [];
    let baseUrl;
    let outDir;
    let recordDir;
    const opts = {};
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--base-url') baseUrl = rest[++i];
      else if (a === '--out-dir') outDir = rest[++i];
      else if (a === '--record-dir') recordDir = rest[++i];
      else if (a === '--demo') opts.demo = true;
      else if (a === '--no-cursor') opts.cursor = false;
      else if (a === '--step-delay') opts.stepDelay = Number(rest[++i]);
      else if (a === '--type-delay') opts.typeDelay = Number(rest[++i]);
      else if (a === '--move-steps') opts.moveSteps = Number(rest[++i]);
      else positional.push(a);
    }
    if (!positional[0]) {
      emit({ ok: false, error: 'usage: agent-browser.mjs run <flow.json> [--base-url URL] [--out-dir DIR] [--record-dir DIR] [--demo] [--no-cursor] [--step-delay MS] [--type-delay MS] [--move-steps N]' });
      process.exit(1);
    }
    await run(positional[0], baseUrl, outDir, recordDir, opts);
    return;
  }

  emit({ ok: false, error: 'usage: agent-browser.mjs <doctor|run> ...' });
  process.exit(1);
}

main().catch((err) => {
  emit({ ok: false, error: String(err && err.message ? err.message : err) });
  process.exit(1);
});
