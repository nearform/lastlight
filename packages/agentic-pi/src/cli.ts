#!/usr/bin/env node
/**
 * agentic-pi CLI entry point.
 *
 * Drives the Pi SDK in one-shot mode: reads a prompt from stdin, runs a single
 * turn against the configured model, streams Pi-native JSONL events to stdout,
 * and exits cleanly on `agent_end`.
 */

import { readStdin } from "./stdin.js";
import { parseArgs, printHelp, type RunConfig } from "./args.js";
import { runOnce } from "./runner.js";
import { StdoutSink } from "./emitter.js";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return 0;
  }

  const command = argv[0];
  if (command !== "run") {
    process.stderr.write(`agentic-pi: unknown command '${command}'\n`);
    printHelp();
    return 2;
  }

  let config: RunConfig;
  try {
    config = parseArgs(argv.slice(1));
  } catch (err) {
    process.stderr.write(`agentic-pi: ${(err as Error).message}\n`);
    return 2;
  }

  const prompt = await readStdin();
  if (!prompt.trim()) {
    process.stderr.write("agentic-pi: empty prompt on stdin\n");
    return 2;
  }

  const sink = new StdoutSink();
  const code = await runOnce(config, prompt, {
    sink,
    onWarn: (msg: string) => process.stderr.write(`agentic-pi: ${msg}\n`),
  });
  // process.exit() below drops anything still queued on a piped stdout, and
  // the run's last records (agent_end, usage_snapshot) are written after the
  // agent loop's own backpressure stops applying. drain() would not do here:
  // it only waits above the high-water mark, so smaller writes could be lost.
  await sink.flush();
  return code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`agentic-pi: fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
