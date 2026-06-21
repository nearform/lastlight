# Architect Plan — #119 Slack commands

Branch: `lastlight/119-slack-commands`

## Problem Statement

The chat agent advertises Slack "slash commands" that do not exist as real
Slack slash commands. `CHAT_SYSTEM_SUFFIX` in `src/engine/chat.ts:44-77` tells
the agent to suggest things like `` run `/health owner/repo` `` and lists
"Useful commands you can suggest: `` `/build owner/repo#N` ``, `` `/triage owner/repo` `` …".
The Slack connector (`src/connectors/slack/connector.ts:141-191`) registers
only `app.message` and `app_mention` handlers — there is **no `app.command(...)`
handler anywhere in the codebase**, and no Slack slash commands are configured.
Slack intercepts any message starting with `/` *before* it reaches Last Light
and replies "`/health` is not a valid command" — exactly the symptom in the
issue. The router's design is explicit that Slack messages are classified by
the LLM classifier, "no regex commands" (`src/engine/router.ts:316`), so the
`` `/…` `` notation in the chat prompt is misleading shorthand, not a real
command surface.

## Summary of what needs to change

Reword every user-/agent-facing string that advertises a leading-slash
"command" so it instead names the **natural-language phrasing** the classifier
actually understands. This is the architecturally consistent fix: the router
already classifies `triage`/`review`/`security`/`build`/`explore`/`question`/
`status`/`reset`/`approve`/`reject` intents from free text
(`src/engine/router.ts:330-460`), so the chat agent should tell users to *say*
the request, not *type a slash command*.

Two special cases the rewording must handle explicitly (no silent default):

1. **`/health`** — there is no `health` classifier intent
   (`src/engine/classifier.ts:22`); repo-health reports run via cron
   (`src/cron/fanout.ts`) or the CLI (`src/cli.ts:142`), not interactively from
   Slack. The reworded prompt must NOT advertise an interactive health command.
   It should **warn-and-surface**: tell the user health reports are scheduled
   (cron) / available via the CLI, and that an interactive Slack "health"
   request is not supported — do not silently drop it.
2. **`/status`** — `status` IS a recognized classifier intent, so "status" said
   in natural language works. The prompt and the dispatcher's double-run reply
   (`src/engine/dispatcher.ts:125`) must say "ask for status" / "say `status`",
   not "use `/status`".

No real `app.command(...)` slash commands are added in this change. Rationale:
registering a Slack slash command requires creating it in the Slack App
dashboard (api.slack.com/apps) — outside this repo — and the architecture is
deliberately classifier-first ("no regex commands"). Adding half-wired
`app.command` handlers that only work after manual dashboard config would
re-introduce the same "advertised but doesn't work" trap. The maintainer's
"lets fix this" was in response to the bot's offer to "reword the chat prompt
(and optionally wire up real slash commands)" — rewording is the core fix;
real slash commands are explicitly optional and out of scope here.

## Files to modify

### 1. `src/engine/chat.ts` — `CHAT_SYSTEM_SUFFIX` (lines 18-78)

The primary offender. Rewrite the suffix so:

- The "DO NOT ATTEMPT DEEP WORK IN-PROCESS" block (lines 40-58) tells the agent
  to reply with **natural-language** suggestions, never leading-slash notation.
  Replace each `` → reply: "run `/X owner/repo`" `` line with a phrasing like
  `` → reply: "tell me 'triage owner/repo'" `` (no leading slash). Concrete
  replacements:
  - line 48 (security): `` → reply: "tell me 'security review owner/repo'" ``
  - line 50 (triage): `` → reply: "tell me 'triage owner/repo'" ``
  - line 52 (review): `` → reply: "tell me 'review PRs on owner/repo'" ``
  - line 54 (health): replace with a **warn-and-surface** line — health reports
    are scheduled via cron / run via the CLI; there is no interactive Slack
    health command. Suggested wording: `` → reply: "Health reports are
    scheduled (cron) or run via the CLI; I can't trigger one from chat. Ask
    cliftonc to run `npm run cli -- health owner/repo` or schedule it." ``
  - line 56 (build): `` → reply: "tell me 'build owner/repo#N' (open the
    GitHub issue first if needed)" ``
