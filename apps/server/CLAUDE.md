# Last Light — Development Guide

> **This package is `lastlight-core`, at `apps/server/` in the monorepo.** For
> workspace-level orientation (packages, dependency graph, root commands) see the
> [root `CLAUDE.md`](../../CLAUDE.md); for the `lastlight` CLI see
> [`packages/cli/CLAUDE.md`](../../packages/cli/CLAUDE.md).

> **Architectural reference:** `spec/README.md` is the rebuild-grade
> specification — twelve pages covering every layer with schemas,
> invariants, and rebuild notes. Use this CLAUDE.md for day-to-day
> orientation; use `spec/` when you need the contract.

A GitHub repository maintenance agent. It listens for events (GitHub webhooks
and Slack messages), classifies them, and runs an AI agent against a target
repo via **agentic-pi** (the coding-agent harness in `packages/agentic-pi`;
in-process chat drives `pi-ai` directly). Everything non-trivial — triage, PR
review, the full Architect→Executor→Reviewer build cycle, health reports — is
expressed as a **YAML workflow** the harness executes phase-by-phase.

## Runtime

agentic-pi (and pi-ai underneath) is provider-agnostic. The harness defaults to
`anthropic/claude-sonnet-4-6` (`config/default.yaml`) and accepts any
`provider/model` string pi-ai supports (`anthropic/…`, `openai/…`,
`openrouter/<vendor>/<model>`, etc.).
API credentials are read from the provider env vars in the registry at
`packages/shared/src/providers.ts` — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `HF_TOKEN`,
`MOONSHOT_API_KEY`, `NVIDIA_API_KEY`, `FIREWORKS_API_KEY`,
`TOGETHER_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_API_KEY`,
`KIMI_API_KEY`, `MINIMAX_API_KEY`. Set whichever provider(s)
match your `LASTLIGHT_MODEL` / `LASTLIGHT_MODELS` (the legacy `OPENCODE_MODEL` /
`OPENCODE_MODELS` names are still accepted as aliases). No `claude` CLI, no
Anthropic SDK in the runtime path.

