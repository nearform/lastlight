# Last Light — Claude Code plugin

A bundle of [Claude Code](https://docs.claude.com/en/docs/claude-code) skills
that help you install, configure and operate **Last Light** (a GitHub
repository-maintenance agent) and **Last Light Evals** (its eval harness).

These are *Claude Code* skills — they run on your machine and drive the
`lastlight` / `lastlight-evals` CLIs for you. They are distinct from Last
Light's *internal* sandbox skills under the repo's top-level `skills/` dir
(which are staged into the agent's own workflows).

## Skills

| Skill | Use it when you want to… |
|-------|--------------------------|
| `lastlight-guide` | **Not sure which of the below you need** — orientation & router across all the Last Light skills. Start here (or `/lastlight-guide`). |
| `lastlight-server` | Install & configure a Last Light **server** (the agent + docker stack) on a host. |
| `lastlight-client` | Point the `lastlight` **CLI client** at an existing server and log in. |
| `lastlight-overlay` | Create a deployment **overlay** instance and fork/customize workflows, prompts, skills, or the agent persona. |
| `lastlight-evals` | Scaffold and run a **Last Light Evals** workspace (datasets, models, model comparisons). |
| `lastlight-evals-loop` | **Drive an eval toward a target score** with a disciplined, anti-gaming improvement loop — diagnose on a train split, validate on a blind held-out split, propose one generic fix at a time. |

## Install

**Fastest — via the lastlight CLI** (installs the version-matched skills bundled
with the CLI, no marketplace registration needed):

```bash
npm i -g lastlight
lastlight skills install            # → ~/.claude/skills (user scope)
lastlight skills install --scope project   # → ./.claude/skills (this repo only)
```

**Via the Claude Code plugin marketplace** (from a checkout of this repo):

```bash
claude plugin marketplace add ./        # or: nearform/lastlight if public
claude plugin install lastlight@lastlight-skills
```

**Manual** — copy any `skills/<name>/` directory here into `~/.claude/skills/`
(personal, all projects) or a project's `.claude/skills/`. Claude Code
auto-discovers them on the next session.

After installing, start a new Claude Code session and say e.g. *"set up a Last
Light server"* or *"scaffold a Last Light evals workspace"* — or, if you're not
sure where to start, *"help me with Last Light"* (or `/lastlight-guide`) and the
guide skill will route you.