- The "Useful commands you can suggest:" footer (lines 75-77) must be removed
  entirely, OR replaced with a slash-free list. Remove it — the per-intent
  lines above already give the agent the exact phrasings. Keeping a second list
  invites drift. If kept, it must contain zero leading slashes.

Add one explicit instruction line so the agent never regenerates leading-slash
notation on its own: "Never suggest messages that start with `/` — Slack
intercepts those before they reach me. Always phrase triggers as natural
language (e.g. `triage owner/repo`, not `/triage owner/repo`)."

### 2. `skills/chat/SKILL.md` — frontmatter description + body (lines 3, 20-26)

This skill is loaded into chat via `CHAT_SKILL_NAMES`
(`src/engine/chat-skills.ts:46`) and its `description` is shown in the
`<available_skills>` catalogue, so its wording reaches the agent directly.

- Line 3 (`description:`): remove "guide users to slash commands like
  /build, /triage, /review, /status". Replace with: "guide users to the
  natural-language triggers that start a workflow (e.g. 'triage owner/repo',
  'review PRs on owner/repo', 'build owner/repo#N', 'status')."
- Lines 20-26 ("What you don't do" → the bullet list): replace the leading-slash
  bullets with natural-language phrasings:
  - `code changes → 'build owner/repo#N'`
  - `issue triage → 'triage owner/repo'`
  - `PR review → 'review PRs on owner/repo'`
  - `running-task status → 'status'`
- Add a one-line rule matching the chat.ts instruction: "Never tell a user to
  type a `/`-prefixed command — Slack intercepts those before they reach the
  bot. Use the natural-language phrasings above."

### 3. `skills/issue-comment/SKILL.md` — frontmatter description (line 3)

The description says "redirect anything that needs code changes to /build."
Replace `/build` with `@last-light build` (this skill runs on GitHub issue/PR
comments where the real trigger IS an `@last-light` mention, so the
`@last-light build` phrasing is accurate and slash-free). Body line 40 already
correctly says "reply asking the maintainer to use `@last-light build`" — leave
it; only the frontmatter `description` is stale.

### 4. `src/engine/dispatcher.ts` — double-run reply (line 125)

```
await envelope.reply(`That task is already running. Use /status to check progress.`);
```
Replace with: `` `That task is already running. Say "status" to check progress.` ``
(`status` is a real classifier intent; "say status" works from Slack. No
leading slash.)

### 5. `src/workflows/CLAUDE.md` — approval-gate docs (lines 255-256)

Documentation claims a "Slack slash" path: `` `/approve [workflowRunId]`,
`/reject [id] [reason]` ``. There is no `app.command` handler, so this is
false. Replace the "Slack slash" bullet with the real Slack path: "Slack
message: `approve` / `reject <reason>` (classified by the router and dispatched
to the `approval-response` handler)." This keeps the doc accurate without
adding code. (This is a doc-only change; the router already handles
approve/reject intents from Slack messages — `src/engine/router.ts:355-373`.)

### 6. `skills/README.md` — chat skill table row (line 17)

The table describes the chat skill as "guide to slash commands." Replace with
"guide users to the natural-language workflow triggers." Keep the rest of the
row.

## Commands (copy from guardrails-report.md)

```bash
# Typecheck (server) — must exit 0
npx tsc --noEmit

# Dashboard typecheck
cd dashboard && npx tsc -b

# Full test suite (48 files, 723 tests)
npx vitest run
```

No linter is configured (non-blocking). No build step beyond tsc.

## Implementation approach (step-by-step)

1. **Edit `src/engine/chat.ts`** — rewrite `CHAT_SYSTEM_SUFFIX`:
   - Replace the 5 `` → reply: "run `/…`" `` lines (48, 50, 52, 54, 56) with
     natural-language phrasings. The `/health` line becomes a warn-and-surface
     message (no interactive health command exists).
   - Delete the "Useful commands you can suggest:" footer (lines 75-77).
   - Add the "never suggest `/`-prefixed messages" instruction line near the
     STYLE block.
