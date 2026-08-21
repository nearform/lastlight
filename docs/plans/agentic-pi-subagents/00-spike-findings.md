# Spike findings — bash-spawned subagents

A zero-code spike run on 2026-08-21 to answer one question: **does parallel
fan-out actually pay?** No agentic-pi changes; the parent agent was simply told
it could spawn children with its `bash` tool.

## Method

Two arms, same task, same model (`anthropic/claude-haiku-4-5`, thinking off),
same cwd (this repo). Task: analyse `packages/shared`, `packages/workflow-engine`
and `packages/cli` — responsibility, public entry points, one invariant each —
and write a combined report.

- **baseline** — one agent, sequential, tools `read,grep,find,ls,write`.
- **fanout** — same plus `bash`, and a preamble describing how to spawn a child
  (`echo "<task>" | agentic-pi run --no-session --tools … > child.jsonl`), with
  instructions to background all three with `&` + `wait`, have each child write
  its answer to a file, then synthesise.

Harness in `/tmp/ap-spike/` (throwaway). Neither arm wrote into the repo.

## Numbers

| | wall | cost | tool calls | assistant turns |
| --- | --- | --- | --- | --- |
| baseline | 48.4s | $0.0559 | 14 | 8 |
| fanout (total) | 80.3s | $0.2054 | 52 | 35 |

Fan-out was **1.7x slower and 3.7x more expensive.**

Per-run token detail:

| run | input | cacheRead | cacheWrite | output | cost |
| --- | --- | --- | --- | --- | --- |
| parent-baseline | 3,883 | 93,151 | 22,199 | 2,998 | $0.0559 |
| parent-fanout | 26 | 22,725 | 12,078 | 4,240 | $0.0386 |
| child-cli | 7,901 | 150,290 | 25,762 | 3,017 | $0.0702 |
| child-shared | 7,839 | 65,638 | 22,194 | 2,554 | $0.0549 |
| child-workflow-engine | 7,855 | 53,751 | 13,580 | 2,298 | $0.0417 |

## It works, mechanically

The children genuinely ran concurrently — all three started at `06:39:59` and
ran 27–36s. Nothing needed changing in agentic-pi, in Pi, or in the container.
The whole capability was reachable from a prompt.

## But the headline comparison flatters the baseline

The two arms did **not** do the same amount of work. Tool-call traces:

- **baseline** read each package's `CLAUDE.md`, its `package.json`, and (for two
  of three) `src/index.ts`. It largely paraphrased the docs.
- **child-shared** read nine actual source files (`providers.ts`,
  `repo-config-schema.ts`, `workflow-loader.ts`, `oauth.ts`, …).

So the fan-out arm bought materially deeper, better-grounded analysis — its
report is 78% longer and cites real source rather than docs. Each child had a
whole context window for one package instead of a third of one. The 3.7x is not
3.7x for the same output.

## The three real overheads

Timeline of the 79.3s fanout run:

```
06:39:52 → 06:39:59    7s   parent boot + decide + issue the bash call
06:39:59 → 06:40:35   36s   three children, concurrent (bounded by slowest)
06:40:35 → 06:41:11   36s   parent reads 3 answers, re-writes combined report
```

1. **Context re-establishment.** Every child opened with the same 3–4 calls:
   `ls <pkg>`, `read <pkg>`, `read package.json`, `read CLAUDE.md`. `child-cli`
   went further and re-read the *root* `CLAUDE.md` — rediscovering orientation
   the parent already had. It then wandered into `dist/*.d.ts` instead of `src/`,
   a mistake a child sharing the parent's context would not have made.

2. **The synthesis tail.** 36s and 4,240 output tokens for the parent to read
   13KB of child answers and re-emit them as one report. Pure overhead the
   baseline never paid — it wrote its report incrementally.

3. **Not process startup.** Node cold-start is 0.5–0.8s and first-event to
   first-tool-call is 1.2–1.4s. Process spawn is *cheap*. This is worth stating
   plainly because it removes one of the assumed arguments for in-process
   children.

## Read

The mechanism works and the parallelism is real. The economics are conditional:
fan-out pays when per-child work is large relative to the ~43s of fixed
dispatch + synthesis overhead. Here each child ran ~30s against ~43s of
overhead, so it lost. Three children of five minutes each would invert it.

Both overheads that lost this race are addressable in design, which is what
[01-design.md](01-design.md) targets:

- context re-establishment → a **forked-context** mode,
- the synthesis tail → a **structured return contract** so the parent routes
  child output instead of re-emitting it.
