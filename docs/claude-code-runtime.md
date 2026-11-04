# The Claude Code runtime

Last Light can run a phase in the real, interactive Claude Code CLI instead of
its own agentic-pi agent. The CLI signs in with your own Claude subscription.
You pick it per model role, and nothing turns it on by default: a deployment
that never names a `claude-code/` model behaves exactly as before.

## Enabling it

1. **Use the docker sandbox.** `sandbox: docker` is required. On any other
   backend a `claude-code` phase fails fast with `claude-code models need
   sandbox: docker`. The sandbox image ships a pinned Claude Code CLI and tmux
   (`CLAUDE_CODE_VERSION` build arg).
2. **Create a token.** On any machine with Claude Code installed, run
   `claude setup-token`. This is Anthropic's own sign-in flow, and it prints a
   long-lived token for your subscription.
3. **Store it** in Last Light's environment as `CLAUDE_CODE_OAUTH_TOKEN`, in
   the same secrets file as your other keys. To use another variable name, set
   `claudeCode.tokenEnv`. Treat it like any other secret: never commit it, and
   never print it.
4. **Pick roles** in your config overlay:

   ```yaml
   models:
     architect: claude-code/claude-opus-5-5
     reviewer: claude-code/claude-opus-5-5
   ```

   Every phase that resolves to a `claude-code/<model>` reference runs in
   Claude Code with that model. Other roles keep their current models.

Optional tuning, in a top-level `claudeCode:` block (the defaults are shown):

```yaml
claudeCode:
  tokenEnv: CLAUDE_CODE_OAUTH_TOKEN
  readyTimeoutSeconds: 60   # how long the CLI may take to show its input box
  stallMinutes: 15          # a transcript that does not grow this long is stalled
  pollSeconds: 2            # how often the harness checks for the end of the turn
```

A malformed value stops the boot rather than falling back to a default.

**Rotation.** Run `claude setup-token` again, replace the stored value, and
restart Last Light. Phases already running finish on the old token; the next
phase uses the new one.

## Which phases can run on it

A Claude Code session gets no GitHub tools and no GitHub credential (see
below). So `claude-code` suits phases whose only GitHub step is publishing
their handoff notes: `architect`, `reviewer` and `re-reviewer` in the build
workflow, and phases like `review-select` that use no GitHub tool at all.
A phase whose rendered prompt still calls a GitHub tool fails fast with
`claude-code is not supported for the <phase> phase yet: it needs GitHub
tools`. That covers `executor`, `pr`, `fix`, `guardrails`, and the phases that
comment on issues. It is better to fail at the start than to fail halfway.

**Handoff notes, both `buildAssets` modes:**

- `buildAssets.location: repo` (the default): the prompt tells Claude not to
  commit `.lastlight/`. After the phase, Last Light publishes the phase's
  notes to the run's branch itself, as one signed commit through GitHub's
  API. It publishes only the run's own notes dir (`.lastlight/<issue>/`). It
  reads only regular, singly-linked files (at most 50, each at most 1 MiB),
  follows no link, and runs no `git` in the tree the session wrote. If any
  file there is one it will not read (a link, a FIFO, too large), the phase
  fails with `error_publish` and nothing is published. Before the run's next agentic-pi phase starts, that phase's own
  sandbox moves its checkout onto the new commit (a fast-forward on the
  checked-out branch, files untouched), so its later `github_publish` is not
  refused.
- `buildAssets.location: server`: nothing changes. The notes are harvested
  from the workspace, as for any phase.

## How a phase runs, and why it never waits on a person

Each phase starts `claude` in a detached tmux terminal inside the sandbox, as
the sandbox's non-root user, with permissions bypassed (the sandbox is the
boundary), and `AskUserQuestion` disabled. Before it starts, Last Light writes
Claude Code's own settings to answer every first-run screen: onboarding,
workspace trust, the bypass-mode warning. Only those settings load: a repo's
own `.claude/settings.json` is ignored. The phase's agent context (what other
phases get as `AGENTS.md`) becomes Claude's user memory. The prompt is pasted
as literal text, with control characters removed.
A `Stop` hook marks the end of the turn.

The session's transcript is translated into the same events agentic-pi emits,
so the dashboard shows tool calls, messages and token use as for any phase. A
copy of the transcript is kept in the harness state dir (`0600`), for a resume.

Every way a session can stop making progress has an exit:

| What happened | Stop reason |
|---|---|
| The input box never appeared within `readyTimeoutSeconds` | `error_sandbox` |
| The transcript stopped growing for `stallMinutes` | `error_stalled` |
| The phase timeout passed | `error_timeout` |
| The terminal ended before the turn did | `error_sandbox` |
| Sign-in failed or the token expired | `error_auth` (the message says to run `claude setup-token`) |
| The subscription's usage limit was reached | `usage_limit` (see below) |

When the session ends, Last Light also kills anything it left running.

## Usage limits: wait, then continue

When a session hits the subscription's usage limit, the run is not failed. It
goes back to the queue with a `not_before` time: the reset time Claude Code
reported, but never sooner than five minutes away nor later than seven days
(the longest usage window), or one hour away when the reset time is unknown. Admission leaves the run queued until then, and other
queued runs are not held up behind it. The run's queue-wait limit
(`maxQueueWaitMs`) counts from the reset time, not from when the run was
requeued. Phases that had already finished keep their results.

When the phase runs again, Last Light resumes the stopped Claude session from
its kept transcript (`claude --resume`) with the message `continue`. This
happens once: any other retry of the phase starts a fresh session.

## Why the token lives in the sandbox

Last Light already keeps model API keys out of sandboxes, behind its model
gateway. The gateway could hold this token too. **We chose not to.**
Anthropic's terms forbid third-party software to collect, store or intermediate
claude.ai subscription tokens. A gateway that injects the token into Claude
Code's requests is exactly that kind of intermediary, and the account at risk
is the operator's own, everyday one.

So the token stays with the Claude Code process, as `CLAUDE_CODE_OAUTH_TOKEN`
in the env of the sandbox that runs a Claude phase, and nowhere else. The
risk is contained instead:

- **No other credentials in that sandbox.** The phase's env drops every GitHub
  token, provider key, gateway setting and Last Light variable. The host still
  pre-clones the repo, and it publishes the phase's notes after the phase (see
  above). A command phase never receives the Claude token.
- **One new egress host.** The Anthropic API is the only destination added for
  these phases.
- **An output scan.** Before anything is used, Last Light checks the session's
  final answer and every workspace file for the token, its 24-character prefix
  and its base64 form. Files are read in chunks. A scan stopped by its file or
  byte cap fails closed. Last Light checks the exact bytes of the notes again
  just before publishing them. A hit fails the phase with `error_secret_leak`,
  redacts the files from inside the sandbox, and publishes nothing. The token
  is also scrubbed from the dashboard log and the kept transcript.

The scan is a backstop, not a guarantee: a model could encode the token in a
way no scan recognises. The controls that matter are the first two: the phase
has nothing else to steal, and no way out except the Anthropic API.

## Terms: why the interactive CLI

Anthropic's terms explicitly allow an end user to sign in to the unmodified
Claude Code binary with their own subscription, including where a platform
hosts Claude Code. Last Light runs exactly that: the stock CLI, interactively,
signed in with the operator's own token.

It deliberately does **not** use `claude -p` or the Agent SDK. Anthropic's
documentation treats `-p` as the Agent SDK, and says products built on it
should authenticate with API keys. For the same reason this runtime is not a
subscription login inside agentic-pi: that would make Last Light's own agent
a third-party harness for the token.