2. **Edit `skills/chat/SKILL.md`** — update frontmatter `description:` and the
   "What you don't do" bullet list to natural-language phrasings; add the
   no-leading-slash rule.
3. **Edit `skills/issue-comment/SKILL.md`** — fix the frontmatter
   `description:` (`/build` → `@last-light build`).
4. **Edit `src/engine/dispatcher.ts:125`** — `Use /status` → `Say "status"`.
5. **Edit `src/workflows/CLAUDE.md:255-256`** — replace the false "Slack slash"
   approval bullet with the real Slack-message path.
6. **Edit `skills/README.md:17`** — "guide to slash commands" → "guide users
   to the natural-language workflow triggers".
7. **Add a test** — `src/engine/chat.test.ts` (new file) asserting the
   invariant: `CHAT_SYSTEM_SUFFIX` must NOT contain any `` `/`` ``-prefixed
   command token. Use a regex that scans for `` `\/\w+ `` (backtick + slash +
   word char) and assert zero matches. This locks the fix against regression —
   the original bug was exactly someone adding `` `/health` `` back to the
   prompt. One focused test file; no LLM calls needed.
8. Run `npx tsc --noEmit` and `npx vitest run`; both must be green.

## Risks and edge cases

- **`/health` has no interactive path** — the plan does NOT add a `health`
  classifier intent (that's a feature, out of scope for this bug fix). The
  reworded prompt **warns-and-surfaces**: it tells the user health reports are
  cron/CLI only and an interactive Slack health request is unsupported. It does
  not silently drop the request or advertise a non-existent command. This is
  the explicit warn-and-surface behaviour for the unsupported input.
- **`/approve` / `/reject`** — the workflows/CLAUDE.md doc claimed a Slack-slash
  path. The real Slack path is a natural-language `approve` / `reject` message,
  which the router already handles (`src/engine/router.ts:355-373`). The doc is
  corrected to match reality. No code change to approval handling.
- **`/status`** — `status` is a real classifier intent, so "say status" works.
  The dispatcher reply is reworded; no behaviour change.
- **Agent may still emit `/…` on its own** — mitigated by the explicit
  "never suggest `/`-prefixed messages" instruction added to both
  `CHAT_SYSTEM_SUFFIX` and `skills/chat/SKILL.md`, plus the regression test
  scanning the prompt for slash tokens.
- **Other platforms (Discord)** — Discord does not intercept `/` the way Slack
  does (Discord slash commands are a separate opt-in surface), but the
  natural-language phrasings work everywhere and the classifier is
  platform-agnostic, so the rewording is strictly an improvement for Discord
  too. No platform-specific branching needed.
- **No real `app.command` handlers added** — by design (see Summary). If the
  maintainer later wants true Slack slash commands, that is a separate task
  requiring Slack App dashboard configuration + connector changes; this fix
  does not preclude it.

## Test strategy

- **New unit test** `src/engine/chat.test.ts`: assert `CHAT_SYSTEM_SUFFIX`
  contains no `` `/\w `` tokens (backtick-slash-word), and optionally that it
  contains the key natural-language phrasings (`'triage owner/repo'`,
  `'review PRs on owner/repo'`, `'build owner/repo#N'`). Pure string assertion,
  no LLM/network.
- **Existing suite** `npx vitest run` (48 files, 723 tests) must stay green —
  no existing test asserts on the old slash-command strings (verified: grep for
  `CHAT_SYSTEM_SUFFIX`/`Useful commands`/`run \`/` in `*.test.ts` returns
  nothing).
- **Typecheck** `npx tsc --noEmit` must exit 0 (the chat.ts edit is a string
  literal change; no type impact, but run it to confirm).

## Estimated complexity

**Simple** — string/doc edits in 6 files + 1 small regression test. No logic,
routing, or classifier changes. No new dependencies. The only behavioural
surface is the chat agent's suggested phrasings, which move from broken
slash-notation to working natural-language phrasings already handled by the
existing router.
