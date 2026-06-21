# Executor Summary — #119 Slack commands v3

## What was done

Replaced every fake slash-command suggestion in the chat agent's prompt
surface with natural-language triggers, and added regression tests that
lock the prompt and chat skill against reintroducing leading-slash
notation.

Prompt-only change — no routing, classifier, or connector code touched.
The natural-language triggers listed already work today (router
classifies them and dispatches to the right workflow).

## Files changed

- `src/engine/chat.ts` — rewrote `CHAT_SYSTEM_SUFFIX`:
  - Routing bullets now reply with `tell me \`…\`` natural-language
    phrases instead of `run \`/x owner/repo\``.
  - `health` bullet reworded to surface the truth: health reports run on
    cron/CLI only, not as an interactive chat trigger (warn-and-surface,
    not silently dropped).
  - Footer replaced: "Useful commands you can suggest:" (slash list) →
    "Natural-language triggers you can suggest:" listing
    `build owner/repo#N`, `triage owner/repo`, `review PRs on
    owner/repo`, `security review owner/repo`, `explore owner/repo`,
    `status`, `reset`, `approve`, `reject` — no leading slashes.
  - Added explicit rule: "Never suggest commands with a leading `/` —
    Slack intercepts them before they reach Last Light and they will
    fail."
  - WHAT YOU CAN DO / WHAT YOU CANNOT DO / security disclosure / STYLE
    sections otherwise unchanged.
- `skills/chat/SKILL.md` — frontmatter `description` and "What you don't
  do" body rewritten to natural-language triggers; added the
  never-leading-slash rule line.
- `skills/README.md` — chat skill table row: "guide to slash commands" →
  "guide to natural-language triggers".
- `src/engine/chat.test.ts` — NEW. Asserts `CHAT_SYSTEM_SUFFIX` is free
  of leading-slash command tokens, advertises the natural-language
  triggers, includes the never-leading-slash rule, and does not list
  `health` among interactive triggers. Also asserts the chat SKILL.md
  frontmatter is slash-free.
- `src/engine/chat-skills.test.ts` — NEW. Asserts the boot-built chat
  skill catalogue's `chat` entry has a slash-free description mentioning
  natural-language triggers.

## Test / lint / typecheck results

```
$ npx tsc --noEmit
(clean — exit 0, no output)

$ npx vitest run
 Test Files  50 passed (50)
      Tests  734 passed (734)
   Duration  11.66s
```

(Lint not configured in this repo — non-blocking per guardrails report.)

Baseline was 48 files / 726 tests; +2 files / +8 tests from the new
regression tests.

## Deviations from the plan

- **Forbidden-token regex tightened.** The plan's regex
  `/(build|triage|review|security|health|status)\b/` matched the
  pre-existing prose reference `agent-context/security.md` (the `/` in
  the path plus `\b` after `security`). Per the plan's own contingency
  ("tighten the regex to require the command to be preceded by a
  backtick or start-of-line rather than weakening the assertion"), the
  `CHAT_SYSTEM_SUFFIX` assertion now uses
  `/(^|`)\/(build|triage|review|security|health|status)\b/` — matching
  the shape the old prompt actually used (backtick-quoted `/word`
  tokens) while leaving legitimate prose untouched. The SKILL.md
  frontmatter assertion keeps the broad form (no `security.md`-style
  false positive possible in that file).
- No other deviations. The optional `chat-skills.test.ts` was added as
  recommended; `loadChatSkillCatalogue` was importable directly.

## Known issues

None. The plan's out-of-scope note about `skills/issue-comment/SKILL.md`
(GitHub-facing `/build` shorthand, not Slack) was respected — not
edited.