**Subscription logins (OAuth).** Besides the API-key providers above, three
providers authenticate by subscription login instead of a static key —
`openai-codex` (ChatGPT Plus/Pro), `anthropic` (Claude Pro/Max), and
`github-copilot`. They're registered in `OAUTH_PROVIDERS` in
`packages/shared/src/providers.ts` (separate from the API-key `PROVIDERS`). `src/engine/oauth.ts` is the shared
layer: one on-disk store (`$STATE_DIR/auth.json`, override `LASTLIGHT_AUTH_FILE`
— same JSON shape pi-ai's own CLI writes), `resolveOAuthApiKey()`
(refresh-if-expired + persist), and the model-prefix→provider-id map.
`lastlight oauth login|list|status|test|logout` (host-local,
`packages/cli/src/oauth-cli.ts`) drives the browser flow. **Two seams, different reach:**
the in-process **chat** path (`chat-runner.ts`) passes the token as a per-call
`apiKey`, so all three work; on the **sandbox** path it depends on the backend.
The **in-process backends** (`gondolin` — the default — and `none`) run the
model call host-side, so the orchestrator hands agentic-pi `authFile` and pi's
AuthStorage resolves **every** OAuth provider from it, Codex included. The
**container backends** (`docker` / `smol`) run it in-guest, where that host path
is unreadable, so `agent-executor.ts` injects `ANTHROPIC_OAUTH_TOKEN` /
`COPILOT_GITHUB_TOKEN` instead — and Codex has no in-guest env route, so it
cannot authenticate *there* (the executor warns and points at a host-side
backend). Codex is **not** chat-only on a default install; it is unusable only
on the container backends.

The cheap-helper path (`src/engine/llm.ts`, used by screener + classifier)
bypasses agentic-pi and dispatches directly to the same three providers.
`defaultFastModel(taskType)` resolves the model in order: the config `models:`
map for the task key (`models.classifier` / `models.screener` in `config.yaml`,
which env `LASTLIGHT_MODELS` is layered into) → the env `LASTLIGHT_MODELS` map
directly → the first configured provider's fast model (Anthropic > OpenAI >
OpenRouter — direct routes avoid OpenRouter's per-token markup). Only an
explicit per-task entry counts, never `models.default`, so the helpers stay
cheap unless deliberately pinned.

Two execution surfaces:
- **Sandbox** — `agentic-pi run --format json` invoked per workflow phase
  inside a Docker container (`src/sandbox/docker.ts`). Stream parsed to
  capture session id, tokens, cost, stop reason. Used by every YAML
  workflow.
- **Chat (in-process pi-ai)** — the chat path drives a `pi-ai` conversation
  directly in the harness process (`src/engine/chat/chat-runner.ts`), one
  session per messaging thread, resumed across turns. (This replaced the
  earlier long-lived `opencode serve` HTTP supervisor.)

Both surfaces write a Claude-SDK-style envelope jsonl to
`$STATE_DIR/agent-sessions/projects/<slug>/<sessionId>.jsonl` (the
"shim") so the dashboard's `SessionReader` keeps working unchanged. The
shim is `src/engine/event-shim.ts`.

## Repo layout

```
src/
  index.ts              Main entry — wires connectors, starts the cron
                        scheduler and admin dashboard.
  evals-api.ts          Public barrel for `lastlight/evals` — workflow driving
                        + overlay bootstrap symbols for external eval harnesses.
  managed-repos.ts      getManagedRepos / isManagedRepo /
                        unmanagedReposInContext helpers. The allowlist is
                        enforced at ingress (webhook connector, router) AND at
                        the dispatchWorkflow choke point, so direct CLI/API
                        triggers (/api/run, /api/build) can't act on an
                        unmanaged repo either.
  session-log.ts        SessionLog + projectSlugForCwd.
  (The `lastlight` CLI moved out to packages/cli/ — see packages/cli/CLAUDE.md.
   Its shared overlay/config helpers — overlay-assets.ts, overlay-bootstrap.ts,
   config-types.ts, providers.ts — live in packages/shared/src/.)
  config/               Config loading (the overlay-asset + bootstrap helpers
                        moved to packages/shared/src/).
    config.ts           Layered config load: config/default.yaml +
                        optional $LASTLIGHT_OVERLAY_DIR/config.yaml + env
                        overrides. Secrets stay env-only. Exposes
                        getRuntimeConfig / getRoutes / getPublicConfig /
                        getBotName / resolveGithubAuth /
                        resolveKubernetesConfig, plus the single redaction
                        rule (SENSITIVE_KEY_RE + redactPublic) every
                        YAML-echoing surface imports.
    config-resolve.ts   Pure config layer resolution (default / overlay / env),
                        plus resolveWithExtraLayer — the seam the per-repo
                        layer merges through. Re-exports mergeLayer from
                        lastlight-shared rather than carrying a second copy.
    repo-config.ts      The IMPURE half of the per-repo `.lastlight/` layer
                        (issue #180): fetchRepoLayer / refreshRepoLayer /
                        invalidateRepoLayer / getCachedRepoLayer, the
                        <stateDir>/repo-config/<owner>/<repo>/ TTL+ETag cache
                        (60s, sidecar meta.json + atomically-renamed files/),
                        repoConfigPolicy(), repoConfigBaseFromRuntime().
                        Re-exports the PURE half wholesale from
                        packages/shared/src/repo-config-schema.ts (schema,
                        bounds, validators, merger) — which lives there
                        because the CLI validates `.lastlight/` offline and
                        may never gain an edge to core.
  connectors/           Platform abstraction — every event source emits an
                        EventEnvelope so the engine never sees raw payloads.
    github-webhook.ts   GitHub App webhook → EventEnvelope.
    slack/              Slack connector (HTTP Events API webhook, default;
                        Socket Mode dev fallback) + mrkdwn formatter.
    messaging/          Base class for all messaging platforms
                        (slack now, discord later). Owns SessionManager — the
                        per-thread conversation store — and
                        thread-transcript.ts, which records the turns
                        SessionManager's other writer does NOT: a Slack thread
                        is one conversation however each message was handled,
                        but only chat-runner.ts wrote to messaging_messages, so
                        a message the classifier routed to a WORKFLOW
                        (answer/build/explore) left no trace and the next chat
                        turn in that thread rehydrated nothing. The two writers
                        are mutually exclusive per turn (the dispatcher skips
                        the wrap for `chat`), so the double-write that moved
                        persistence into chat-runner isn't reintroduced. See
                        spec/11-chat.md → "The thread transcript".
  engine/
    router.ts           Deterministic, code-based routing of EventEnvelope
                        → { skill, context }. Classifies build intent via a
                        small LLM call. No LLM decides the tab.
    agent-executor.ts   Public executor surface: `executeAgent` /
                        `executeCommand`. Mints the scoped GitHub token,
                        assembles the sandbox env, then delegates to the
                        Sandbox orchestrator. Thin — no backend branching.
    executors/
      orchestrator.ts   The Sandbox orchestrator: `withSandbox` bracket +
                        `runSandboxedAgent` / `runSandboxedCommand`. Owns skill
                        staging, build-artifact stage/harvest, the
                        RunResultAccumulator + shim + recordPiEvent event loop,
                        session-id notify, and the single converged fallback.
                        Computes one intent-only `EgressPolicy` per run.
                        Written once for every backend (replaced the
                        executeDocker/executeSmol/executeInProcess twins).
      shared.ts         Backend-agnostic building blocks (RunResultAccumulator,
                        skill-bundle staging, server-artifact stage/harvest,
                        finalizeFromRunResult, githubAuthEnvFrom).
    dispatcher.ts       Routes classified events to workflow or chat handler,
                        and gates every PR-scoped dispatch on the snapshot
                        below (run lock + decision, before any sandbox).
    pr-state.ts         The PR state machine: `resolvePrState()` — ONE
                        snapshot per dispatch of everything we know about a
                        PR (live GitHub facts + facts derived from our own
                        run history, keyed on the PR). The span of the run
                        lock is `prScopedWorkflows()` in
                        workflows/pr-scope.ts, derived from each workflow's
                        own `pr_scoped: true` YAML key.
                        Resolved at the dispatchWorkflow choke point and
                        persisted on `context.prState`. Never throws: every
                        read is best-effort and degrades to a value that
                        cannot cause a skip.
    pr-notes.ts         The PR journal — the agent-written half of that
                        snapshot (`PrState.notes`). Pure: kinds, the parse of
                        the `<kind>: <line>` grammar, the bounds (20 notes /
                        240 chars / 4 KiB, newest kept), staleness marking,
                        and the fenced render. Notes are HINTS: no decision
                        function reads them, `renderContext` projects them to
                        one string (`{{priorNotes}}`), and a note containing
                        `class=` or a marker tag is rejected on ingest.
                        Impure half lives in `fix-harvest.ts` (the drain).
    fix-scratch.ts      The two files the harness owns inside a PR checkout
                        — the fix loop's push gate
                        (.git/lastlight-verify.sh) and the PR journal
                        (.git/lastlight-notes) — and the one argument that
                        places both. They live under `.git/`, which git never
                        walks, so `git add -A` cannot commit them on ANY
                        backend and nothing has to be registered anywhere
                        (issue #256: the k8s backend never wrote the
                        `.git/info/exclude` line the old placement relied on,
                        and committed them into the PR).
    fix-harvest.ts      The impure half of the two above: after every phase it
                        parses the marker lines out of the output, DRAINS the
                        journal, and READS the push gate onto
                        `scratch.fixMarkers` — the gate is a read, not a drain,
                        because it is the live gate the next loop iteration
                        runs. The recorded script is the fix loop's main
                        debugging artifact (09 §S1) and the admin run detail
                        panel renders it beside the snapshot.
    pr-escalation.ts    What a TERMINAL skip does to the PR: applies
                        requires-human + one comment naming the case, the
                        attempts spent and each attempt's class/cause, and
                        the four exits (three retries + the hold) — and
                        RECORDS A RUN ROW first, because escalatedAtSha is
                        read back off the prior run's context and a skip
                        otherwise writes none (without it the guard never
                        binds and every later event re-escalates and
                        re-comments). Called from BOTH dispatch gates. Also
                        holds `recordIntervention` — the mirror-image row for
                        a RETRY that produced no run, so an ask the gate then
                        skipped for an unrelated reason isn't lost.
    pr-decisions.ts     PURE functions over that snapshot — mayMerge,
                        resolveFixDisposition, resolveMergeDisposition,
                        resolveReviewTrigger, resolveDispatchDisposition,
                        renderContext. Each returns
                        `{ decision, reason, inputs }`, so the log line, the
                        escalation comment and the admin panel are three
                        renderings of one source. Table-testable with no
                        GitHub mock and no sandbox.
    review-check.ts     The `last-light/review` Check Run as a PROJECTION of
                        run state: created at the dispatchWorkflow choke
                        point (so a cron/comment/Slack/CLI review gets one
                        too), persisted on `scratch.reviewCheck`, and
                        COMPLETED FROM THE RUN'S TERMINAL TRANSITION via the
                        run store's TerminalRunObserver — so simple.ts,
                        resume.ts, the queued-run TTL expiry and the admin
                        cancel all resolve it for free. It used to be
                        completed inside a `.then()` on an in-memory promise
                        and stranded `in_progress` on every deploy.
    event-shim.ts       Translates agentic-pi events → Claude-SDK envelope jsonl.
    llm.ts              One-shot LLM helper for screen/ + classifier —
                        direct fetch to Anthropic Messages or OpenAI Chat
                        Completions based on the model id prefix.
    github/             GitHub auth + client layer.
      git-auth.ts       GitHub App JWT → installation token. Supports
                        permission downscoping and a per-token repo allowlist.
      github.ts         Harness-side Octokit client (post comments, create
                        issues, react to comments). Not used by agents.
      github-tools.ts   In-process GitHub tools for the chat path.
      github-app-client.ts  GitHub App Octokit factory (JWT + token auth).
      profiles.ts       ExecutorConfig / ExecutionResult / GitSandboxAccess
                        types + GITHUB_PERMISSION_PROFILES + loadAgentContext.
    chat/               In-process chat path (Slack thread → pi-ai).
      chat.ts           Chat skill — one pi-ai session per Slack thread.
      chat-runner.ts    pi-ai conversation driver with retry logic.
      chat-skills.ts    Chat skill catalogue + read_skill tool.
      message-batcher.ts  Debounce bursty Slack message bursts before routing.
    screen/             Prompt screening + intent classification.
      screen.ts         Prompt-injection screener. Uses llm.ts with a cheap
                        model (claude-haiku by default).
      classifier.ts     Tiny LLM call that classifies a comment/message into
                        an intent (build / review / … / chat). Uses llm.ts.
                        The prompt is COMPOSED at runtime, not hardcoded: a
                        forkable base (workflows/prompts/classifier.md) + one
                        `classification:` block per workflow YAML. Adding a
                        workflow (even in an overlay) adds a routable intent
                        with no core edit — the router's getWorkflowByIntent
                        fallback routes it. `lastlight fork classifier` forks
                        the base prompt. (issue #164)
  workflows/            See src/workflows/CLAUDE.md for the full runner
                        story. Loads YAML definitions, executes phases
                        (linear or DAG), manages resume, approval gates,
                        loop iterations.
  sandbox/              Isolation backends for agent runs. One container/VM/
                        worktree per task, hardened path checks (gitdir mounts
                        validated against sandbox root, taskId traversal
                        rejected).
    sandbox.ts          The **Sandbox port** + `sandboxFor` factory + the four
                        adapters: `DockerSandbox`, `SmolSandbox`,
                        `InProcessSandbox` (`mode: gondolin | none`),
                        `FakeSandbox` (test-only). Each owns its isolation
                        mechanism + egress translation behind one interface
                        (`provision` / `stageSkills` / `runAgent` / `runCommand`
                        / `dispose`). The orchestrator (engine/executors) drives
                        them. See CONTEXT.md → "Sandbox execution".
    docker.ts           Docker container driver (`docker run` / `exec`) the
                        DockerSandbox adapter wraps.
    smol.ts             smolvm micro-VM driver the SmolSandbox adapter wraps.
    egress-allowlist.ts Single source of truth for HTTP egress hosts.
                        GITHUB_HOSTS + PROVIDER_HOSTS + PACKAGE_REGISTRY_HOSTS.
                        Leading-dot entries (e.g. ".github.com") are
                        wildcards matching apex + all subdomains. Both
                        backends import it: gondolin passes the list to
                        agentic-pi's `allowedHttpHosts`; docker generates
                        the nginx ssl_preread + coredns sinkhole configs
                        from it at boot.
    egress-firewall-config.ts
                        Generates nginx-strict.conf / nginx-open.conf /
                        Corefile.strict / Corefile.open + otel-collector.yaml
                        under $STATE_DIR/proxy/ at harness boot. The five
                        services in docker-compose.yml (coredns-strict,
                        coredns-open, nginx-egress-strict,
                        nginx-egress-open, otel-collector) read those files.
                        Sandbox telemetry on the docker backend flows
                        sandbox → otel-collector (internal IP) → real
                        backend, so the strict allowlist needs no collector
                        hosts or non-443 port handling.
  worktree/             Small helper for per-task git worktree setup inside
                        the sandbox. Implementation detail of `sandbox/`.
  admin/                Admin dashboard API (Hono) + SessionReader /
                        ChatSessionReader / auth / Slack OAuth login.
                        SessionReader scans agent-sessions/projects/-<cwd>/
                        for sandbox runs; ChatSessionReader is DB-backed
                        and groups by Slack thread.
  state/
    db.ts               `StateDb` — the ASYNC factory (`await StateDb.open(url)`
                        / `StateDb.fromClient(client, dialect)`; no public
                        constructor) that wires the seven stores together and
                        is the single import surface for their types. Every
                        store method returns a Promise. `open()` picks the
                        engine off the URL: libsql for `file:`/`:memory:`/a
                        path, Postgres for `postgres://`.
    pg-client.ts        The production Postgres client factory — node-postgres
                        or Neon serverless behind one `PgClientHandle`, each
                        driver DYNAMICALLY imported inside its own builder so a
                        SQLite deployment loads neither. Registers the int8
                        (OID 20) parser, without which every COUNT/SUM arrives
                        as a string. The one module under src/ that may import
                        schema/pg.ts (it must — `tablesOf` reads the schema off
                        the client); tests/state/driver-isolation.test.ts pins
                        both rules.
    data-migrate.ts     One-way sqlite → postgres row copy, FK-ordered and
                        batched, reading through the sqlite schema and writing
                        through the pg one (the JS value in between is
                        dialect-neutral). Refuses a non-empty target, verifies
                        row counts, and fails if a new table isn't in
                        TABLE_ORDER. Driven by state-cli.ts.
    state-cli.ts        The `lastlight-state` bin (`check` / `migrate`) that
                        ships in the agent image — what `lastlight server db`
                        runs inside the container, since the CLI may never gain
                        an edge to core.
    schema/sqlite.ts    Drizzle schema — the source of truth for all fifteen
                        tables (executions, workflow_runs, workflow_approvals,
                        cron_runs, cron_overrides, workflow_overrides, users,
                        messaging_*, feedback_*, github_team*).
    schema/pg.ts        The name-parity pgTable mirror. NOTHING under src/ may
                        import it — it exists for drizzle-kit and the PGlite
                        test leg. A schema change means editing BOTH files and
                        regenerating BOTH dialects; the parity test enforces it.
    client.ts           The Drizzle client type, `tablesOf(client)` (each store
                        destructures its tables from this rather than importing
                        a schema — importing `schema/sqlite.ts` into a store
                        would break value mapping on Postgres), and the
                        CONNECTION-scoped op serializer the nine transaction
                        sites share.
    dialect.ts          The portability seam — everything that genuinely
                        differs between sqlite and Postgres: rows() / changes()
                        / isUniqueViolation() / likeEscape() / dayBucket() /
                        hourBucket() / containsExpr() / sumTrue() / sumFalse().
                        Reaching around it is a portability bug.
    legacy-sqlite.ts    Idempotent pre-migrator compat step for deployments
                        older than the baseline (PRAGMA-guarded column adds +
                        the one-shot messaging table rebuild).
    cron-run-store.ts   The `cron_runs` ledger (issues #341/#327) — one row per
                        cron FIRE, scheduled or manual, for `workflow:` and
                        `handler:` crons alike, keyed on the CRON's name. A
                        zero-discovery fire dispatches nothing, so it writes no
                        `workflow_runs` and no `executions` row: this is the
                        only record that it ran at all. Keyed on the cron
                        rather than the workflow so a run dispatched by
                        `/api/run` or a comment cannot skew a cron's health.
    team-store.ts       The dashboard's per-repo visibility CACHE (issue #169):
                        github_teams / _team_repos / _team_members /
                        github_visibility_sync. Not a mirror of the org — rows
                        exist only for the teams of somebody who actually logged
                        in, so absence means "unknown", never "no access", and
                        every read path fails OPEN. Filled by
                        engine/github/team-visibility.ts.
  cron/                 croner scheduler. Each tick dispatches a
                        cron-kind workflow via the same runner.
    scheduler.ts        register/update/unregister/has + the tick → runner.
    jobs.ts             Build the job list from workflows/cron-*.yaml +
                        cron_overrides rows + the operator `crons:` block.
                        A globally-OFF cron stays REGISTERED, marked
                        `_cronGloballyEnabled: false`, so a repo opt-in can
                        be honoured at tick time.
    fanout.ts           One dispatch per repo (`context.repos`) — and the
                        shared engine behind the per-PR dependency-merge
                        fan-out. Narrows the repo list via repo-crons first.
    repo-crons.ts       Per-repo cron participation (issue #180):
                        resolveCronRepos / repoCronPrefs / cronVote /
                        repoLayerMayVote / operatorCrons, plus the
                        `_cronName` + `_cronGloballyEnabled` context keys the
                        fan-out consumes and strips. Resolved at TICK time so
                        a repo's `.lastlight/` edit lands on the next tick
                        with no scheduler churn.
    sandbox-sweep.ts    Hourly TTL/LRU workspace sweep (issue #106).
    handlers.ts         The HOST-SIDE cron handler registry — what a cron
                        YAML's `handler:` key may name. Built at boot (not a
                        constant) because each handler needs collaborators that
                        only exist then. A cron declares EXACTLY ONE of
                        `workflow:` (dispatch an agent workflow) or `handler:`
                        (run code in this process). `handler:` exists for
                        periodic work no agent can do — the digest's facts are
                        in the harness's own SQLite, unreachable from a sandbox,
                        and it posts to Slack, for which there is no agent tool.
                        A `registerDirect` job could do the same work but is
                        invisible to `getCronWorkflows()`, so it gets no
                        dashboard toggle, no schedule override, no per-repo
                        participation and no "Run now"; `handler:` buys all
                        four. An unresolvable name DROPS the cron with a boot
                        warning (it cannot fail boot — the registry is
                        conditional). `withLedger` wraps every registered
                        handler in ONE `cron_runs` row per invocation, keyed by
                        the cron's name — the same ledger, keyed the same way,
                        that a workflow cron's fire writes via `runner.ts`. So
                        `GET /crons` and the scheduler's failure alert read one
                        table and never branch on the kind of cron. It wraps
                        here, not in the scheduler, because admin "Run now"
                        invokes the registry directly.
    runner.ts           `makeCronRunner` — the fire path for `workflow:` crons,
                        extracted from `index.ts` so it is testable. Records the
                        same `cron_runs` row `withLedger` does, plus the counts
                        a fan-out produces (repos eligible/scanned, discovered,
                        dispatched, failures) and a `lastlight.cron.fire` span
                        + counter. Writes the outcome rather than returning it:
                        `WorkflowRunner` stays `Promise<void>`.
    repo-digest.ts      The weekly per-repo Slack digest: what happened in the
                        repo (GitHub) plus what Last Light did about it (the
                        state DB), posted to the repo's channel. Facts are
                        computed in code — `digest.narrative` spends ONE cheap
                        `llm.ts` call on a summary sentence, and a failure there
                        drops the sentence, never the digest. INERT until a
                        channel resolves: no channel, no post, no GitHub
                        request, no model call. Narrows its own repo list
                        through `resolveCronRepos` (nothing upstream does that
                        for a handler cron).
    dependabot-discovery.ts / review-discovery.ts
                        PR discoverers for the discovery crons (which fan out
                        per discovered PR, so src/index.ts narrows their repo
                        list through resolveCronRepos itself).
                        dependabot-discovery.ts is also THE single source of
                        truth for the label vocabulary — the dependency
                        lifecycle + impact labels, plus HOLD_LABEL
                        (`lastlight-ignore`) and its colour. It sits there
                        rather than in config/ so the hold reads correctly
                        beside the labels it is not; the packaged prompts
                        hardcode the same strings and
                        tests/cron/label-vocab.test.ts pins them together.

workflows/              YAML workflow definitions consumed by the loader.
                        build.yaml, pr-fix.yaml, pr-review.yaml,
                        issue-triage.yaml, issue-comment.yaml,
                        repo-health.yaml, cron-*.yaml.
workflows/prompts/      Prompt templates referenced from phases via
                        `prompt: prompts/architect.md` etc. Rendered with
                        the template engine in src/workflows/templates.ts.

skills/                 Skill directories — each contains SKILL.md
                        (with `name`/`description` frontmatter) plus
                        optional `scripts/`, `references/`, `assets/`.
                        Phases declare `skills: [a, b]` (or sugar
                        `skill: a`); the runner stages each into a
                        per-phase bundle at `<workspaceRoot>/
                        .lastlight-skills/<phase>/<name>/` (symlink for
                        none, copy for docker/gondolin — gondolin mounts
                        only cwd so a symlink would dangle in the guest)
                        before the agent
                        runs, then maps it to the agent via pi's
                        `--skill`/`skillPaths`. The bundle sits at the
                        workspace root — a sibling of any checked-out
                        repo, never in its git tree — and is keyed per
                        phase so parallel phases stay isolated. The
                        agent keeps cwd = the repo (no `cd` preamble);
                        docker bind-mounts the whole workspace so the
                        sibling bundle is reachable by an absolute
                        `--skill` path. (gondolin mounts only cwd, so
                        there the bundle is staged under the repo +
                        local `.git/info/exclude` — never committed.) pi
                        surfaces the mapped skills as an XML system-prompt
                        catalogue and the agent reads each SKILL.md on
                        demand via its `read` tool. Chat threads use the same skills
                        in-process via a `read_skill` tool —
                        catalogue built from every layer-resolvable skill
                        whose SKILL.md frontmatter sets `chat: true`
                        (src/engine/chat/chat-skills.ts), so an overlay
                        can add one or override a built-in.
agent-context/          *.md files concatenated and prepended as AGENTS.md
                        for every agent session — the bot's "personality"
                        plus hard rules. Sandbox entrypoint cats these into
                        $WORKSPACE/AGENTS.md; the chat-server supervisor
                        writes the same content + a chat-persona suffix
                        into its own AGENTS.md.

plugins/                Claude Code plugin (distinct from the internal
                        skills/ above). plugins/lastlight/ bundles
                        SKILL.md skills that teach Claude Code to install
                        and operate Last Light + Last Light Evals
                        (lastlight-server / -client / -overlay / -evals).
                        The repo root is also a Claude Code marketplace
                        (.claude-plugin/marketplace.json). Installed via
                        `lastlight skills install` (packages/cli/src/skills-install.ts):
                        prefers `claude plugin marketplace add nearform/lastlight`
                        (remote GitHub, so skills auto-update; `--local` uses the
                        bundled path), falls back to copying the skill dirs
                        into ~/.claude/skills. Shipped in the npm package
                        (files: .claude-plugin + plugins).

drizzle/                Generated migrations, per dialect (sqlite/, pg/) plus
                        each one's meta/ journal. Never hand-edited (the
                        `0000_baseline.sql` idempotency edit is the documented
                        one-off) and never applied with `drizzle-kit push`.
                        Regenerate with `db:generate:sqlite` / `db:generate:pg`.
                        Shipped in BOTH the npm tarball and the docker image
                        via the package.json `files` field — `pnpm deploy`
                        reads it, so removing "drizzle" from `files` is a
                        boot-time crash in the image as well as on npm.
deploy/                 Docker entrypoints, Caddyfile, systemd helpers.
dashboard/              React+Vite admin SPA, served from /admin at runtime.
```

## Key concepts

- **EventEnvelope** (`src/connectors/types.ts`) — canonical event shape.
  Every connector normalizes to it; the engine only ever sees EventEnvelopes.
- **Workflow** — a YAML file listing phases. The runner knows nothing about
  "build" vs "triage" — it just executes phases in order (or as a DAG). See
  `src/workflows/CLAUDE.md`.
- **PR state machine** (`src/engine/pr-state.ts` + `pr-decisions.ts`,
  `docs/plans/dependency-pr-resilience/09-state-machine.md`) — what the harness
  knows about a pull request is **resolved once per dispatch** into a `PrState`
  snapshot at the `dispatchWorkflow` choke point, and every policy question is
  then a pure function over it. It replaced reads spread across six sites, each
  fetching an overlapping subset and each free to disagree. Three things it
  buys: a real **PR-scoped run lock** across `pr-fix` / `dependabot-ci-fix` /
  `dependabot-pr-merge` / `pr-review` (the old
  `db.executions.isRunning(handler, triggerId)` guard never matched a row —
  wrong key on both predicates — so two agents could clone and push the same
  branch); identical context on the webhook and cron routes, because the cron
  fan-out calls `dispatchWorkflow` directly and used to bypass every enrichment;
  and a `{ decision, reason, inputs }` verdict per gate, rendered in the log, the
  escalation comment and the admin panel from one source. The loser of the lock
  is **dropped with a reason, not queued** — sound only because each dropped
  case has a cron re-pickup. A skip that is **terminal** for the problem
  (attempts or cost exhausted, or a diagnosis outside `fix.retryableClasses`)
  is not dropped silently: `pr-escalation.ts` records a run row, labels the PR
  `requires-human` and posts one comment. The row is the load-bearing part —
  see its module header. **Getting un-stuck is a recorded fact, not an
  inference from a commit** (`PrState.intervention`,
  `docs/plans/stuck-pr-recovery/03-retry-intervention.md`): a maintainer can
  push, comment `@<bot> retry [reason]`, remove `requires-human`, or run
  `lastlight pr retry <owner/repo#N> [reason]`
  (`POST /admin/api/prs/:owner/:repo/:number/retry`, the one surface with no
  event of its own — so it crosses `applyPrDispatchGate` in the admin route and
  dispatches itself), and all
  four re-arm the attempt counter *and* the cost baseline through the one
  `sameProblem` boundary. A retry keeps the agent's journal (`priorAttempts`)
  and marks the seam; a push still wipes it, because the code changed.
  Applying the **hold** label instead keeps the bot off entirely and beats
  every one of them. `pr-review` crosses the same gate, through
  `resolveReviewTrigger` — **the only implementation of `review.trigger`
  anywhere**, so `review-discovery.ts` is a candidate finder that knows nothing
  about modes, drafts or settled checks, an explicit `@bot review` is a decision
  rather than an accident of which code paths the comment route crossed, and the
  `last-light/review` check is a projection of run state (`review-check.ts`)
  instead of a `.then()` on an in-memory promise. Contract:
  `spec/05-router.md` → "The PR-scoped dispatch gate".
- **Configuration & deployment overlay** (`src/config/config.ts`, `config/default.yaml`,
  issue #61) — non-secret config (managed repos, routes, models, variants,
  approvals, disables, cron participation) is loaded at startup from the packaged
  `config/default.yaml`, then an optional `$LASTLIGHT_OVERLAY_DIR/config.yaml`
  is layered on, then legacy env vars override. **A fourth layer, the target
  repo's own `.lastlight/`, is applied per dispatch — see "Per-repo config
  layer" below.** Maps deep-merge; arrays
  (`managedRepos`, `disabled.*`) replace; secrets stay env-only. The same
  `LASTLIGHT_OVERLAY_DIR` root also overlays assets — `workflows/`,
  `workflows/prompts/`, `skills/`, `agent-context/` — resolved layer-aware by
  `src/workflows/loader.ts` (overlay wins by logical name; built-ins are the
  fallback). The public `config/default.yaml` ships an **empty** `managedRepos`
  list and no private values; `src/managed-repos.ts` reads the effective list
  via `getManagedRepos()` (runtime config, not a baked constant). **Effective
  managed-repo list:** a non-empty configured `managedRepos` wins and restricts
  to exactly those repos; when it's **empty**, the list is instead sourced from
  the **GitHub App installations** — the union of the repos every installation
  can access, fetched once at boot
  (`GitHubClient.listAllInstallationRepos()`, wired in `src/index.ts`) into an
  in-memory cache **keyed by installation id** and kept live by `installation` /
  `installation_repositories` webhooks (`src/connectors/github-webhook.ts`).
  Keyed rather than flat because those events are per-account: applied to one
  global set, a second org's `created` reset the list to just that org and its
  `deleted` cleared it entirely. So an org install that already
  limits the App to a subset of repos need not maintain a second copy in config.
  The admin `/managed-repos` endpoint (Config → Managed repos pane) surfaces the
  configured / installation / effective lists + source, plus every
  **installation** (account, id, repo count) and `uninstalledOwners` — any
  `managedRepos` owner the App isn't installed on, which would otherwise surface
  only as a failed mint mid-run. Caveat: for a
  `repository_selection: "all"` install, a newly-created org repo isn't picked up
  until the next boot fetch (no webhook fires); the `selected` case is fully
  covered. In the
  docker-compose stack the deployment folder is **`instance/`** (mounted
  read-only at `/app/instance`), holding `config.yaml` + asset overrides + a
  gitignored `secrets/` subdir (`.env`, `*.pem`). It's never baked into the
  image (no rebuild needed). Applying an edit: `config.yaml` and
  adding/changing an `.env` value take effect on `docker compose restart agent`
  (the entrypoint re-sources `.env`). **Removing** an `.env` value needs a
  recreate — `docker compose up -d agent` / `lastlight server start agent` —
  because compose injects `env_file` vars at container *creation* and a restart
  can't unset them. The dashboard `/config` endpoint surfaces Default / Overlay
  / Merged (non-secret). The overlay can also **pin the core version** via a
  `deploy.version` key (a git tag/ref, e.g. `v0.10.6`) — this is deployment
  config, not runtime behaviour: `lastlight server update|setup` checks core out
  at that tag instead of tracking `main`. Read host-side and in-container by
  `readCorePin()` (`src/config/core-pin.ts`); see "Redeploy a code change".
- **Per-repo config layer** (`src/config/repo-config.ts` +
  `packages/shared/src/repo-config-schema.ts`, issue #180) — a **managed repo**
  may commit a `.lastlight/` directory that overrides a **bounded** subset of
  config *for runs against that repo only*. Precedence becomes
  `default → overlay → env → repo`. The directory mirrors the instance overlay's
  shape exactly — `lastlight.yml`, `workflows/prompts/*.md`,
  `skills/<name>/SKILL.md`, `agent-context/*.md` — so the unpacked tree is handed
  to the same layer-aware asset loader with no second code path. **A repo may
  never contribute workflow YAML** (phases, permission profiles and approval
  gates stay the operator's; `populateCache()` skips `repo` layers structurally),
  and its `agent-context/*.md` is **additive only** — a file whose basename an
  operator-owned layer already provides is dropped, so a repo can't neuter
  `security.md` / `rules.md`.
  - **Trust rule.** The layer is ALWAYS read from the repo's **default branch**,
    never a PR head and never the sandbox checkout — otherwise a PR could
    reconfigure the agent reviewing it.
  - **Failure rule.** Warn, drop the offending keys, run anyway. A repo's config
    file can never fail a run. Every rejection is a structured
    `RepoConfigWarning` surfaced on the run row / admin API / CLI. The one
    "refusal" is a repo's own `disabled.workflows`, enforced at the
    `dispatchWorkflow` choke point.
  - **Operator bounds** — the `repoConfig:` block in config
    (`enabled`, `allowKeys`, `allowedModels`, `allowAssets`). Default allow-list:
    `models`, `variants`, `crons`, `disabled.workflows`, `disabled.crons`,
    `approval` (add-only — a repo may raise a gate, never clear one), `fix`,
    `dependencies`, `review` (one-way clamped — next bullet). Inert out
    of the box: nothing changes until a repo actually commits `.lastlight/`.
  - **Policy blocks** (`fix` / `dependencies` / `review`, issues #251/#252) —
    budgets and blast-radius dials, so they generalise `approval`'s add-only
    rule: **a repo may only ever be MORE conservative than the operator.** A
    loosening leaf is *dropped* with a `policy-downgrade` warning, and dropping
    IS the clamp (the base carries the operator's value, so the leaf resolves
    back to it). Per-key directions live with the sanitizers in
    `packages/shared/src/repo-config-schema.ts` — `min()` for the fix budgets,
    subset-only for `retryableClasses`, the lower tier for
    `autoMergeMaxImpact` and `review.trigger`
    (`on-request < after-checks < eager`), union-only for
    `review.generatedPaths`, add-only `true` for `requireSettledChecks` /
    `postsCheck` / `skipDraft` / `auditComment`, free for `requestLabel`
    alone. (`trigger` and `auditComment` were free until #256: the three
    review modes are equally *safe* but not equally *expensive* — `eager`
    buys a full agent review per push on the operator's budget — and the
    audit comment is the record of a major this deployment auto-merged,
    whose only silenceable party is the one being audited.) Three leaves are
    **operator-only** and answer `key-not-allowed` instead:
    `fix.escalateModelAfterAttempt` (spend),
    `fix.gateTimeoutSeconds` (shared resource), and
    `dependencies.minSettledChecks` — where a `max(repo, operator)` clamp would
    weld the escape hatch shut for a repo with no CI at all. `fix` +
    `dependencies` are now **live**: the PR dispatch gate (below) reads the
    run's repo-clamped blocks — on every route, webhook included — and enforces
    `fix.maxAttempts` / `fix.maxCostUsd` and
    `dependencies.requireSettledChecks` / `minSettledChecks`, and the green
    dependency cron reads the latter pair too. What the gate does **not**
    enforce is `dependencies.autoMergeMaxImpact`: that ceiling reaches the merge
    run only as prompt text and the impact tier is the agent's self-report, so
    it is policy the agent is asked to honour rather than a code-enforced
    ceiling (`spec/02-configuration.md` → "Where `dependencies` is enforced").
    **`review` is live as well**: `resolveReviewTrigger` is the one
    implementation of `review.trigger` on every route, and
    `src/cron/review-discovery.ts` is back to being a pure candidate finder.
    `review` is deliberately NOT seeded onto the template context — `build.yaml`
    already emits `output_var: review` and a top-level object would shadow it.
  - **Cron participation** — a `crons: { enable, disable }` block, valid at
    EVERY layer. Operator `crons.disable` = off *by default* (the tick stays
    registered); a repo's `crons.enable` opts in even when globally off,
    `crons.disable` opts out, disable wins if both. The legacy `disabled.crons`
    is unioned into `crons.disable`. **The operator's un-overridable kill switch
    is removing `crons` from `repoConfig.allowKeys`** — `repoLayerMayVote()` then
    short-circuits with zero fetches.
  - **Fetch/cache** — through the App-authenticated client (private repos work),
    cached under `<stateDir>/repo-config/<owner>/<repo>/` with a 60 s TTL +
    ETag/tree-sha conditional requests, so a cron fan-out over N repos costs N
    conditional requests and zero downloads. Caps: 200 files / 2 MiB; symlinks
    rejected.
  - **Concurrency** — resolved once per dispatch (`resolveRepoRunConfig`) and
    carried explicitly on the run as `RunRepoConfig`, never installed into a
    module global. Assets go through a **per-run `AssetResolver`**
    (`createAssetResolver` in `packages/shared/src/workflow-loader.ts`); the
    composed agent context travels as `ExecutorConfig.agentContext` and is used
    verbatim by both delivery paths (workspace write, or the k8s
    `AgentContextSink`).
  - **Resume** reuses the run's persisted `context.repoConfig` record instead of
    re-resolving, so an edit made while a run was paused can't retarget it
    mid-flight.
  - **Surfaces** — `GET /admin/api/repos/:owner/:repo/config` (merged config +
    per-leaf provenance `default`/`overlay`/`env`/`repo`, the raw redacted repo
    layer, warnings, assets, effective policy; `?refresh=1` bypasses the TTL)
    powers the dashboard's per-repo **Config** tab; the CLI side is
    `lastlight repo fork` / `repo config validate` / `repo config show`
    (see `packages/cli/CLAUDE.md`). Full contract: `spec/02-configuration.md`.
    The dashboard hand-mirrors `RepoMergedConfig` / `RepoConfigSources` in
    `dashboard/src/api.ts` (no import edge to core); the copies drifted once and
    hid the three policy blocks for a release, so
    `tests/admin/dashboard-config-mirror.test.ts` now pins the mirror and the
    tab's section list against the real type.
- **Two execution modes**:
  - **Sandbox** — workflow phases run inside a Docker sandbox
    (`src/sandbox`) with a minted per-run GitHub token. Each phase invokes
    `agentic-pi run --format json` in the container and the harness parses
    the streamed events into an ExecutionResult + envelope jsonl. Every
    phase writes an `executions` row.
  - **Chat** — the chat skill (`src/engine/chat/chat.ts`) drives a `pi-ai`
    conversation in-process. One session per messaging thread, resumed
    across turns. Each turn writes an `executions` row (triggerType=`chat`,
    skill=`chat`, triggerId=messaging session id) and the same shim drops a
    jsonl envelope under `agent-sessions/projects/-app/`.
- **Two session stores**:
  - **Sandbox sessions** — shim envelope jsonls at
    `$STATE_DIR/agent-sessions/projects/-<sanitized-sandbox-cwd>/`
    (currently `-home-agent-workspace`). Read by `SessionReader`.
  - **Chat sessions** — DB-backed (`executions` table grouped by
    `trigger_id` / Slack thread). Read by `ChatSessionReader`; messages
    resolved to the single jsonl owned by `messaging_sessions.agent_session_id`
    under `agent-sessions/projects/-app/`.
- **Permission profiles** (`src/engine/github/profiles.ts`) — each workflow maps to
  a `GitAccessProfile`: `read`, `issues-write`, `review-write`, `repo-write`.
  `runner.ts` picks one per workflow name and the agent-executor mints a
  downscoped installation token for the sandbox (minting is gated on **boot
  config**, `getRuntimeConfig().githubApp`, never live `process.env`). No profile
  forwards the App PEM today; every run uses that pre-minted scoped token, which
  agentic-pi's built-in github tools (its `github` extension — the
  `github_*` tools, gated per profile) read from a **per-run** credential
  channel: the container backends get it in the container env, and the
  in-process backends (gondolin/none) get it via agentic-pi's `githubAuthEnv`
  argument. It is **never** spliced into the harness's shared `process.env` —
  concurrent in-process runs live in that one env, so a token there crossed
  between runs and 403'd every `github_*` write (issue #215; see
  `spec/09-sandbox.md` → "Invariant: per-run credentials never travel through
  `process.env`"). The standalone `mcp-github-app` MCP server that used to
  expose these tools was removed with the OpenCode→agentic-pi migration.
  **`repo-write` is also the only profile that registers `github_publish`** —
  how every code-writing phase now puts its work on the branch, in place of
  `git add && git commit && git push`. The token authenticates a push but cannot
  sign a commit, and one unsigned commit anywhere in a branch blocks a
  `required_signatures` PR permanently, so the tool diffs the working tree
  against the remote tip and hands the change set to GraphQL
  `createCommitOnBranch`, which builds and signs the commit server-side —
  expected to be under the App's `[bot]` identity, though that half is
  **unverified** (the probes used a user PAT; `docs/plans/signed-commit-publish/00-findings.md`
  §5) (issue #268; `spec/09-sandbox.md` → "Invariant: the published commit
  is built by GitHub, not by git"). Local `git commit`s remain fine — they are
  folded in — and there is no `git push` fallback.
- **Approval gates** — phases can declare `approval_gate: post_architect`.
  When hit, the run persists with `status: paused`, a row in
  `workflow_approvals`, and the user can resolve it via GitHub comment
  (`@last-light approve` / `reject`), Slack slash command (`/approve`,
  `/reject`), or the dashboard. Resume logic is in `src/workflows/resume.ts`
  and is runtime-agnostic — it operates on `ExecutionResult` + DB rows.
- **Feedback signals** (`src/engine/feedback/`, `src/state/feedback-store.ts`,
  issue #255) — a 👍/👎 someone leaves on something the bot wrote, scored
  against the workflow run that wrote it, so a prompt/skill change's effect on
  quality is measurable rather than felt. Analytical only: nothing reads a
  signal back into the agent's behaviour. Scores: 🎉🚀❤️ +2, 👍😄 +1, 👀 **0**
  (recorded, not scored — it is the bot's own ack emoji, so counting it as
  criticism would poison the dataset), 👎 -1, 😕 -2.
  - **Attribution runs through an ANCHOR**, because a reaction names a *message*
    and a signal needs a *run*. Anchors are written at the only moment the
    association is free: when we post (Slack — `sendMessage`'s returned `ts`,
    which every send site used to discard) or when a run finishes (GitHub
    discovery of what it posted). Nothing recomputes it later; by then the only
    evidence would be timestamps.
  - **Slack is live and on**; `reaction_added` is a real event. Needs the
    `reactions:read` bot scope + subscriptions (see Environment) and an app
    re-consent.
  - **GitHub must be POLLED and ships off** (`feedback.github`) — GitHub sends
    no webhook for reactions at all. `src/cron/feedback-poll.ts` refreshes the
    least-recently-polled anchors through one batched GraphQL `nodes(ids:)`
    query per 100, measured at **one rate-limit point per request** with the
    reactors included. The bound is on the data, not the schedule: individual
    bot comments (never issues), retired after `feedback.windowDays`, capped at
    `feedback.maxAnchorsPerTick` (÷100 = the tick's request count).
  - A **retraction is a fact, not a delete** — removing a reaction stamps
    `removed_at`; every score query filters `removed_at IS NULL`. And
    `exported_at` is stamped only when a span really went out, so turning OTel
    on later still gets the backlog (`drainFeedbackExport`, at boot).
  - Surfaces: the dashboard's **Feedback** tab + a per-run badge,
    `GET /admin/api/feedback/{signals,summary,daily}` and
    `/admin/api/workflow-runs/:id/feedback`, and an OTel span on the run's own
    trace (see the OpenTelemetry section).
- **Sandbox HTTP egress allowlist** — both backends apply a default-deny
  HTTP egress policy. The host list lives in `src/sandbox/egress-allowlist.ts`
  (`GITHUB_HOSTS` + `PROVIDER_HOSTS` + `PACKAGE_REGISTRY_HOSTS`).
  Entries with a leading dot (e.g. `.github.com`) match the apex AND
  every subdomain.
  - **gondolin**: `agent-executor.ts` passes `allowedHttpHosts` to
    agentic-pi's `run()`. The VM's HTTP interceptor 502s anything off-list.
  - **docker** (SNI-peeking firewall, inspired by Vercel Sandbox):
    The harness writes `nginx-strict.conf` / `nginx-open.conf` /
    `Corefile.strict` / `Corefile.open` to `$STATE_DIR/proxy/` at boot.
    Four services in docker-compose.yml — `coredns-strict` (172.30.0.10),
    `coredns-open` (172.30.0.11), `nginx-egress-strict` (172.30.0.20),
    `nginx-egress-open` (172.30.0.21) — implement the firewall. Sandbox
    containers spawn with `--dns <coredns-ip>` and **no proxy env vars
    at all**. The sandbox dials real hostnames; coredns sinkholes
    allowlisted ones to the nginx IP; nginx peeks the TLS SNI and
    tunnels to the real upstream via `proxy-egress`. This works for
    every SDK regardless of whether it honours `HTTP(S)_PROXY` (the
    OpenAI/Anthropic SDKs don't, which is why the earlier tinyproxy
    approach failed). See `src/sandbox/egress-firewall-config.ts` for
    the full architecture rationale and `docker-compose.test.ts` for
    the topology contract.
  - **Opting out**: a workflow phase can declare `unrestricted_egress: true`
    in YAML to bypass the allowlist for that phase only. Gondolin then
    receives `["*"]` (wildcard allow-all); docker routes through the
    `coredns-open` + `nginx-egress-open` pair. Use sparingly — for
    phases that need broad web access (e.g. an explore phase searching
    third-party docs).
  - **SSRF floor**: `coredns-open` hard-NXDOMAINs the cloud-metadata
    literals (`169.254.169.254`, `metadata.google.internal`) even in
    unrestricted mode. Strict mode blocks all private destinations
    inherently — anything not in the allowlist resolves to NXDOMAIN.
  - **Caveat (no TLS termination)**: we peek SNI without decrypting,
    so a hostname like `evil.example.com` whose A record points at
    `10.0.0.5` would not be caught by the strict filter — but it would
    never resolve in the first place, since coredns-strict only knows
    the allowlist hosts. In the open mode, the same hostname WOULD
    resolve (to the nginx-open IP) and nginx would tunnel to the
    attacker-controlled host. Closing that requires TLS termination
    (e.g. Envoy + dynamic_forward_proxy with post-resolve IP checks),
    which we haven't pulled in.

## State directory

Everything persistable lives under `$STATE_DIR` (default `./data`, mount as
a Docker volume in production).

```
data/
  lastlight.db              SQLite — executions, workflow_runs,
                            workflow_approvals, cron_runs (one row per cron
                            fire, scheduled or manual, workflow and handler
                            crons alike), messaging_sessions,
                            messaging_messages, feedback_anchors,
                            feedback_signals, plus daily/hourly stat
                            rollups.
  agent-sessions/           Shim destination (override with
                            `LASTLIGHT_SESSIONS_DIR`). Its `projects/` subdir is
                            the source of truth for dashboard session reads:
    projects/
      -app/                 Chat sessions (one jsonl per Slack thread,
                            keyed by pi-ai sessionId).
      -home-agent-workspace/  Sandbox sessions (cwd inside the container).
  sandboxes/                Cloned repos per task (one dir per taskId).
  build-assets/             Server-mode build handoff docs (only when
                            buildAssets.location=server):
                            <owner>/<repo>/<issueKey>/*.md — never committed
                            into the target repo. Store: src/state/build-assets.ts.
  repo-config/              Per-repo `.lastlight/` layer cache (issue #180):
                            <owner>/<repo>/meta.json (sidecar: default branch,
                            tree sha, etag, warnings) + <owner>/<repo>/files/
                            (the unpacked tree, written to files.tmp and
                            renamed). Pure cache — safe to delete; refilled by
                            the next conditional fetch. Holds untrusted bytes
                            from managed repos, so nothing in it is executed.
  logs/                     Structured harness logs.
  proxy/                    Generated egress firewall configs (docker
                            backend): nginx-strict.conf, nginx-open.conf,
                            Corefile.strict, Corefile.open, plus
                            otel-collector.yaml (in-network OTEL collector
                            config; mode 0600 — may hold backend auth
                            headers). Regenerated on every harness boot from
                            src/sandbox/egress-firewall-config.ts.
                            Bind-mounted read-only into the coredns + nginx
                            + otel-collector containers.
  secrets/app.pem           Mode-600 copy of the GitHub App PEM. Copied
                            here by deploy/entrypoint.sh so sandbox
                            containers can read it via the shared volume
                            (sandbox-entrypoint materializes an
                            agent-readable copy only when ALLOW_APP_PEM=1).
```

## Commands

```bash
# From the repo root these are `pnpm --filter lastlight-core <script>`; from
# apps/server the bare `pnpm run <script>` works too. Workspace-level commands
# (turbo typecheck/test/build) live in the root CLAUDE.md.

# Dev server (webhooks + Slack socket + cron + admin dashboard)
pnpm --filter lastlight-core dev              # server + dashboard, watch mode
pnpm --filter lastlight-core build            # tsc for server
pnpm --filter lastlight-core build:dashboard  # vite build for dashboard/
pnpm --filter lastlight-core start            # compiled JS

# Tests
pnpm --filter lastlight-core test                       # full server suite (docker ITs skip unless opted in)
pnpm --filter @lastlight/dashboard typecheck            # dashboard typecheck

# State schema change — BOTH dialects, always. Edit src/state/schema/sqlite.ts
# AND src/state/schema/pg.ts, then regenerate both; tests/state/schema-parity
# fails if they drift, and the whole state suite runs a second time against
# real Postgres (PGlite) so a portability break fails loudly rather than at
# some future deployment.
pnpm --filter lastlight-core run db:generate:sqlite
pnpm --filter lastlight-core run db:generate:pg

# Sandbox integration tests — actually start a docker sandbox and run a no-AI
# workflow (type: bash / type: script phases). Opt-in + self-gating: needs
# docker + the lean image built, else skips instantly.
docker compose --profile build-only build sandbox-base   # shared base first
docker compose --profile build-only build sandbox        # then the lean image
RUN_SANDBOX_IT=1 npx vitest run tests/sandbox/command-exec.integration.test.ts

# The `lastlight` CLI (thin admin-API client + host-local `server` lifecycle,
# fork, skills install, oauth) lives in packages/cli — see packages/cli/CLAUDE.md
# for the full command catalogue and the deploy flow.

# Local dev with a real sandbox backend (gondolin by default; docker/none opt-in)
./scripts/dev-local.sh                 # sets up $STATE_DIR + secrets,
                                        # then starts the harness in watch mode
```

## Environment

Required:

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`
- `WEBHOOK_SECRET` — must match the GitHub App webhook secret
- **`GITHUB_APP_INSTALLATION_ID` is OPTIONAL** (legacy seed). A GitHub App is
  installed per **account**, each with its own installation id, and a token
  minted against the wrong one is rejected (`422 … not accessible to the parent
  installation`). So installations are **discovered** from the App JWT
  (`GET /app/installations`, plus every webhook's `payload.installation`) and
  resolved **per repo owner** by `InstallationDirectory`
  (`src/engine/github/installations.ts`) — the one authority the per-run mint,
  `GitHubClient` and the chat GitHub tools all go through. One instance
  therefore serves every account the App is installed on. The env var carries no
  account, so it's used only when that lookup itself fails (network, revoked
  PEM), keeping an old single-installation deployment on its previous behaviour.
  `GET /admin/api/managed-repos` lists the installations and any
  `uninstalledOwners`.
- **Bot identity** (optional; defaults to `last-light`) — `botName` is the
  GitHub App slug (no `[bot]` suffix) and the single source of truth for the
  bot's identity. Set it in the overlay `config.yaml` (`botName:
  nearform-lastlight`) or via the `GITHUB_APP_BOT_NAME` env var. It derives
  three things: the incoming **`@mention` handle** the router triggers on
  (`@<botName>` — *only* the configured handle matches, no legacy fallback),
  the **`botLogin`** used to filter the bot's own comments/reviews
  (`<botName>[bot]`, still overridable with `BOT_LOGIN`), and the **git commit
  author** for agent commits (`<botName>[bot]`). Must match the real App slug
  so `@`-autocomplete and notifications work.
- One of the provider API-key env vars from `packages/shared/src/providers.ts`
  (Anthropic / OpenAI / OpenRouter / Google / Mistral / Groq / Cerebras /
  xAI / Hugging Face / Moonshot / NVIDIA / Fireworks / Together / DeepSeek /
  Z.AI / Kimi / MiniMax) matching your `LASTLIGHT_MODEL` (set multiple if
  `LASTLIGHT_MODELS` routes phases to different providers)

Models (the legacy `OPENCODE_MODEL/MODELS/VARIANT/VARIANTS` names are still
accepted as aliases for the `LASTLIGHT_*` forms below):

- `LASTLIGHT_MODEL` — default model for sandbox + chat
  (default: `anthropic/claude-sonnet-4-6`, from `config/default.yaml`)
- `LASTLIGHT_MODELS` — per-task overrides as JSON, e.g.
  `{"architect":"anthropic/claude-opus-4-8","triage":"anthropic/claude-haiku-4-5-20251001"}`.
  Keys match phase names or skill types.
- `LASTLIGHT_THINKING` — catch-all reasoning-effort default (passed to
  agentic-pi as `--thinking`; `--variant` is an accepted alias).
  Provider-agnostic; pi-ai translates to the right per-provider knob (OpenAI
  `reasoning_effort`, Anthropic thinking budget, etc.). Common values:
  `minimal`, `medium`, `high`, `max`.
- `LASTLIGHT_THINKINGS` — per-task overrides as JSON, same key
  scheme as `LASTLIGHT_MODELS`. Example:
  `{"architect":"high","reviewer":"high","review":"high","triage":"minimal"}`.
  Phases can also declare `variant: "{{variants.<phase>}}"` in YAML
  for per-phase resolution.

Runtime:

- `PORT` — webhook listener port (default 8644)
- `LOG_LEVEL` — pino level for operational logs: `debug|info|warn|error|fatal`
  (default `info`). Set `LOG_LEVEL=debug` to open up debug tracing.
- `LOG_FORMAT` — `json|pretty` (default: auto — `pretty` when stderr is a TTY,
  `json` otherwise, so k8s/prod gets JSON automatically without setting this).
  **Log contract** (`src/logging/logger.ts`): operational logs are JSON lines
  on **stderr** carrying a string `level`, plus `component`, `msg`, `err`,
  `time`, and — inside an active OTel span — `trace_id`/`span_id`. The
  cluster's Vector DaemonSet tails pod stderr and its `pod_level` transform
  reads that JSON `level` straight into Loki's severity, instead of guessing
  from plaintext. **stdout** is reserved for the sandbox's NDJSON event
  protocol (agentic-pi's emitter) — never write operational logs there.
- `LASTLIGHT_OVERLAY_DIR` — trusted deployment overlay root (docker-compose
  mounts `instance/` here as `/app/instance`). Layered over
  `config/default.yaml` for config + assets; secrets read from its `secrets/`
  subdir. Read at startup — restart to apply (but *removing* an `.env` var needs
  a recreate, `lastlight server start agent`; see the `instance/` note above).
- `STATE_DIR` — persistent state dir (default `./data`)
- `DB_PATH` — override the SQLite path
- `DATABASE_URL` — the state DB, as a libsql-style URL
  (`file:/app/data/lastlight.db`, `:memory:`) **or** a `postgres://` URL for an
  external/managed Postgres. Effective value, first hit wins: this env var →
  overlay `config.yaml` `database.url` → `config/default.yaml` (ships `null`) →
  `file:` + the `DB_PATH` / `$STATE_DIR/lastlight.db` path above. Setting none
  of them is the pre-Drizzle behaviour, so existing deployments change nothing,
  and SQLite remains the default and the recommendation (nothing to run).
  **A `postgres://` URL belongs in this env var (`instance/secrets/.env`), NOT
  in the overlay `config.yaml`** — that file is version-controlled and pushed
  to a GitHub remote, and the dashboard's masking happens at render time, which
  cannot un-commit anything. Credentials are redacted from the `/config` view
  and the boot log by value (`redactDbUrl`), never by key: `SENSITIVE_KEY_RE`
  must not match `url`, and a `file:` URL should stay legible.
  `lastlight server setup` offers the choice (SQLite by default).
- `DATABASE_DRIVER` — `pg` (default, node-postgres TCP pool) | `neon`
  (`@neondatabase/serverless`, a WebSocket pool). Unset auto-detects from the
  host (`*.neon.tech` → `neon`); set it only for Neon behind a custom domain,
  or to force node-postgres against Neon's TCP endpoint. Equivalent config:
  `database.driver`. `DATABASE_POOL_MAX` (`database.poolMax`, default 10)
  bounds the pool. Postgres is a **storage** choice, not multi-instance HA —
  one instance still, since the named atomic ops use an in-process mutex.
  Moving an existing SQLite database across: `lastlight server db migrate`
  (see `spec/10-state.md` → "Moving an existing database to Postgres").
- `LASTLIGHT_HOLD_LABEL` — the **hold** label a maintainer applies to an issue
  or PR to stop Last Light acting on it at all (default `lastlight-ignore`;
  overlay `hold.label`). Read by `getHoldLabel()` at exactly two choke points —
  `resolveDispatchDisposition` and the router's subject-level ignore — so it
  covers every workflow and every route. Distinct from `requires-human`, which
  the bot *writes* as a notification and nothing reads. Renaming it changes what
  the code gates on, but the packaged dependency prompts still create the
  **default** name in their `github_ensure_labels` pass — so a rename wants a
  forked prompt too, or the label created by hand.
- `LASTLIGHT_HOME` — working directory for the host-local `lastlight server`
  lifecycle commands (start/stop/restart/update/status): a full repo checkout +
  `instance/` overlay + `docker-compose.override.yml` symlink (the docker build
  context). Resolution: `--home` flag → this env → `serverHome` in
  `~/.lastlight/config.json` (written by `lastlight server setup`) → `~/lastlight`.
  CLI-side only — the harness itself doesn't read it.
- `LASTLIGHT_GIT_SHA` / `LASTLIGHT_BUILD_DATE` — core git SHA + build date baked
  into the agent image (Dockerfile `ARG`s). `lastlight server update` passes
  `--build-arg GIT_SHA=$(git rev-parse HEAD)`; surfaced by
  `GET /admin/api/server/info` for the dashboard drift banner. Empty → "unknown".
- `LASTLIGHT_CORE_VERSION` — override the overlay's `deploy.version` core-version
  pin (a git tag/ref) so CI can pin without editing `config.yaml`. Consumed by
  the host-local `lastlight server update|setup` and the in-container drift
  banner via `readCorePin()`. Unset (or `main`/`latest`) tracks `main`.
- `LASTLIGHT_BUILD_ASSETS` — `repo` (default) | `server`. In `server` mode the
  per-phase build handoff docs (`architect-plan.md`, `status.md`,
  `executor-summary.md`, `reviewer-verdict.md`, …) are externalized to the
  Last Light host instead of being committed into the target repo under
  `.lastlight/`. The executor stages the store's docs into the workspace
  before each phase and harvests them back afterwards
  (`src/engine/agent-executor.ts`). For pre-cloned workflows (build, pr-*) on a
  whole-workspace backend (docker/none/smol) the staged dir is the **workspace
  root** — a sibling of the checkout — so the agent's `git add -A` structurally
  can't commit it (`buildAssetsRelocated`; `{{issueDir}}` becomes
  `../.lastlight/<key>`). gondolin mounts only cwd, so there (and in repo mode)
  it stays the in-repo `.lastlight/<key>/`, kept out of git by the prompt-level
  commit gate (`{{#if !externalizeArtifacts}}`) + `.git/info/exclude`.
  `{{artifactUrl}}` links resolve to the dashboard's Artifacts view; the admin
  API serves them read-only at `/admin/api/artifacts`. Equivalent config:
  `buildAssets.location`.
- `BUILD_ASSETS_DIR` — server-mode build-asset store root
  (default `$STATE_DIR/build-assets`; layout
  `<owner>/<repo>/<issueKey>/*.md`, store in `src/state/build-assets.ts`)
- `LASTLIGHT_SESSIONS_DIR` — override the dashboard session-jsonl root
  (default `$STATE_DIR/agent-sessions`)

Sandbox egress (docker backend only):

- `LASTLIGHT_SANDBOX_NETWORK` — docker network sandbox containers attach
  to (default: `lastlight_sandbox-egress`). Set to `default` to keep
  containers on the default bridge — only useful when running the harness
  outside docker-compose where the sandbox-egress network doesn't exist.
- `LASTLIGHT_DNS_STRICT` / `LASTLIGHT_DNS_OPEN` — override the IP of the
  coredns sidecar passed to `docker run --dns ...` (defaults: `172.30.0.10`
  and `172.30.0.11`, matching the static IPs in docker-compose.yml).
- `LASTLIGHT_PKG_CACHE_VOLUME` — docker named volume mounted at `/cache` in
  every sandbox as the shared package-manager download cache (issue #107).
  Default `lastlight_pkg-cache` (declared in docker-compose.yml). The
  sandbox env points `npm_config_cache` → `/cache/npm`,
  `npm_config_store_dir` (pnpm) → `/cache/pnpm`, and `YARN_CACHE_FOLDER` →
  `/cache/yarn`; the agent picks the package manager from the repo's
  lockfile (see `skills/pr-review/SKILL.md`), so repeated installs reuse
  already-fetched tarballs regardless of which one a repo uses. This is the
  *download* cache only — per-workspace `node_modules` stays per-workspace
  (a shared store can't hardlink across separate container mounts). Disk is
  bounded instead by per-PR workspace reuse (`PER_TARGET_REUSE_WORKFLOWS`
  in `src/workflows/simple.ts`) plus #106's reaping.

Sandbox (smolvm `smol` backend — experimental, opt-in):

- `LASTLIGHT_SANDBOX=smol` runs each phase in a smolvm micro-VM (own kernel
  via Hypervisor.framework / KVM). Local-only: needs the `smolvm` CLI on PATH
  and a host hypervisor. Driven by `SmolSandbox` (`src/sandbox/smol.ts`) over
  the smolvm CLI — peer of the docker backend (runs `agentic-pi run --sandbox
  none` inside the VM). Not the default; `config/default.yaml` stays `gondolin`.
- `SMOLVM_BIN` — `smolvm` CLI path (default `smolvm`).
- `SMOLVM_IMAGE` — OCI ref OR a local `docker save` archive / rootfs dir
  (default `lastlight-sandbox:latest`). The archive form loads offline (no
  registry) so it works under the strict allowlist: `docker save
  lastlight-sandbox:latest -o img.tar` then `SMOLVM_IMAGE=img.tar`.
- Egress is native per-machine `--allow-host` from the same
  `egress-allowlist.ts` — no coredns/nginx sidecars. **Caveat:** smolvm
  resolves each host at VM start and the filter is IP-pinned (not
  apex+subdomain like docker SNI / gondolin); unresolvable apex-only entries
  are pre-dropped. Workspace bind-mounts at `/workspace` (smolvm's special
  path → direct share). See `spec/09-sandbox.md`. Opt-in IT:
  `RUN_SMOL_IT=1 SMOLVM_IMAGE=<archive> npx vitest run tests/sandbox/smol.integration.test.ts`.

Sandbox (`kubernetes` backend — in development, opt-in):

- `LASTLIGHT_SANDBOX=kubernetes` runs each workflow phase as its own bare Pod
  in a dedicated namespace — the harness itself is a Kubernetes client
  (`@kubernetes/client-node`), a structural peer of the docker/smol backends
  behind the same `Sandbox` port, driven by `KubernetesSandbox`
  (`src/sandbox/k8s/kubernetes-sandbox.ts`). Not the default;
  `config/default.yaml` stays `gondolin`. See `deploy/k8s/README.md` for the
  cluster prerequisites and a ready-to-apply `kubectl apply -k` manifest set,
  and `spec/09-sandbox.md` for the full contract (pod lifecycle, credentials,
  egress via `CiliumNetworkPolicy`, per-PR workspace PVCs, quota-based
  backpressure). Opt-in IT: `RUN_K8S_IT=1 npx vitest run
  tests/sandbox/k8s/kubernetes.integration.test.ts`.

Sandbox dependency services (`docs/plans/sandbox-services`):

- A managed repo may declare `services:` in `.lastlight/lastlight.yml` — a test
  postgres/redis a phase runs against, in Actions' vocabulary minus expressions.
  The harness starts them in the sandbox's own network namespace, so the phase
  reaches them on `localhost` and the sandbox gains **no new privilege** (no
  docker socket, no root, no docker client). `docker` + `kubernetes` only;
  the other backends log once and run without.
- **Inert by default**: `repoConfig.allowedImages` is deny-all until an operator
  lists registry-qualified images — the INVERSE polarity to `allowedModels`.
- `LASTLIGHT_K8S_FORWARDER_IMAGE` / `LASTLIGHT_FORWARDER_IMAGE` — image for the
  port-remap forwarder sidecar (default `alpine/socat:latest`). Operator config;
  never subject to `allowedImages`. Equivalent config: `kubernetes.forwarderImage`.
- Full contract: `spec/09-sandbox.md` → "Dependency services".

Sandbox workspace provisioning (issue #107):

- **Shallow clone** — read-only workflows (everything except the
  `repo-write` profiles `build` / `pr-fix` / `security-feedback`) pre-clone
  at `--depth 1 --single-branch`; code-pushing workflows keep `--depth 50`.
  See `gitSandboxAccessForWorkflow` (`src/workflows/runner.ts`) →
  `prePopulateWorkspace` (`src/sandbox/index.ts`).
- **Base merge-base fetch** — a `--depth 1 --single-branch` head clone omits
  the base branch entirely, so `git diff origin/<base>...HEAD` (the three-dot PR
  diff the review agent *and* `post-review` anchor against) dies with "no merge
  base". For PR-diff workflows the pre-clone therefore threads the PR's
  `baseBranch` (`GitSandboxAccess.baseBranch`, from `ctx.baseBranch`) through and
  `ensureBaseAvailable` (`src/sandbox/index.ts`) fetches the base as a real
  `origin/<base>` ref and deepens *both* refs (base + the depth-1 head) until
  they share a merge-base — depth 50 → 500 → full unshallow. Best-effort: on
  failure the plain clone stands and `post-review` demotes to its two-dot / body
  fallback. Runs on **every** provisioning path — the fresh clone, the
  per-PR-reuse refresh, *and* a later phase of the same run (the k8s init
  container's `ensure_base` mirrors all three). That last one matters: the
  same-run path preserves the checkout, and it used to return before any fetch,
  so `origin/<base>` was frozen from the run's first phase and a fix phase
  merged a base tens of minutes stale — leaving the PR `dirty`, which GitHub
  cannot compute a merge ref for, so no `pull_request` workflow runs at all.
  Refreshing there is safe because it writes remote-tracking refs only — never
  HEAD, the index or the working tree. It also adds the base to
  `remote.origin.fetch` (`git remote set-branches --add`), since `--depth`
  implies `--single-branch` and the agent's own `git fetch origin <base>` would
  otherwise move `FETCH_HEAD` and nothing else.
- **Per-PR workspace reuse** — `pr-review` / `pr-fix` workspaces are keyed
  by (repo, PR) and reused across runs. A `<workDir>/.lastlight-run` marker
  records the owning run: same run → preserve the checkout for the next
  phase; a different run reusing the dir → `git fetch` + `reset --hard` +
  `git clean -fdx -e node_modules` (deps stay warm). The whole fix family
  (`PR_FIX_SHAPED_WORKFLOWS`) shares ONE workspace per PR —
  `${repo}-${prNumber}-fix`, not `…-${workflowName}` — because the PR-scoped
  run lock admits only one of them at a time and routing between `pr-fix` and
  `dependabot-ci-fix` genuinely varies by how the event arrived. See the
  workflows guide's "taskId scoping" section.
- **Per-issue build recreate (issue #153)** — `build` workspaces are keyed by
  (repo, issue) too, but a different-run marker → **delete the leftover
  checkout and re-clone from the default branch** (`recreateFromBase`), so a
  re-triggered incomplete build starts again off current `main` and never
  inherits a stale feature branch. A same-run resume still preserves the
  checkout. Policy sets: `src/workflows/target-policy.ts`.

Sandbox workspace reaping (issue #106):

- The harness OWNS cleanup of the on-disk clones under
  `$STATE_DIR/sandboxes/<taskId>/` — the per-phase container teardown
  (`docker rm -f`) never removed them, so they leaked until the disk filled
  (prod hit 100%). Three cooperating mechanisms, all via
  `reapSandboxWorkspace` (`src/sandbox/reap.ts`, the single safe-remove
  authority: path-escape guard + live-container skip):
  - **Reap-on-completion** — an *ephemeral* run's workspace is removed the
    moment it finishes successfully (`reapOnSuccess` in
    `src/workflows/simple.ts`). Failures are kept for post-mortem; the
    reusable/recreate per-target classes (`PER_TARGET_REUSE_WORKFLOWS` /
    `PER_TARGET_RECREATE_WORKFLOWS`) are NOT reaped here — they're a warm
    cache (issue #107) bounded by the sweep.
  - **Reap-on-cancel** — the admin cancel route
    (`src/admin/routes.ts`) reaps the run's workspace after killing its
    containers.
  - **Backstop sweep** — an hourly in-harness direct cron
    (`src/cron/sandbox-sweep.ts`, registered in `src/index.ts`) removes
    non-live dirs older than `retentionHours` and, if more than `maxDirs`
    remain, evicts the oldest (LRU) — bounding the reusable per-PR cache.
    It uses an explicit hours-based age check (not `find -mtime`'s
    day-truncation) and never touches a dir whose container is live.
- Config: `cleanup.sandbox.{enabled,reapOnCompletion,sweepSchedule,retentionHours,maxDirs}`
  in `config/default.yaml` (defaults: enabled, hourly, 12h, 40 dirs).
- This replaces the out-of-band host cron. `scripts/cleanup-sandboxes.sh`
  is retired to a manual break-glass tool only — do not reinstall it as a
  host cron.

OpenTelemetry (optional):

- Disabled by default. Enable with `LASTLIGHT_OTEL_ENABLED=true`; standard `OTEL_EXPORTER_OTLP_*`, `OTEL_SERVICE_NAME`, and `OTEL_RESOURCE_ATTRIBUTES` env vars configure exporter endpoints/headers/resources. The OTLP/HTTP encoding defaults to **`http/protobuf`** (the OTLP spec default — many backends, e.g. Arize Phoenix, accept protobuf only and 415 on JSON) and is overridable via `OTEL_EXPORTER_OTLP_PROTOCOL` (or the per-signal `OTEL_EXPORTER_OTLP_{TRACES,METRICS}_PROTOCOL`) to `http/json`; `resolveOtlpProtocol` in `src/telemetry/index.ts` picks the transport package. (`grpc` isn't bundled — it warns and falls back to protobuf.)
- Last Light exports workflow/phase/agent/chat metadata by default. `LASTLIGHT_OTEL_INCLUDE_CONTENT=true` opts into sensitive prompt/message/tool-result content (truncated).
- **Span tree + OpenInference (issue #224).** A run exports a nested span tree — `lastlight.workflow.run` (CHAIN) → `lastlight.workflow.phase` (CHAIN) → `lastlight.agent.execute` (AGENT) → a span per model turn (LLM) → a span per tool call (TOOL) — carrying OpenInference attributes (`openinference.span.kind`, `llm.model_name`/`llm.system`, `llm.token_count.*`, `llm.cost.total`, `tool.name`, `tool.is_error`). So an OpenInference-aware backend (e.g. Arize Phoenix) renders a proper agent tree with per-turn tokens + cost instead of a flat two-span shape. The OpenInference keys are set via `setSpanAttributes` (a direct `span.setAttribute` path) to bypass the `safeSpanAttributes` content scrubber, which would otherwise strip `token`/`prompt`/`content` keys; content values (`input.value`/`output.value`/tool args+results) stay gated behind `LASTLIGHT_OTEL_INCLUDE_CONTENT`. Constants live in `src/telemetry/openinference.ts`; the turn/tool tree is built by `AgentSpanTree` (`src/telemetry/pi-events.ts`) from the same pi event stream that still emits the flat `pi.*` span events as a fallback.
- `LASTLIGHT_OTEL_METRICS_ENABLED=false` (default true; overlay `otel.metrics: false`) disables the OTLP **metrics** signal while keeping traces — for a traces-only backend that rejects metrics (Arize Phoenix 404s the metrics endpoint). The metric reader is then never started (`initTelemetry`), so `meter()` hands back a no-op and `recordExecutionMetrics`/… silently do nothing.
- **Feedback signals on the trace (issue #255).** A 👍/👎 somebody leaves on the bot's output exports one more span, `lastlight.feedback.signal` (OpenInference `EVALUATOR`), carrying `feedback.{source,emoji,score,sentiment,anchor.kind,anchor.url}` plus `langfuse.score.user_feedback`. It is **parented on the original run's span**, rebuilt from `workflow_runs.trace_id`/`span_id` as a remote context (`src/telemetry/feedback.ts`) — because the reaction arrives long after that span closed, and starting a fresh span would produce a second, disconnected trace nobody can relate to the work. No recorded trace (telemetry was off during the run) → it exports as its own root span. Caveat: Langfuse does not yet map `langfuse.score.*` on OTLP ingest, so today those attributes ride along on a correctly-placed span rather than becoming a Score; Phoenix reads the `EVALUATOR` kind now. Metrics: `lastlight.feedback.signals` + `lastlight.feedback.score`.
- `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX=true` (default) enables sandbox telemetry. On the **docker** backend, sandboxes export OTLP to an in-network `otel-collector` compose service (static IP `172.30.0.30` on `sandbox-egress`, dual-homed onto `proxy-egress`), which re-exports to the real backend; the sandbox is given only that internal endpoint (`http://172.30.0.30:4318`), never the backend endpoint or `OTEL_EXPORTER_OTLP_HEADERS`. The collector config is generated from the harness OTEL_* env by `writeOtelCollectorConfig` (`src/sandbox/egress-firewall-config.ts`). This is why custom-port/plaintext collectors no longer need firewall changes — the backend hop runs on the collector's trusted outbound leg, not through `ssl_preread`. On **gondolin**/**none** (agentic-pi runs in-process), `OTEL_*` env is forwarded directly and `LASTLIGHT_OTEL_COLLECTOR_HOSTS` (+ parsed endpoint hosts) feed gondolin's egress allowlist.

Web search (optional, opt-in per workflow phase):

- `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` / `EXA_API_KEY` — set any one
  to enable agentic-pi's `web_search` and `web_fetch` tools for phases
  that declare `web_search: true` in their YAML. Provider auto-detected
  from whichever key is present (Tavily > Exa > Brave). Phases without
  the field pass an explicit `webSearch: false` to agentic-pi so they
  ignore these keys — important, since agentic-pi otherwise auto-enables
  whenever any of the three env vars is present in `process.env`.
- Currently only the `explore` workflow's research phases (`read_context`,
  `socratic`, `synthesize`) opt in. Those phases also set
  `unrestricted_egress: true` so provider API calls and any `web_fetch`
  to third-party docs sites flow through the open-mode firewall
  (coredns-open + nginx-egress-open). The `publish` phase declares
  neither — it stays on the strict allowlist for the only repo-write
  moment of the workflow.

Admin dashboard:

- `ADMIN_PASSWORD` — enables password login. Auth is required when a password
  **or** a working OAuth provider (Slack / GitHub) is configured; the dashboard
  is only fully open when *no* login method is set. Clearing the password while
  OAuth is configured keeps auth on (OAuth-only).
- `ADMIN_SECRET` — HMAC secret for session tokens
- **GitHub App org permission `Members: read`** (setup step, issue #169) —
  required for **per-repo dashboard visibility**: with it (plus the `team` /
  `membership` / `organization` webhook subscriptions and
  `teamVisibility.enabled: true` in the overlay), a GitHub-authenticated admin
  can narrow to the managed repos their org teams own **plus the ones their own
  account owns**, across workflow runs, sessions and the home-page panels.
  (Ownership is unioned in because teams are an org concept — a personal repo
  could never be team-granted, so a purely team-derived answer hid every one of
  them. The test is `owner === login`, never "the owner isn't an org", which
  would leak other people's personal repos into your filter.)
  **Re-consent the App on each installation
  after adding it.** Without it the feature stays dormant, harmlessly: the
  resolver fails open and everyone keeps seeing everything, which is exactly
  today's behaviour. This is UI declutter — `/workflow-runs`, `/sessions` and
  `/stats` all keep returning global data; filtering is client-side. Nothing is
  crawled up front: a user's teams are resolved on their first dashboard request
  (`GET /admin/api/me/repos`) and cached in SQLite, so an org with thousands of
  repos costs a handful of GraphQL calls per logged-in person rather than a
  full-org walk. Budgets in `teamVisibility` bound one cache miss and every one
  of them fails open. See `spec/02-configuration.md` and `spec/10-state.md`.

Slack (optional):

- `SLACK_BOT_TOKEN` (xoxb-…) — enables the messaging connector + chat skill.
- `SLACK_MODE` — `webhook` (default/prod, reliable HTTP Events API) or
  `socket` (dev fallback, Socket Mode). Auto-detected when unset: `webhook`
  if `SLACK_SIGNING_SECRET` is present, else `socket`. So shipping the code
  without the secret leaves an existing Socket-Mode instance on `socket`.
- `SLACK_SIGNING_SECRET` — Events API request-signing secret. Required for
  `webhook` mode. Slack POSTs events to `/webhooks/slack` on the shared HTTP
  server (the same Hono app as the GitHub webhook); webhook delivery is
  at-least-once (Slack retries), unlike Socket Mode which can drop messages.
- `SLACK_APP_TOKEN` (xapp-…) — app-level token; required only for `socket` mode.
- `SLACK_DELIVERY_CHANNEL` — **last-resort** channel for the weekly repo digest.
  Consulted only after the repo's own `notifications.slack.channel`
  (`.lastlight/lastlight.yml`) and the operator's `slack.repoChannels` map
  (overlay `config.yaml`). If none of the three resolves, that repo gets no
  digest — which is what keeps a fresh install quiet. Resolution lives in
  `src/notify/repo-channel.ts`.
- `SLACK_ALLOWED_USERS` — comma-separated user ids allowlist
- `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`,
  `SLACK_OAUTH_REDIRECT_URI` — enables "Login with Slack" on the dashboard
  (OIDC via arctic, uses `openid.connect.userInfo`; requests the `email` scope
  so a Slack login matches a `users` row by email — issue #205)
- `SLACK_ALLOWED_WORKSPACE` — restrict OAuth login to one team_id / domain
- **Slack bot scope `reactions:read`** (setup step, issue #255) — required for **feedback signals**: with it (plus the `reaction_added` / `reaction_removed` event subscriptions, both in `deploy/slack/slack-manifest.json`) a 👍/👎 on a message the bot posted is scored against the workflow run that produced it. Without it Slack never delivers the event and the feature is dormant — silently, and harmlessly. **Re-consent the Slack app after adding it.**
- **Slack bot scope `users:read.email`** (setup step, issue #205) — required
  for **Slack → user matching**: with it, `web.users.info` returns the user's
  `profile.email` so a Slack-initiated run/approval attributes to the same
  person as their GitHub login (matched by email, `slack_user_id` linked lazily).
  Without it the address is omitted and matching silently degrades to the Slack
  username fallback — never blocking the run. Re-consent the Slack app after
  adding the scope.
- `CHAT_BATCH_DEBOUNCE_MS` — settle window (ms, default 700; 0 disables) the
  `MessageBatcher` waits to coalesce a bursty thread before routing, so a rapid
  multi-message burst is classified once and answered as one ordered turn
  (`src/engine/chat/message-batcher.ts`, gated at `registry.onEvent`).

## Deployment

> **When changing Docker configs (`Dockerfile`, `docker-compose.yml`,
> `deploy/entrypoint.sh`, egress/collector generation), verify against the
> actual runtime — not assumptions.** Notably: the entrypoint runs as root but
> `exec gosu lastlight`s the harness, so the Node process (and shared-volume
> files it writes) is owned by `lastlight` (UID-pinned to 10001), not root.
> Confirm UID/ownership/perms and service start by running the real images
> (e.g. a throwaway container reproducing the entrypoint chain), since unit
> tests pass green while the container reality differs.

Production runs on a single host (the production server — connection details
are kept out of this file; see local agent memory) as a **Docker Compose**
stack — *not* the native systemd model described in `deploy/native/README.md`
(that `lastlight.service` is `inactive`; the README is aspirational). The repo
is checked out at **`/home/lastlight/lastlight`** and the private deployment
overlay (`cliftonc/lastlight-instance`) is cloned into
`/home/lastlight/lastlight/instance/` (mounted read-only at `/app/instance`,
holds `config.yaml` + asset overrides + `secrets/.env` + `secrets/*.pem`).

### Redeploy a code change

**The normal path is fully automated — no SSH, no `npm i -g`.** Bump the
overlay's `deploy.version` to the release tag and push; each overlay repo's
"Deploy overlay" Action runs on the host and deploys for you (see "So a normal
deploy is…" below). The Action's `ci-deploy.sh` **pins the host's global CLI**
to `deploy.version` (`npm install -g lastlight@<tag>`) *before* running the
deploy — because the CLI is versioned separately from the agent image and new
deploy behaviour (e.g. the GHCR image-pull path) lives in the CLI, so a stale
CLI silently uses the old path (builds locally, ignores a pin) — then runs
`lastlight server update`. CLI + images land together.

Deploys are driven by the **`lastlight` CLI**, run as the `lastlight` user (with
`LASTLIGHT_HOME=/home/lastlight/lastlight`, which is also `~lastlight/lastlight`,
so the default resolves). Only for a **hand-run** deploy (or a host without the
Action) do you update the CLI yourself first:

```bash
ssh <production-server>
# Hand-run only. The auto-deploy Action already does this step for you.
# Update the global CLI FIRST to match the version you're deploying:
npm i -g lastlight@<version>          # e.g. lastlight@0.12.0 (or @latest)
sudo -u lastlight -i lastlight server update
```

`lastlight server update` (`packages/cli/src/cli-server.ts`) is the single source of truth. It:

1. `git pull` the `instance/` overlay **first** as the `lastlight` user (its
   read-only deploy key, `git@github-instance:cliftonc/lastlight-instance.git`;
   clones it if missing) and symlinks `instance/docker-compose.override.yml`
   into the project root — so a freshly-bumped core-version pin is visible
   before the core is converged.
2. Converge the core checkout (`/home/lastlight/lastlight`). If the overlay
   declares a **core-version pin** (`deploy.version` in `config.yaml`, or the
   `LASTLIGHT_CORE_VERSION` env override) it `git fetch origin --tags` +
   `git checkout <tag>` (detached HEAD); otherwise it `git checkout main` +
   `git pull --ff-only origin main`. The pin (`readCorePin`,
   `src/config/core-pin.ts`) is how the overlay repo drives *which core version*
   an instance runs: bump `deploy.version`, commit, and a CI/CD job (or a human)
   running `lastlight server update` converges the host to it. `server setup`
   applies the same pin before its first build. Unset (or the sentinels
   `main`/`latest`) = track `main`.
3. **Fetches the images.** By default it *pulls* the prebuilt images from GHCR
   rather than building them on the host — a release publishes
   `ghcr.io/nearform/lastlight-{agent,sandbox-base,sandbox,sandbox-qa}` via the
   `images` job of `.github/workflows/publish.yml` (on GitHub Release +
   `workflow_dispatch`, amd64, public). (The release also publishes a fifth
   image, `lastlight-agent-qemu` — `agent` + QEMU for the `gondolin` backend
   on a bare-metal/VM host — which the compose stack doesn't use, so it isn't
   pulled here. `deploy/k8s/` is a separate deploy example, unrelated to that
   image: it's the **kubernetes sandbox backend** (`sandbox.backend:
   kubernetes`, see above), which runs the plain `agent`/`sandbox` images as
   ordinary Pods — no QEMU/KVM, no privileged containers, no device plugin.)
   `server update` pulls the tag `resolveImageTag` returns — the
   overlay's `deploy.version` pin (e.g. `v0.11.0`) when set, else `:latest` — and
   re-tags each to its **local** name (`lastlight-agent`,
   `lastlight-sandbox:latest`, …), which is what `docker-compose.yml` and the
   harness (fixed names in `src/sandbox/images.ts`) reference. sandbox-qa is
   non-fatal; a missing required image errors with a pointer to `--local`. This
   moves the slow build OFF the deploy host — a pull is seconds. The stock
   sidecar images (coredns/nginx/otel-collector/caddy) are pulled from Docker
   Hub by compose and aren't published by us; `egress-init` reuses the agent
   image. **`--local`** reverts to building from source in dependency waves (both
   `sandbox` and `sandbox-qa` are `FROM` the shared `lastlight-sandbox-base`, and
   `docker compose build` builds one invocation's services in parallel, so the
   base must be built first): `docker compose build agent sandbox-base
   --build-arg GIT_SHA=<HEAD>`, then `docker compose build sandbox`, then a
   non-fatal `docker compose build sandbox-qa`. The CI publish workflow builds in
   the same order and passes `GIT_SHA=<release SHA>` so a pulled image's stamped
   version (`GET /admin/api/server/info` + the dashboard drift banner) is
   correct. The sandbox images **vendor** agentic-pi from the workspace (a
   `pnpm deploy` bundle built in a builder stage inside `sandbox*.Dockerfile`,
   lockfile-pinned — no npm round-trip), COPY'd in above the base's toolchain;
   the COPY layer is content-addressed on the bundle, so an unchanged agentic-pi
   doesn't rebuild the tail and sandbox-qa's ~300 MB Chromium stays cached.
4. `docker compose up -d --remove-orphans` (recreates only what changed).
5. Force-restarts the egress sidecars (`coredns-strict`, `coredns-open`,
   `nginx-egress-strict`, `nginx-egress-open`, `otel-collector`) so they
   re-read any regenerated nginx/coredns/collector configs.
6. Health-checks `http://127.0.0.1:8644/health`, with live progress throughout.
7. **Prunes superseded images.** Each pulled version leaves the previous
   `ghcr.io/nearform/lastlight-*:vX.Y.Z` tags on disk (four repos × ~3 GB), so
   without cleanup a host fills up (an early nearform outage: sandboxes failed
   to start at 95% disk). After a successful `up`, `server update` removes the
   old GHCR version tags beyond the newest `KEEP_IMAGE_VERSIONS` (2) per repo —
   plus the tag just deployed — then `docker image prune -f` for the images the
   repeated `:latest` re-pulls left dangling. All best-effort (a live image's
   tag only untags; docker refuses to delete an in-use image) so it never fails
   a converged deploy. `--no-prune` keeps every version; only runs when
   `--no-build` didn't skip the image step. Pure retention logic (`tagsToPrune`)
   is unit-tested in `packages/cli/tests/cli-server.test.ts`.

The CLI is the control plane — npm-versioned and **separate from the agent
image it builds**, so it survives the agent container recreating itself.
`server start|stop|restart|status` cover the rest of the lifecycle, and
`server status` (plus the dashboard's drift banner, `GET /server/info`) reports
when core/overlay are behind. **When a core-version pin is set**, the drift
check repoints from `main` to the pinned tag: `server status` shows
`pinned vX.Y.Z`, and the dashboard banner stops nagging about `main`-drift —
it only warns "redeploy needed" when the running image's SHA is behind the
pinned tag (pin bumped but not yet deployed), else shows a quiet "Pinned to
vX.Y.Z" label.

So a normal deploy is: **cut a release, then bump the overlay's `deploy.version`
to that tag and push** — each overlay repo's auto-deploy Action runs `lastlight
server update` on the host for you (no SSH, no manual CLI upgrade; see "Redeploy
a code change"). Code changes (anything under `src/`, `workflows/`, `skills/`,
`agent-context/`, `config/default.yaml`) reach prod through a **published
image**: `publish.yml`'s `images` job builds it, and `server update` *pulls* the
`deploy.version` tag. To deploy un-released `main` (or local edits) build on the
host with `server update --local` (or `server build`). Deployment-only config (the `instance/` overlay)
can instead be
edited + committed to the `lastlight-instance` repo and applied with just
`lastlight server restart agent` — no image rebuild. (Caveat: *removing* an
`.env` var needs a recreate, `lastlight server start agent`, not a restart —
env_file vars are injected at container creation.)

> The host repo must be owned by the `lastlight` user (`chown -R
> lastlight:lastlight /home/lastlight/lastlight`) so the as-`lastlight` git pull
> can write `.git/objects`. There is no longer a root-run `deploy.sh` to drift
> that ownership back.

### Operate / debug

```bash
ssh <production-server>
sudo -u lastlight -i bash         # become the lastlight user
lastlight server status            # compose state + core/overlay drift
lastlight server logs agent --follow   # live harness logs
lastlight server restart agent     # after a config.yaml or .env add/edit
lastlight server start agent       # after REMOVING an .env var (recreate)
```

### Cutting a release

See **[`docs/RELEASING.md`](../../docs/RELEASING.md)** — the canonical runbook
(when to release, graph-aware version bumps, publish order, the automated
`publish.yml` pipeline, and rolling out to prod).

## Sub-folder docs

- `src/workflows/CLAUDE.md` — runner internals: phase types, linear vs DAG,
  loop iteration naming (`reviewer_fix_1`, `reviewer_recheck_1`), approval gates,
  resume semantics, taskId scoping, template rendering.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues in `nearform/lastlight` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
