# Forking built-in assets with `lastlight fork`

`lastlight fork` copies a built-in asset into the overlay (`instance/`) so your
edited copy shadows the default by logical name. It's host-local — it operates on
the working directory's files, not over HTTP.

**No core checkout required.** The built-in assets it forks *from* ship inside
the `lastlight` package itself, so a globally-installed CLI can fork from its own
bundled `workflows/` / `skills/` / `agent-context/` with no git checkout anywhere.
A colocated checkout (or a server home that is one) is still preferred when
present — so local, unpublished asset edits get forked — but it's no longer a
prerequisite.

Destination (where the fork is written) resolution:
- an explicit `--home <dir>` → `<dir>/instance`;
- standing inside an overlay (`instance/` itself) → writes there;
- standing in a core checkout → `<checkout>/instance`;
- standing in a workspace that *contains* an overlay (e.g. an **evals
  workspace**: `instance/` + `evals/`) → that `instance/`;
- otherwise → `LASTLIGHT_HOME` / the saved server home / `~/lastlight`.

So in a Last Light Evals workspace you can run `lastlight fork <name>` from the
workspace root (it targets `./instance`) or from inside `./instance` directly —
either way it reads the defaults bundled with the CLI.

## Commands

```bash
lastlight fork                       # list forkable workflows + agent-context + classifier; marks what's already forked
lastlight fork all                   # fork EVERY workflow (+ prompts & skills) + all agent-context + the classifier
lastlight fork <workflow>            # e.g. `lastlight fork build`
lastlight fork agent-context         # all of soul.md / rules.md / security.md
lastlight fork agent-context <file>  # a single persona file, e.g. soul.md
lastlight fork classifier            # the base intent-classifier prompts
```

`lastlight fork all` is the "fully fork the defaults" shortcut — handy for an
evals workspace where you want every workflow editable in one go. Shared prompts
and skills are copied once.

Flags: `--force` overwrites an existing overlay copy (otherwise existing files
are skipped); `--home <dir>` targets a specific working directory.

## What each fork copies

- **`lastlight fork <workflow>`** copies the workflow YAML
  (`workflows/<name>.yaml`) **plus every prompt and skill its phases reference**
  (`workflows/prompts/*.md`, `skills/<name>/`). So the forked workflow is
  self-contained and editable in the overlay. Existing destinations are skipped
  unless `--force`.
- **`lastlight fork agent-context [file]`** copies the agent "personality" files
  (`agent-context/*.md` — typically `soul.md`, `rules.md`, `security.md`) into
  `instance/agent-context/`. With no file argument it forks all of them; pass a
  filename for just one.
- **`lastlight fork classifier`** copies the base intent-classifier prompts
  (`workflows/prompts/classifier.md` — the framing + disambiguation + control
  categories the router's classification is composed from — and
  `workflows/prompts/classify-adds-info.md`). Each **workflow's own** category
  text lives in that workflow's `classification:` block, so it already travels
  with `lastlight fork <workflow>` — fork the classifier only to retune the
  shared base or add/adjust the control categories.

`agent-context` and `classifier` are forked only via their literal targets — a
bare name is always treated as a workflow.

### The intent classifier is workflow-driven

The classifier that routes free-text comments/messages to a workflow composes
its prompt from the forkable base **plus one `classification:` block per
workflow YAML** (`intent` + `description` + `examples`). Two ways to customise
routing in an overlay:

- **Retune existing routing** — `fork classifier` and edit the base, or fork a
  workflow and edit its `classification:` block.
- **Add a new routable intent** — add a new workflow YAML in the overlay with
  its own `classification.intent` (e.g. `intent: incident`). The classifier
  learns the category, the parser learns the token, and the router routes it to
  that workflow — **no core change**. The intent must be unique and must not be
  a reserved control intent (`approve`/`reject`/`status`/`reset`/`chat`).

## Editing workflow

1. Fork the asset.
2. Edit the copy under `instance/…`.
3. If the overlay is its own git repo, commit + push there.
4. Apply: `lastlight server restart agent` (config/asset overlay change — no
   image rebuild).
5. Confirm with `lastlight server status` (lists forked/overridden assets) and
   the dashboard `/config` view.

## Common targets

- Workflows: `build`, `pr-fix`, `pr-review`, `issue-triage`, `issue-comment`,
  `repo-health`, and the `cron-*` workflows. Run `lastlight fork` to see the live
  list.
- Persona: `soul.md` (voice/identity), `rules.md` (hard rules), `security.md`
  (security posture).
